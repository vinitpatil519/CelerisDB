package celeris

import "testing"

func TestMergeAggregates(t *testing.T) {
	total := map[string]any{
		"count": 2.0,
		"sum":   map[string]any{"n": 5.0, "x": nil},
		"min":   map[string]any{"n": 3.0, "s": "b"},
		"max":   map[string]any{"n": 4.0},
	}
	MergeAggregates(total, map[string]any{
		"count": 3.0,
		"sum":   map[string]any{"n": 1.5, "x": 2.0},
		"min":   map[string]any{"n": 1.0, "s": "a"},
		"max":   map[string]any{"n": "z"},
	})
	if total["count"] != 5.0 {
		t.Fatalf("count: %v", total["count"])
	}
	sum := total["sum"].(map[string]any)
	min := total["min"].(map[string]any)
	max := total["max"].(map[string]any)
	if sum["n"] != 6.5 || sum["x"] != 2.0 || min["n"] != 1.0 || min["s"] != "a" || max["n"] != "z" {
		t.Fatalf("merged: %v", total)
	}
}
