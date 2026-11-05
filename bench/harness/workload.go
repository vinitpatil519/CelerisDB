package main

import (
	"context"
	"fmt"
	"math"
	"math/rand/v2"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/HdrHistogram/hdrhistogram-go"
)

// Workload is a YCSB core workload.
type Workload string

const (
	Load Workload = "load" // inserts of new keys only
	A    Workload = "a"    // 50% read, 50% update
	B    Workload = "b"    // 95% read, 5% update
	C    Workload = "c"    // 100% read
)

func (w Workload) readFraction() float64 {
	switch w {
	case A:
		return 0.5
	case B:
		return 0.95
	case C:
		return 1
	}
	return 0
}

// key formats a record key the way YCSB does, so every system stores the
// same bytes.
func key(i uint64) string { return "user" + strconv.FormatUint(i, 10) }

// Zipfian draws from [0, n) with YCSB's constant 0.99 (Gray et al., "Quickly
// generating billion-record synthetic databases"), then scrambles the result
// with FNV so the hot keys are spread over the keyspace instead of clustered
// at the low end, as YCSB's ScrambledZipfianGenerator does.
type Zipfian struct {
	n                        uint64
	theta, alpha, zetan, eta float64
	half                     float64
}

func NewZipfian(n uint64) *Zipfian {
	const theta = 0.99
	zeta := func(n uint64) float64 {
		var s float64
		for i := uint64(1); i <= n; i++ {
			s += 1 / math.Pow(float64(i), theta)
		}
		return s
	}
	zetan, zeta2 := zeta(n), zeta(2)
	return &Zipfian{
		n:     n,
		theta: theta,
		alpha: 1 / (1 - theta),
		zetan: zetan,
		eta:   (1 - math.Pow(2/float64(n), 1-theta)) / (1 - zeta2/zetan),
		half:  1 + math.Pow(0.5, theta),
	}
}

func (z *Zipfian) Next(r *rand.Rand) uint64 {
	u := r.Float64()
	uz := u * z.zetan
	var v uint64
	switch {
	case uz < 1:
		v = 0
	case uz < z.half:
		v = 1
	default:
		v = uint64(float64(z.n) * math.Pow(z.eta*u-z.eta+1, z.alpha))
	}
	return fnv64(v) % z.n
}

func fnv64(v uint64) uint64 {
	h := uint64(0xCBF29CE484222325)
	for i := 0; i < 8; i++ {
		h ^= v & 0xff
		h *= 0x100000001B3
		v >>= 8
	}
	return h
}

// Result is one benchmark cell, written as JSON.
type Result struct {
	System      string  `json:"system"`
	Tier        string  `json:"tier"`
	Workload    string  `json:"workload"`
	Concurrency int     `json:"concurrency"`
	ValueSize   int     `json:"value_size"`
	Keys        uint64  `json:"keys"`
	Seconds     float64 `json:"seconds"`
	Ops         int64   `json:"ops"`
	Errors      int64   `json:"errors"`
	OpsPerSec   float64 `json:"ops_per_sec"`
	// Latencies in microseconds, over all operations of the cell.
	P50   float64 `json:"p50_us"`
	P95   float64 `json:"p95_us"`
	P99   float64 `json:"p99_us"`
	P999  float64 `json:"p999_us"`
	Max   float64 `json:"max_us"`
	Mean  float64 `json:"mean_us"`
	Error string  `json:"first_error,omitempty"`
}

func newHist() *hdrhistogram.Histogram {
	// 1 µs to 60 s, 3 significant digits.
	return hdrhistogram.New(1, 60_000_000, 3)
}

// Preload writes keys [0, n) so read workloads find them. It is not timed.
func Preload(ctx context.Context, d Driver, n uint64, value []byte, conc int) error {
	var next atomic.Uint64
	var wg sync.WaitGroup
	errs := make(chan error, conc)
	for w := 0; w < conc; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				i := next.Add(1) - 1
				if i >= n || ctx.Err() != nil {
					return
				}
				if err := retry(ctx, func() error { return d.Put(ctx, key(i), value) }); err != nil {
					errs <- fmt.Errorf("preload %s: %w", key(i), err)
					return
				}
			}
		}()
	}
	wg.Wait()
	close(errs)
	return <-errs
}

func retry(ctx context.Context, f func() error) error {
	var err error
	for attempt := 0; attempt < 5; attempt++ {
		if err = f(); err == nil {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(time.Duration(attempt+1) * 200 * time.Millisecond):
		}
	}
	return err
}

// Run runs a closed-loop cell: conc workers, each issuing the next operation
// as soon as the previous one returns. Operations during warmup are not
// counted.
func Run(ctx context.Context, d Driver, wl Workload, keys uint64, value []byte, conc int, warmup, dur time.Duration) Result {
	zipf := NewZipfian(keys)
	readFrac := wl.readFraction()
	var insertSeq atomic.Uint64 // load: fresh keys above the preloaded range

	start := time.Now()
	measureFrom := start.Add(warmup)
	end := measureFrom.Add(dur)

	hists := make([]*hdrhistogram.Histogram, conc)
	var ops, errs atomic.Int64
	var firstErr atomic.Value
	var wg sync.WaitGroup
	for w := 0; w < conc; w++ {
		hists[w] = newHist()
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			r := rand.New(rand.NewPCG(uint64(w)+1, uint64(time.Now().UnixNano())))
			h := hists[w]
			for {
				t0 := time.Now()
				if !t0.Before(end) || ctx.Err() != nil {
					return
				}
				var err error
				switch {
				case wl == Load:
					err = d.Put(ctx, key(keys+insertSeq.Add(1)), value)
				case r.Float64() < readFrac:
					err = d.Get(ctx, key(zipf.Next(r)))
				default:
					err = d.Put(ctx, key(zipf.Next(r)), value)
				}
				t1 := time.Now()
				if t0.Before(measureFrom) {
					continue
				}
				if err != nil {
					errs.Add(1)
					firstErr.CompareAndSwap(nil, err.Error())
					continue
				}
				ops.Add(1)
				_ = h.RecordValue(t1.Sub(t0).Microseconds())
			}
		}(w)
	}
	wg.Wait()

	all := newHist()
	for _, h := range hists {
		all.Merge(h)
	}
	res := Result{
		Workload:    string(wl),
		Concurrency: conc,
		ValueSize:   len(value),
		Keys:        keys,
		Seconds:     dur.Seconds(),
		Ops:         ops.Load(),
		Errors:      errs.Load(),
		OpsPerSec:   float64(ops.Load()) / dur.Seconds(),
		P50:         float64(all.ValueAtQuantile(50)),
		P95:         float64(all.ValueAtQuantile(95)),
		P99:         float64(all.ValueAtQuantile(99)),
		P999:        float64(all.ValueAtQuantile(99.9)),
		Max:         float64(all.Max()),
		Mean:        all.Mean(),
	}
	if e, ok := firstErr.Load().(string); ok {
		res.Error = e
	}
	return res
}
