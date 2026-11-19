package main

import (
	"math"
	"strings"
	"testing"
)

func TestNameTokens(t *testing.T) {
	for in, want := range map[string]string{
		"UpperFremont🧌":      "upper fremont",
		"Rainier Vista East": "rainier vista east",
		"EV6_XIAO_4":         "ev6 xiao 4",
		"$10 Repeater Test🤑": "10 repeater test",
		"SODO 🏭":             "sodo",
		"Pike-Market":        "pike market",
	} {
		if got := strings.Join(nameTokens(in), " "); got != want {
			t.Errorf("%q: %q, want %q", in, got, want)
		}
	}
}

// A repeater with no position is put where its name says, nudged by a
// compass word; names that name no place are left alone.
func TestGuessPlace(t *testing.T) {
	seaLat, seaLon := 47.60, -122.32
	near := func(lat, lon, wantLat, wantLon, km float64) bool {
		return haversineKm(lat, lon, wantLat, wantLon) <= km
	}
	lat, lon, label, ok := guessPlace("Rainier Vista East", seaLat, seaLon)
	if !ok || label != "Rainier Vista, Seattle" || !near(lat, lon, 47.5688, -122.2920, 1) || lon <= -122.2920 {
		t.Errorf("Rainier Vista East: %v %v %q %v (east of Rainier Vista, not Rainier, WA)", lat, lon, label, ok)
	}
	if lat, lon, label, ok := guessPlace("UpperFremont🧌", seaLat, seaLon); !ok || label != "Upper Fremont, Seattle" || !near(lat, lon, 47.656, -122.348, 1) {
		t.Errorf("UpperFremont: %v %v %q %v", lat, lon, label, ok)
	}
	if _, _, label, ok := guessPlace("Ballard Rooftop", seaLat, seaLon); !ok || label != "Ballard, Seattle" {
		t.Errorf("Ballard Rooftop: %q %v", label, ok)
	}
	if _, _, label, ok := guessPlace("Burien Water Tower", seaLat, seaLon); !ok || !strings.HasPrefix(label, "Burien") {
		t.Errorf("Burien: %q %v (a town near the network)", label, ok)
	}
	for _, n := range []string{"Kenny Carpeater", "EV6_XIAO_4", "$10 Repeater Test🤑", "Solar Node", ""} {
		if _, _, label, ok := guessPlace(n, seaLat, seaLon); ok {
			t.Errorf("%q placed at %q", n, label)
		}
	}
	// no network to be near: no towns, so a town's name alone places nothing
	if _, _, label, ok := guessPlace("Burien Water Tower", math.NaN(), math.NaN()); ok {
		t.Errorf("Burien without a network: %q", label)
	}
}
