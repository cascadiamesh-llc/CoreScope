package main

import (
	"testing"
	"time"
)

// A hop is named from MediaMesh repeaters only: a main-mesh repeater that
// shares the hash (Delridge, West Linn…) is never the answer.
func TestMediaMeshHopNamerOnlyMediaMesh(t *testing.T) {
	withMediaMesh(t)
	now := time.Date(2026, 11, 26, 12, 0, 0, 0, time.UTC)
	seen := now.Add(-time.Hour).Format(time.RFC3339)
	mediaMeshNodes.Store(&map[string]MediaMeshNode{
		"a1ff00": {Mode: "rxtx", Source: "status", LastSeen: seen},
		"b2aa00": {Mode: "rxtx", Source: "status", LastSeen: seen},
		"b2bb00": {Mode: "rxtx", Source: "heard", LastSeen: seen},
		"c3cc00": {Mode: "off", Source: "status", LastSeen: seen},
		"d4dd00": {Mode: "rxtx", Source: "relayed", LastSeen: now.Add(-3 * 24 * time.Hour).Format(time.RFC3339)},
	})
	names := map[string]nodeInfo{
		"a1ff00": {PublicKey: "a1ff00", Name: "First Hill"},
		"a1ee00": {PublicKey: "a1ee00", Name: "West Linn", Lat: 45.3, Lon: -122.6, HasGPS: true},
		"b2aa00": {PublicKey: "b2aa00", Name: "Eastlake"},
		"b2bb00": {PublicKey: "b2bb00", Name: "Skyline", Lat: 47.6, Lon: -122.3, HasGPS: true},
		"c3cc00": {PublicKey: "c3cc00", Name: "Delridge"},
		"d4dd00": {PublicKey: "d4dd00", Name: "Myrtle Reservoir"},
	}
	named := mediaMeshHopNamerOf(names, now)

	if n, amb, ok := named("A1"); !ok || n.Name != "First Hill" || amb || n.HasGPS {
		t.Fatalf("a1: %+v amb=%v ok=%v, want First Hill (not West Linn)", n, amb, ok)
	}
	if n, amb, ok := named("b2"); !ok || n.Name != "Skyline" || !amb {
		t.Fatalf("b2: %+v amb=%v ok=%v, want Skyline (placed), ambiguous", n, amb, ok)
	}
	if _, _, ok := named("c3"); ok {
		t.Fatal("c3: radio2 off, should stay a hash")
	}
	if _, _, ok := named("d4"); ok {
		t.Fatal("d4: mark too old, should stay a hash")
	}
	if _, _, ok := named("ee"); ok {
		t.Fatal("ee: no MediaMesh repeater, should stay a hash")
	}
}
