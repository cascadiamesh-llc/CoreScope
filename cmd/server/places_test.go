package main

import (
	"strings"
	"testing"
)

func TestNearPlace(t *testing.T) {
	cases := []struct {
		name     string
		lat, lon float64
		want     string
	}{
		// Inside a neighbourhood boundary: that neighbourhood.
		{"Kremwerk (1809 Minor Ave)", 47.616889, -122.331108, "Denny Triangle, Seattle"},
		{"Swedish First Hill", 47.6088, -122.3236, "First Hill, Seattle"},
		{"Cal Anderson Park", 47.6170, -122.3195, "Capitol Hill, Seattle"},
		{"Pike Place Market", 47.6097, -122.3422, "Pike-Market, Seattle"},
		{"Pioneer Square", 47.6015, -122.3343, "Pioneer Square, Seattle"},
		{"Pioneer Courthouse Square", 45.5189, -122.6793, "Downtown, Portland"},
		{"Powell's Books", 45.5231, -122.6812, "Pearl District, Portland"},
		{"St. Johns Bridge east end", 45.5900, -122.7520, "St. Johns, Portland"},
		// Outside both cities: the closest town.
		{"d1-rptr", 47.770496, -122.163162, "Woodinville, WA"},
		{"no position", 0, 0, ""},
		{"New York", 40.7128, -74.0060, ""},
	}
	for _, c := range cases {
		if got := nearPlace(c.lat, c.lon); got != c.want {
			t.Errorf("%s: nearPlace = %q, want %q", c.name, got, c.want)
		}
	}
	// Out at sea off the coast: described by its distance from the closest town.
	if got := nearPlace(47.5, -125.0); !strings.Contains(got, " km from ") {
		t.Errorf("offshore: %q, want \"N km from …\"", got)
	}
}

func TestInRingHole(t *testing.T) {
	outer := []float64{0, 0, 0, 10, 10, 10, 10, 0}
	hole := []float64{4, 4, 4, 6, 6, 6, 6, 4}
	if !inRing(outer, 2, 2) || inRing(outer, 11, 2) {
		t.Error("outline test wrong")
	}
	if !inRing(hole, 5, 5) || inRing(hole, 2, 2) {
		t.Error("hole test wrong")
	}
}
