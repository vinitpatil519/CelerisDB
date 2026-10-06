package celeris

// Integration tests against a running node: set CELERIS_URL, e.g.
//
//	CELERIS_URL=http://127.0.0.1:8080 go test ./...
//
// For a cluster, list every node: CELERIS_URL=http://a:8080,http://b:8080
//
// Without it, only the offline tests run.

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"
)

func node(t *testing.T) *Client {
	t.Helper()
	urls := os.Getenv("CELERIS_URL")
	if urls == "" {
		t.Skip("CELERIS_URL not set")
	}
	c, err := New(Options{Nodes: strings.Split(urls, ",")})
	if err != nil {
		t.Fatal(err)
	}
	return c
}

// unique keeps runs against a shared node independent.
func unique(t *testing.T) string {
	return fmt.Sprintf("go-test/%s/%d/", t.Name(), time.Now().UnixNano())
}

func TestEncodeKey(t *testing.T) {
	got, err := EncodeKey("a b/ü?")
	if err != nil || got != "a%20b/%C3%BC%3F" {
		t.Fatalf("got %q, %v", got, err)
	}
	if _, err := EncodeKey("a/../b"); !errors.Is(err, ErrInvalidKey) {
		t.Fatalf("dot segments must be refused, got %v", err)
	}
}

func TestUnreachableWriteIsNotApplied(t *testing.T) {
	c, _ := New(Options{Nodes: []string{"http://127.0.0.1:1"}, Attempts: 2, Timeout: 2 * time.Second})
	_, err := c.Put(context.Background(), "x", 1, nil)
	var unknown *OutcomeUnknownError
	if errors.As(err, &unknown) || !errors.Is(err, ErrUnreachable) {
		t.Fatalf("a write that never connected is not applied, got %v", err)
	}
}

func TestKeyValue(t *testing.T) {
	c, ctx, p := node(t), context.Background(), unique(t)

	written, err := c.Put(ctx, p+"user", map[string]any{"name": "Ada"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if written.Version == nil || !written.Replicated || written.Deduplicated {
		t.Fatalf("unexpected write result %+v", written)
	}
	item, err := c.Get(ctx, p+"user", nil)
	if err != nil || item == nil {
		t.Fatalf("get: %v %v", item, err)
	}
	var user struct{ Name string }
	if err := item.Decode(&user); err != nil || user.Name != "Ada" {
		t.Fatalf("decode: %+v %v", user, err)
	}
	if item.Version != *written.Version || item.Consistency != "strict" {
		t.Fatalf("item %+v", item)
	}
	if _, err := c.Delete(ctx, p+"user", nil); err != nil {
		t.Fatal(err)
	}
	if item, err := c.Get(ctx, p+"user", nil); err != nil || item != nil {
		t.Fatalf("deleted key: %v %v", item, err)
	}

	odd := p + "hello world/ünï?#%"
	if _, err := c.Put(ctx, odd, 1, nil); err != nil {
		t.Fatal(err)
	}
	if item, err := c.Get(ctx, odd, nil); err != nil || item == nil || string(item.Value) != "1" {
		t.Fatalf("odd key: %v %v", item, err)
	}
}

func TestConditionsAndIdempotence(t *testing.T) {
	c, ctx, p := node(t), context.Background(), unique(t)
	first, err := c.Put(ctx, p+"cas", "a", &PutOptions{IfAbsent: true})
	if err != nil {
		t.Fatal(err)
	}
	_, err = c.Put(ctx, p+"cas", "b", &PutOptions{IfAbsent: true})
	var apiErr *Error
	if !errors.As(err, &apiErr) || apiErr.Status != 409 || apiErr.Code != "condition_failed" {
		t.Fatalf("expected condition_failed, got %v", err)
	}
	second, err := c.Put(ctx, p+"cas", "b", &PutOptions{IfVersion: first.Version})
	if err != nil || *second.Version <= *first.Version {
		t.Fatalf("cas: %v %v", second, err)
	}
	if _, err := c.Delete(ctx, p+"cas", &DeleteOptions{IfVersion: first.Version}); !IsCode(err, "condition_failed") {
		t.Fatalf("stale delete: %v", err)
	}

	id := newUUID()
	a, err := c.Put(ctx, p+"idem", 1, &PutOptions{MutationID: id})
	if err != nil {
		t.Fatal(err)
	}
	b, err := c.Put(ctx, p+"idem", 1, &PutOptions{MutationID: id})
	if err != nil || !b.Deduplicated || *b.Version != *a.Version {
		t.Fatalf("retry: %+v %v", b, err)
	}
	committed, version, err := c.MutationStatus(ctx, id)
	if err != nil || !committed || *version != *a.Version {
		t.Fatalf("status: %v %v %v", committed, version, err)
	}
	if committed, _, err := c.MutationStatus(ctx, newUUID()); err != nil || committed {
		t.Fatalf("unknown mutation: %v %v", committed, err)
	}
}

func TestBatchIsAtomic(t *testing.T) {
	c, ctx, p := node(t), context.Background(), unique(t)
	if _, err := c.Put(ctx, p+"b", 5, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Batch(ctx, []BatchOp{Put(p+"a", 1), Delete(p + "b")}, nil); err != nil {
		t.Fatal(err)
	}
	if item, _ := c.Get(ctx, p+"b", nil); item != nil {
		t.Fatal("b should be deleted")
	}
	conditional := Put(p+"a", 2)
	conditional.IfAbsent = true
	if _, err := c.Batch(ctx, []BatchOp{Put(p+"c", 1), conditional}, nil); !IsCode(err, "condition_failed") {
		t.Fatalf("expected condition_failed, got %v", err)
	}
	if item, _ := c.Get(ctx, p+"c", nil); item != nil {
		t.Fatal("a failed batch must apply nothing")
	}
}

func TestScan(t *testing.T) {
	c, ctx, p := node(t), context.Background(), unique(t)
	for i := 0; i < 25; i++ {
		if _, err := c.Put(ctx, fmt.Sprintf("%s%02d", p, i), i, nil); err != nil {
			t.Fatal(err)
		}
	}
	page, err := c.ScanPage(ctx, &ScanOptions{Prefix: p, Limit: 10}, "")
	if err != nil || len(page.Items) != 10 || page.NextCursor != p+"09" {
		t.Fatalf("page: %+v %v", page, err)
	}
	var values []string
	err = c.Scan(ctx, &ScanOptions{Prefix: p, Limit: 7}, func(i Item) bool {
		values = append(values, string(i.Value))
		return true
	})
	if err != nil || len(values) != 25 || values[0] != "0" || values[24] != "24" {
		t.Fatalf("scan: %v %v", values, err)
	}
}

func TestQuery(t *testing.T) {
	c, ctx, p := node(t), context.Background(), unique(t)
	for i := 0; i < 12; i++ {
		tags := []string{}
		if i%3 == 0 {
			tags = append(tags, "fizz")
		}
		doc := map[string]any{"n": i, "tags": tags}
		if _, err := c.Put(ctx, fmt.Sprintf("%s%02d", p, i), doc, nil); err != nil {
			t.Fatal(err)
		}
	}
	page, err := c.QueryPage(ctx, &QueryOptions{
		ScanOptions: ScanOptions{Prefix: p},
		Where:       map[string]any{"tags": map[string]any{"$contains": "fizz"}, "n": map[string]any{"$gt": 0}},
		Fields:      []string{"n"},
	}, "")
	if err != nil || len(page.Items) != 3 || string(page.Items[0].Value) != `{"n":3}` || page.NextCursor != "" || page.Scanned != 12 {
		t.Fatalf("page: %+v %v", page, err)
	}
	var keys []string
	err = c.Query(ctx, &QueryOptions{
		ScanOptions: ScanOptions{Prefix: p},
		Where:       map[string]any{"n": map[string]any{"$lt": 5}},
		MaxScanned:  2,
	}, func(i Item) bool {
		keys = append(keys, i.Key)
		return true
	})
	if err != nil || len(keys) != 5 || keys[4] != p+"04" {
		t.Fatalf("query: %v %v", keys, err)
	}
	_, err = c.QueryPage(ctx, &QueryOptions{Where: map[string]any{"n": map[string]any{"$nope": 1}}}, "")
	if !IsCode(err, "invalid_filter") {
		t.Fatalf("bad filter: %v", err)
	}
}

func TestWatch(t *testing.T) {
	c, p := node(t), unique(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	w, err := c.Watch(ctx, p+"live/")
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()
	if w.Hello.Partial {
		t.Fatal("a single node covers everything")
	}
	if _, err := c.Put(ctx, p+"live/a", map[string]int{"v": 1}, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Put(ctx, p+"other", 1, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Delete(ctx, p+"live/a", nil); err != nil {
		t.Fatal(err)
	}
	put, err := w.Next(ctx)
	if err != nil || put.Change == nil || put.Change.Kind != "put" || string(put.Change.Value) != `{"v":1}` {
		t.Fatalf("put event: %+v %v", put.Change, err)
	}
	del, err := w.Next(ctx)
	if err != nil || del.Change == nil || del.Change.Kind != "delete" || del.Change.Key != p+"live/a" {
		t.Fatalf("delete event: %+v %v", del.Change, err)
	}

	short, cancelShort := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancelShort()
	if _, err := w.Next(short); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("idle watch must time out, got %v", err)
	}
}
