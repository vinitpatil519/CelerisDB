// Command harness runs YCSB core workloads against one database on localhost
// and appends one JSON line per cell. See bench/README.md and bench/run.sh.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"strconv"
	"strings"
	"time"
)

// document builds the value every system stores: one JSON document of exactly
// size bytes, because CelerisDB only accepts JSON values.
func document(size int) []byte {
	const wrap = `{"data":""}`
	return []byte(`{"data":"` + strings.Repeat("x", size-len(wrap)) + `"}`)
}

// cell is "workload:concurrency", for example "a:32".
func parseCell(s string) (Workload, int) {
	w, c, ok := strings.Cut(s, ":")
	n, err := strconv.Atoi(c)
	if !ok || err != nil {
		log.Fatalf("bad cell %q, want workload:concurrency", s)
	}
	return Workload(w), n
}

func main() {
	system := flag.String("system", "", "celeris, postgres, cockroachdb, redis, mongodb, etcd, mysql, cassandra")
	keys := flag.Uint64("keys", 100_000, "records preloaded before the measured cells")
	valueSize := flag.Int("value", 1024, "value size in bytes")
	cells := flag.String("cells", "a:32,b:32,c:32,load:32", "comma separated workload:concurrency, run in order")
	warmup := flag.Duration("warmup", 5*time.Second, "unmeasured time at the start of each cell")
	dur := flag.Duration("duration", 15*time.Second, "measured time of each cell")
	wait := flag.Duration("wait", 4*time.Minute, "how long to wait for the system to accept connections")
	rep := flag.Int("rep", 1, "repetition number, recorded in the output")
	out := flag.String("out", "", "JSON lines file to append to")
	flag.Parse()

	ctx := context.Background()
	var d Driver
	deadline := time.Now().Add(*wait)
	for {
		var err error
		dctx, cancel := context.WithTimeout(ctx, 60*time.Second)
		d, err = NewDriver(dctx, *system)
		cancel()
		if err == nil {
			break
		}
		if time.Now().After(deadline) {
			log.Fatalf("%s never became ready: %v", *system, err)
		}
		time.Sleep(2 * time.Second)
	}
	defer d.Close()

	value := document(*valueSize)
	t0 := time.Now()
	if err := Preload(ctx, d, *keys, value, 32); err != nil {
		log.Fatalf("%s: %v", *system, err)
	}
	preload := time.Since(t0).Seconds()
	log.Printf("%s: preloaded %d keys in %.1fs", *system, *keys, preload)

	f, err := os.OpenFile(*out, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		log.Fatal(err)
	}
	defer f.Close()

	for _, spec := range strings.Split(*cells, ",") {
		wl, conc := parseCell(spec)
		res := Run(ctx, d, wl, *keys, value, conc, *warmup, *dur)
		res.System = *system
		res.Tier = "single-node-durable"
		line, err := json.Marshal(struct {
			Result
			Rep            int     `json:"rep"`
			PreloadSeconds float64 `json:"preload_seconds"`
		}{res, *rep, preload})
		if err != nil {
			log.Fatal(err)
		}
		fmt.Fprintln(f, string(line))
		log.Printf("%s rep=%d %s c=%d: %.0f ops/s p50=%.0fus p99=%.0fus errors=%d %s",
			*system, *rep, wl, conc, res.OpsPerSec, res.P50, res.P99, res.Errors, res.Error)
	}
}
