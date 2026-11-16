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
		{"d1-rptr", 47.770496, -122.163162, "Woodinville, WA"},
		{"First Hill", 47.6088, -122.3236, "First Hill, Seattle"},
		{"Kremwerk (1809 Minor Ave)", 47.616889, -122.331108, "Denny Triangle, Seattle"},
		{"Rainier View", 47.5035, -122.2655, "Rainier View, Seattle"},
		{"Portland", 45.5152, -122.6784, "Portland, OR"},
		{"no position", 0, 0, ""},
		{"New York", 40.7128, -74.0060, ""},
	}
	for _, c := range cases {
		if got := nearPlace(c.lat, c.lon); got != c.want {
			t.Errorf("%s: nearPlace = %q, want %q", c.name, got, c.want)
		}
	}
	// Out at sea off the coast: described by its distance from the closest.
	if got := nearPlace(47.5, -125.0); !strings.Contains(got, " km from ") {
		t.Errorf("offshore: %q, want \"N km from …\"", got)
	}
}
