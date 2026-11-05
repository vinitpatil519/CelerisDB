package main

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"time"

	_ "github.com/go-sql-driver/mysql"
	"github.com/gocql/gocql"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
	clientv3 "go.etcd.io/etcd/client/v3"
	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"
	"go.mongodb.org/mongo-driver/mongo/readpref"
	"go.mongodb.org/mongo-driver/mongo/writeconcern"
)

// Driver is the smallest surface every system can implement: a durable upsert
// and a point read. Get must fail when the key is missing, so a system that
// silently loses preloaded data shows up as errors rather than as speed.
type Driver interface {
	Put(ctx context.Context, key string, value []byte) error
	Get(ctx context.Context, key string) error
	Close()
}

var errMissing = errors.New("key not found")

const poolSize = 256

// NewDriver connects to one system on localhost and prepares its schema.
func NewDriver(ctx context.Context, system string) (Driver, error) {
	switch system {
	case "celeris":
		return newCeleris(ctx)
	case "postgres":
		return newPostgres(ctx, "postgres://bench:bench@127.0.0.1:5432/bench")
	case "cockroachdb":
		return newCockroach(ctx)
	case "redis":
		return newRedis(ctx)
	case "mongodb":
		return newMongo(ctx)
	case "etcd":
		return newEtcd(ctx)
	case "mysql":
		return newMySQL(ctx)
	case "cassandra":
		return newCassandra(ctx)
	}
	return nil, fmt.Errorf("unknown system %q", system)
}

// ---- CelerisDB: HTTP/1.1 + JSON, the only client protocol it has -----------

type celeris struct {
	c    *http.Client
	base string
}

func newCeleris(ctx context.Context) (Driver, error) {
	tr := &http.Transport{
		MaxIdleConns:        poolSize,
		MaxIdleConnsPerHost: poolSize,
		DialContext:         (&net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
	}
	d := &celeris{c: &http.Client{Transport: tr, Timeout: 30 * time.Second}, base: "http://127.0.0.1:8080"}
	req, _ := http.NewRequestWithContext(ctx, "GET", d.base+"/ready", nil)
	res, err := d.c.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return nil, fmt.Errorf("not ready: %s", res.Status)
	}
	return d, nil
}

func (d *celeris) do(req *http.Request) error {
	res, err := d.c.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(res.Body)
	if res.StatusCode == 404 {
		return errMissing
	}
	if res.StatusCode >= 300 {
		return fmt.Errorf("%s: %.200s", res.Status, body)
	}
	return nil
}

func (d *celeris) Put(ctx context.Context, key string, value []byte) error {
	req, err := http.NewRequestWithContext(ctx, "PUT", d.base+"/v1/kv/"+key, bytes.NewReader(value))
	if err != nil {
		return err
	}
	req.Header.Set("content-type", "application/json")
	return d.do(req)
}

func (d *celeris) Get(ctx context.Context, key string) error {
	req, err := http.NewRequestWithContext(ctx, "GET", d.base+"/v1/kv/"+key, nil)
	if err != nil {
		return err
	}
	return d.do(req)
}

func (d *celeris) Close() {}

// ---- PostgreSQL / CockroachDB: pgx, prepared statements --------------------

type pg struct {
	pool *pgxpool.Pool
	put  string
}

func newPostgres(ctx context.Context, url string) (Driver, error) {
	return connectPG(ctx, url, "INSERT INTO kv (k, v) VALUES ($1, $2) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v")
}

func newCockroach(ctx context.Context) (Driver, error) {
	// UPSERT is CockroachDB's fast path for blind writes.
	return connectPG(ctx, "postgres://root@127.0.0.1:26257/defaultdb?sslmode=disable", "UPSERT INTO kv (k, v) VALUES ($1, $2)")
}

func connectPG(ctx context.Context, url, put string) (Driver, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, err
	}
	cfg.MaxConns = poolSize
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, err
	}
	if _, err := pool.Exec(ctx, "CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)"); err != nil {
		pool.Close()
		return nil, err
	}
	return &pg{pool: pool, put: put}, nil
}

func (d *pg) Put(ctx context.Context, key string, value []byte) error {
	_, err := d.pool.Exec(ctx, d.put, key, string(value))
	return err
}

func (d *pg) Get(ctx context.Context, key string) error {
	var v string
	err := d.pool.QueryRow(ctx, "SELECT v FROM kv WHERE k = $1", key).Scan(&v)
	if errors.Is(err, pgx.ErrNoRows) {
		return errMissing
	}
	return err
}

func (d *pg) Close() { d.pool.Close() }

// ---- Redis ------------------------------------------------------------------

type redisDriver struct{ c *redis.Client }

func newRedis(ctx context.Context) (Driver, error) {
	c := redis.NewClient(&redis.Options{Addr: "127.0.0.1:6379", PoolSize: poolSize})
	if err := c.Ping(ctx).Err(); err != nil {
		c.Close()
		return nil, err
	}
	return &redisDriver{c}, nil
}

func (d *redisDriver) Put(ctx context.Context, key string, value []byte) error {
	return d.c.Set(ctx, key, value, 0).Err()
}

func (d *redisDriver) Get(ctx context.Context, key string) error {
	_, err := d.c.Get(ctx, key).Bytes()
	if errors.Is(err, redis.Nil) {
		return errMissing
	}
	return err
}

func (d *redisDriver) Close() { d.c.Close() }

// ---- MongoDB: w:1, j:true so a write waits for the journal ------------------

type mongoDriver struct {
	c    *mongo.Client
	coll *mongo.Collection
}

func newMongo(ctx context.Context) (Driver, error) {
	opts := options.Client().ApplyURI("mongodb://127.0.0.1:27017/?directConnection=true").
		SetMaxPoolSize(poolSize).
		SetWriteConcern(writeconcern.Journaled())
	c, err := mongo.Connect(ctx, opts)
	if err != nil {
		return nil, err
	}
	if err := c.Ping(ctx, readpref.Primary()); err != nil {
		c.Disconnect(ctx)
		return nil, err
	}
	return &mongoDriver{c, c.Database("bench").Collection("kv")}, nil
}

func (d *mongoDriver) Put(ctx context.Context, key string, value []byte) error {
	_, err := d.coll.UpdateByID(ctx, key, bson.M{"$set": bson.M{"v": string(value)}}, options.Update().SetUpsert(true))
	return err
}

func (d *mongoDriver) Get(ctx context.Context, key string) error {
	var out bson.Raw
	err := d.coll.FindOne(ctx, bson.M{"_id": key}).Decode(&out)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return errMissing
	}
	return err
}

func (d *mongoDriver) Close() { d.c.Disconnect(context.Background()) }

// ---- etcd: default linearizable reads ---------------------------------------

type etcdDriver struct{ c *clientv3.Client }

func newEtcd(ctx context.Context) (Driver, error) {
	c, err := clientv3.New(clientv3.Config{Endpoints: []string{"127.0.0.1:2379"}, DialTimeout: 5 * time.Second})
	if err != nil {
		return nil, err
	}
	if _, err := c.Status(ctx, "127.0.0.1:2379"); err != nil {
		c.Close()
		return nil, err
	}
	return &etcdDriver{c}, nil
}

func (d *etcdDriver) Put(ctx context.Context, key string, value []byte) error {
	_, err := d.c.Put(ctx, key, string(value))
	return err
}

func (d *etcdDriver) Get(ctx context.Context, key string) error {
	res, err := d.c.Get(ctx, key)
	if err != nil {
		return err
	}
	if len(res.Kvs) == 0 {
		return errMissing
	}
	return nil
}

func (d *etcdDriver) Close() { d.c.Close() }

// ---- MySQL / InnoDB ---------------------------------------------------------

type mysqlDriver struct {
	db       *sql.DB
	put, get *sql.Stmt
}

func newMySQL(ctx context.Context) (Driver, error) {
	db, err := sql.Open("mysql", "root:bench@tcp(127.0.0.1:3306)/bench")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(poolSize)
	db.SetMaxIdleConns(poolSize)
	if _, err := db.ExecContext(ctx, "CREATE TABLE IF NOT EXISTS kv (k VARCHAR(64) PRIMARY KEY, v TEXT NOT NULL)"); err != nil {
		db.Close()
		return nil, err
	}
	put, err := db.PrepareContext(ctx, "INSERT INTO kv (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)")
	if err != nil {
		db.Close()
		return nil, err
	}
	get, err := db.PrepareContext(ctx, "SELECT v FROM kv WHERE k = ?")
	if err != nil {
		db.Close()
		return nil, err
	}
	return &mysqlDriver{db, put, get}, nil
}

func (d *mysqlDriver) Put(ctx context.Context, key string, value []byte) error {
	_, err := d.put.ExecContext(ctx, key, string(value))
	return err
}

func (d *mysqlDriver) Get(ctx context.Context, key string) error {
	var v string
	err := d.get.QueryRowContext(ctx, key).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return errMissing
	}
	return err
}

func (d *mysqlDriver) Close() { d.db.Close() }

// ---- Cassandra: RF 1, consistency ONE, commitlog_sync: batch ----------------

type cassandra struct{ s *gocql.Session }

func newCassandra(ctx context.Context) (Driver, error) {
	boot := gocql.NewCluster("127.0.0.1")
	boot.Timeout = 30 * time.Second
	boot.ConnectTimeout = 10 * time.Second
	s, err := boot.CreateSession()
	if err != nil {
		return nil, err
	}
	err = s.Query(`CREATE KEYSPACE IF NOT EXISTS bench WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1}`).Exec()
	if err == nil {
		err = s.Query(`CREATE TABLE IF NOT EXISTS bench.kv (k text PRIMARY KEY, v text)`).Exec()
	}
	s.Close()
	if err != nil {
		return nil, err
	}
	c := gocql.NewCluster("127.0.0.1")
	c.Keyspace = "bench"
	c.Consistency = gocql.One
	c.NumConns = 8
	c.Timeout = 30 * time.Second
	c.ConnectTimeout = 10 * time.Second
	s, err = c.CreateSession()
	if err != nil {
		return nil, err
	}
	return &cassandra{s}, nil
}

func (d *cassandra) Put(ctx context.Context, key string, value []byte) error {
	return d.s.Query(`INSERT INTO kv (k, v) VALUES (?, ?)`, key, string(value)).WithContext(ctx).Exec()
}

func (d *cassandra) Get(ctx context.Context, key string) error {
	var v string
	err := d.s.Query(`SELECT v FROM kv WHERE k = ?`, key).WithContext(ctx).Scan(&v)
	if errors.Is(err, gocql.ErrNotFound) {
		return errMissing
	}
	return err
}

func (d *cassandra) Close() { d.s.Close() }
