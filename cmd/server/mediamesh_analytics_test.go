package main

import (
	"strings"
	"testing"
	"time"
)

// MediaMesh analytics (/api/analytics/mediamesh) and the radio2 split of the
// relay-airtime share. Seed data (db_test.go): tx 1 (ADVERT, observations 1
// and 2), tx 2 (CHAN, observation 3), tx 3 (ADVERT, observation 4).

func TestMediaMeshAnalytics(t *testing.T) {
	srv, router := setupTestServer(t)
	seedMediaMesh(t, srv,
		`INSERT INTO observation_mediamesh (observation_id) VALUES (2)`,
		`INSERT INTO node_mediamesh VALUES ('aabbccdd11223344', 'rxtx', '911.15,250,7,5', 'status', '`+mmRecentTS()+`')`,
	)

	var got MediaMeshAnalytics
	getJSON(t, router, "/api/analytics/mediamesh", &got)

	if got.TotalTransmissions != 3 || got.MediaMeshTransmissions != 1 {
		t.Fatalf("transmissions: total %d, mediamesh %d; want 3, 1", got.TotalTransmissions, got.MediaMeshTransmissions)
	}
	if got.SharePct < 33.3 || got.SharePct > 33.4 {
		t.Errorf("share = %v, want 33.3", got.SharePct)
	}
	byType := map[string]MediaMeshTypeCount{}
	for _, c := range got.ByType {
		byType[c.Name] = c
	}
	if a := byType["ADVERT"]; a.Count != 2 || a.MediaMesh != 1 {
		t.Errorf("ADVERT = %+v, want 2 with 1 on radio2", a)
	}
	if c := byType["GRP_TXT"]; c.MediaMesh != 0 {
		t.Errorf("GRP_TXT on radio2 = %d, want 0", c.MediaMesh)
	}
	if len(got.PerHour) != 1 || got.PerHour[0].Count != 1 {
		t.Errorf("per hour = %+v, want one hour with 1", got.PerHour)
	}
	if len(got.Observers) != 1 || got.Observers[0].MediaMeshObs != 1 {
		t.Fatalf("observers = %+v, want the one observer that heard radio2", got.Observers)
	}
	if got.Observers[0].TotalObs < 1 || got.Observers[0].SharePct <= 0 || got.Observers[0].LastHeard == "" {
		t.Errorf("observer row = %+v", got.Observers[0])
	}
	if len(got.Repeaters) != 1 || got.Repeaters[0].PublicKey != "aabbccdd11223344" ||
		got.Repeaters[0].Name != "TestRepeater" || got.Repeaters[0].Mode != "rxtx" || got.Repeaters[0].Radio != "911.15,250,7,5" {
		t.Errorf("repeaters = %+v", got.Repeaters)
	}
	if r := got.Repeaters[0]; r.Lat == nil || r.Lon == nil || *r.Lat != 37.5 || *r.Lon != -122.0 {
		t.Errorf("repeater position = %v, %v; want 37.5, -122", r.Lat, r.Lon)
	}
	if got.Repeaters[0].Near != "Newark, CA" {
		t.Errorf("repeater near = %q, want the closest town to its position", got.Repeaters[0].Near)
	}
}

// A packet an observer sent on radio2 is MediaMesh traffic, but the observer
// table lists what observers hear, so its own transmission is not counted.
func TestMediaMeshAnalyticsOwnTransmission(t *testing.T) {
	srv, router := setupTestServer(t)
	srv.store.mu.Lock()
	for _, tx := range srv.store.packets {
		for _, o := range tx.Observations {
			if o.ID == 2 {
				o.Direction = "tx"
			}
		}
	}
	srv.store.mu.Unlock()
	seedMediaMesh(t, srv, `INSERT INTO observation_mediamesh (observation_id) VALUES (2)`)

	var got MediaMeshAnalytics
	getJSON(t, router, "/api/analytics/mediamesh", &got)
	if got.MediaMeshTransmissions != 1 {
		t.Errorf("mediamesh transmissions = %d, want 1 (sent on radio2)", got.MediaMeshTransmissions)
	}
	if len(got.Observers) != 0 {
		t.Errorf("observers = %+v, want none: nobody heard it on radio2", got.Observers)
	}
}

// Observation 2 (observer obs2, path ["aa"], SNR 8, RSSI -95) was heard on
// radio2 from the one node whose key starts with aa: that is a link, with
// the sender's position and radio2 setting, and the observer's position
// once the observer has a node of its own.
func TestMediaMeshAnalyticsLinks(t *testing.T) {
	srv, router := setupTestServer(t)
	if _, err := srv.db.conn.Exec(`INSERT INTO nodes (public_key, name, role, lat, lon, last_seen, first_seen, advert_count)
		VALUES ('obs2', 'Observer Two Node', 'repeater', 37.7, -122.2, ?, '2026-01-01T00:00:00Z', 1)`, mmRecentTS()); err != nil {
		t.Fatal(err)
	}
	srv.store.InvalidateNodeCache()
	seedMediaMesh(t, srv,
		`INSERT INTO observation_mediamesh (observation_id) VALUES (2)`,
		`INSERT INTO node_mediamesh VALUES ('aabbccdd11223344', 'rxtx', '911.15,250,7,5', 'status', '`+mmRecentTS()+`')`,
	)

	var got MediaMeshAnalytics
	getJSON(t, router, "/api/analytics/mediamesh", &got)
	if len(got.Links) != 1 {
		t.Fatalf("links = %+v, want one", got.Links)
	}
	l := got.Links[0]
	if l.From != "aabbccdd11223344" || l.FromName != "TestRepeater" || l.FromRole != "repeater" || l.Radio != "911.15,250,7,5" {
		t.Errorf("sender = %+v", l)
	}
	if l.ObserverID != "obs2" || l.ObserverName != "Observer Two" || l.Count != 1 || l.LastHeard == "" {
		t.Errorf("observer side = %+v", l)
	}
	if l.AvgSNR == nil || *l.AvgSNR != 8 || l.AvgRSSI == nil || *l.AvgRSSI != -95 {
		t.Errorf("signal = %v, %v; want 8, -95", l.AvgSNR, l.AvgRSSI)
	}
	if l.FromLat == nil || l.FromLon == nil || *l.FromLat != 37.5 || *l.FromLon != -122.0 {
		t.Errorf("sender position = %v, %v", l.FromLat, l.FromLon)
	}
	if l.ToLat == nil || l.ToLon == nil || *l.ToLat != 37.7 || *l.ToLon != -122.2 {
		t.Errorf("observer position = %v, %v", l.ToLat, l.ToLon)
	}
}

// A row the observer heard on both radios has one SNR and RSSI for the two
// copies, so it is not a radio2 measurement and makes no link. Nor does the
// observer's own transmission.
func TestMediaMeshAnalyticsLinksOnlyRadio2Measurements(t *testing.T) {
	t.Run("heard on both radios", func(t *testing.T) {
		srv, router := setupTestServer(t)
		seedMediaMesh(t, srv,
			`INSERT INTO observation_mediamesh (observation_id) VALUES (2)`,
			`INSERT INTO observation_mainmesh (observation_id) VALUES (2)`,
		)
		var got MediaMeshAnalytics
		getJSON(t, router, "/api/analytics/mediamesh", &got)
		if len(got.Links) != 0 {
			t.Errorf("links = %+v, want none", got.Links)
		}
		if got.MediaMeshTransmissions != 1 {
			t.Errorf("mediamesh transmissions = %d, want 1: only the link is dropped", got.MediaMeshTransmissions)
		}
	})
	t.Run("own transmission", func(t *testing.T) {
		srv, router := setupTestServer(t)
		srv.store.mu.Lock()
		for _, tx := range srv.store.packets {
			for _, o := range tx.Observations {
				if o.ID == 2 {
					o.Direction = "tx"
				}
			}
		}
		srv.store.mu.Unlock()
		seedMediaMesh(t, srv, `INSERT INTO observation_mediamesh (observation_id) VALUES (2)`)
		var got MediaMeshAnalytics
		getJSON(t, router, "/api/analytics/mediamesh", &got)
		if len(got.Links) != 0 {
			t.Errorf("links = %+v, want none", got.Links)
		}
	})
}

// mediaMeshLinks: averages only over the samples there are, busiest pair
// first, capped, and no position for a node at 0,0 or one never seen.
func TestMediaMeshLinksList(t *testing.T) {
	withMediaMesh(t)
	f := func(v float64) *float64 { return &v }
	quiet := &mediaMeshLinkAgg{from: "aa", observerID: "o1"}
	quiet.add(&StoreObs{SNR: f(4), RSSI: f(-100), Timestamp: "2026-11-01T10:00:00Z"})
	quiet.add(&StoreObs{SNR: f(6), Timestamp: "2026-11-01T12:00:00Z"})
	quiet.add(&StoreObs{Timestamp: "2026-11-01T11:00:00Z"})
	busy := &mediaMeshLinkAgg{from: "bb", observerID: "o1"}
	for i := 0; i < 5; i++ {
		busy.add(&StoreObs{})
	}
	nodes := map[string]nodeInfo{
		"aa": {PublicKey: "aa", Name: "A", Role: "repeater", Lat: 47.6, Lon: -122.3},
		"bb": {PublicKey: "bb", Name: "B", Role: "companion"},
	}
	got := mediaMeshLinks(map[string]*mediaMeshLinkAgg{"aa|o1": quiet, "bb|o1": busy}, nodes, time.Now())
	if len(got) != 2 || got[0].From != "bb" || got[1].From != "aa" {
		t.Fatalf("order = %+v, want bb (5 packets) then aa (3)", got)
	}
	a := got[1]
	if a.Count != 3 || a.AvgSNR == nil || *a.AvgSNR != 5 || a.AvgRSSI == nil || *a.AvgRSSI != -100 || a.LastHeard != "2026-11-01T12:00:00Z" {
		t.Errorf("aa = %+v (snr %v, rssi %v)", a, a.AvgSNR, a.AvgRSSI)
	}
	if a.FromName != "A" || a.FromLat == nil || *a.FromLat != 47.6 || a.ToLat != nil {
		t.Errorf("aa names and positions = %+v", a)
	}
	b := got[0]
	if b.AvgSNR != nil || b.AvgRSSI != nil || b.FromLat != nil || b.FromRole != "companion" {
		t.Errorf("bb = %+v, want no signal figures and no position", b)
	}

	many := map[string]*mediaMeshLinkAgg{}
	for i := 0; i < mediaMeshMaxLinks+10; i++ {
		k := "n" + time.Duration(i).String()
		many[k] = &mediaMeshLinkAgg{from: k, observerID: "o1", count: i}
	}
	if capped := mediaMeshLinks(many, nil, time.Now()); len(capped) != mediaMeshMaxLinks || capped[0].Count != mediaMeshMaxLinks+9 {
		t.Errorf("capped list: %d rows, busiest %d", len(capped), capped[0].Count)
	}
}

// A mesh without MediaMesh gets zeros and empty lists, never nulls.
func TestMediaMeshAnalyticsEmpty(t *testing.T) {
	srv, router := setupTestServer(t)
	withMediaMesh(t)
	refreshMediaMesh(srv.db.conn, true)
	var raw map[string]interface{}
	getJSON(t, router, "/api/analytics/mediamesh", &raw)
	if raw["mediamesh_transmissions"].(float64) != 0 || raw["total_transmissions"].(float64) != 3 {
		t.Errorf("counts = %v", raw)
	}
	for _, k := range []string{"by_type", "per_hour", "observers", "repeaters", "unknown_repeaters", "links"} {
		if _, ok := raw[k].([]interface{}); !ok {
			t.Errorf("%s = %v, want a list", k, raw[k])
		}
	}
}

// Relay airtime share: rows with radio2 traffic gain mediamesh_count and
// mediamesh_airtime_pct; the others are unchanged.
func TestRelayAirtimeShareMediaMeshSplit(t *testing.T) {
	srv, _ := setupTestServer(t)
	seedMediaMesh(t, srv, `INSERT INTO observation_mediamesh (observation_id) VALUES (2)`)
	res := srv.store.computeRelayAirtimeShare(TimeWindow{})
	rows, _ := res["rows"].([]map[string]interface{})
	if len(rows) == 0 {
		t.Fatal("no rows")
	}
	tagged := 0
	for _, r := range rows {
		c, has := r["mediamesh_count"]
		if !has {
			if _, pct := r["mediamesh_airtime_pct"]; pct {
				t.Errorf("row %v has a radio2 share without a count", r["payload_type"])
			}
			continue
		}
		tagged++
		if r["payload_type"] != "ADVERT" || c.(int) != 1 {
			t.Errorf("tagged row %v count %v, want ADVERT 1", r["payload_type"], c)
		}
	}
	if tagged != 1 {
		t.Errorf("%d rows tagged, want 1", tagged)
	}
	if _, ok := res["mediamesh_score"].(int64); !ok {
		t.Errorf("mediamesh_score = %T", res["mediamesh_score"])
	}
}

// Rule 0: one pass over the store with a set lookup per observation.
func BenchmarkComputeMediaMeshAnalytics(b *testing.B) {
	store := &PacketStore{rfCache: map[string]*cachedResult{}}
	for i := 0; i < 30000; i++ {
		pt := i % 10
		tx := &StoreTx{ID: i, Hash: string(rune('a'+i%26)) + time.Duration(i).String(), PayloadType: &pt, FirstSeen: "2026-10-30T14:00:00Z"}
		for j := 0; j < 3; j++ {
			tx.Observations = append(tx.Observations, &StoreObs{ID: i*3 + j, ObserverID: "obs" + string(rune('a'+j)), Timestamp: "2026-10-30T14:00:01Z"})
		}
		store.packets = append(store.packets, tx)
	}
	withMediaMesh(b)
	mediaMeshMu.Lock()
	for i := 0; i < 90000; i += 50 {
		mediaMeshObs[i] = struct{}{}
	}
	mediaMeshMu.Unlock()
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_ = store.computeMediaMeshAnalytics("", TimeWindow{})
	}
}

// An observer whose own status says MediaMesh is on is listed even before it
// hears any radio2 traffic (one out of range of the MediaMesh repeaters).
func TestMediaMeshAnalyticsObserverRunningMediaMesh(t *testing.T) {
	srv, router := setupTestServer(t)
	seedMediaMesh(t, srv,
		`INSERT INTO observation_mediamesh (observation_id) VALUES (2)`,
		`INSERT INTO node_mediamesh VALUES ('obs1', 'rxtx', '911.15,250,7,5', 'status', '`+mmRecentTS()+`')`,
	)
	var got MediaMeshAnalytics
	getJSON(t, router, "/api/analytics/mediamesh", &got)
	if len(got.Observers) != 2 {
		t.Fatalf("observers = %+v, want obs2 (heard radio2) and obs1 (runs MediaMesh)", got.Observers)
	}
	if o := got.Observers[0]; o.ID != "obs2" || o.MediaMeshObs != 1 || o.RunsMediaMesh {
		t.Errorf("first row = %+v, want obs2 with 1 radio2 observation", o)
	}
	if o := got.Observers[1]; o.ID != "obs1" || o.MediaMeshObs != 0 || !o.RunsMediaMesh || o.LastHeard != "" {
		t.Errorf("second row = %+v, want obs1 running MediaMesh, nothing heard yet", o)
	}
}

// A mark heard from others, or one saying radio2 is off, doesn't list it.
func TestMediaMeshAnalyticsObserverNotRunning(t *testing.T) {
	srv, router := setupTestServer(t)
	seedMediaMesh(t, srv,
		`INSERT INTO node_mediamesh VALUES ('obs1', 'rxtx', NULL, 'heard', '`+mmRecentTS()+`')`,
		`INSERT INTO node_mediamesh VALUES ('obs2', 'off', NULL, 'status', '`+mmRecentTS()+`')`,
	)
	var got MediaMeshAnalytics
	getJSON(t, router, "/api/analytics/mediamesh", &got)
	if len(got.Observers) != 0 {
		t.Errorf("observers = %+v, want none", got.Observers)
	}
}

// MediaMesh repeaters known only by their hash are listed beside the others,
// within the usual windows (heard 7 days, relayed 2).
func TestMediaMeshAnalyticsUnknownRepeaters(t *testing.T) {
	srv, router := setupTestServer(t)
	recent := mmRecentTS()
	old := time.Now().UTC().Add(-3 * 24 * time.Hour).Format(time.RFC3339)
	seedMediaMesh(t, srv,
		`INSERT INTO mediamesh_prefix VALUES ('C267A0', 'heard', '`+old+`', '`+recent+`', 40)`,
		`INSERT INTO mediamesh_prefix VALUES ('9E3C', 'relayed', '`+recent+`', '`+recent+`', 3)`,
		`INSERT INTO mediamesh_prefix VALUES ('B6B2', 'relayed', '`+old+`', '`+old+`', 1)`,
	)
	var got MediaMeshAnalytics
	getJSON(t, router, "/api/analytics/mediamesh", &got)
	seen := map[string]MediaMeshUnknown{}
	for _, u := range got.UnknownRepeaters {
		seen[u.Prefix] = u
	}
	if u, ok := seen["C267A0"]; !ok || u.Source != "heard" || u.Packets != 40 {
		t.Errorf("C267A0 = %+v (%v)", u, ok)
	}
	if _, ok := seen["9E3C"]; !ok {
		t.Error("9E3C (relayed an hour ago) missing")
	}
	if _, ok := seen["B6B2"]; ok {
		t.Error("B6B2 relayed 3 days ago, past the 2-day window, but listed")
	}
}

// An unknown repeater lists the named nodes seen next to its hash, busiest
// first, with their names and Near.
func TestMediaMeshAnalyticsUnknownNeighbours(t *testing.T) {
	srv, router := setupTestServer(t)
	fh := "1ea5e1952c93" + strings.Repeat("0", 52)
	if _, err := srv.db.conn.Exec(`INSERT INTO nodes (public_key, name, role, lat, lon, last_seen, first_seen, advert_count)
		VALUES (?, 'First Hill', 'repeater', 47.60992, -122.32489, ?, '2026-01-01T00:00:00Z', 1)`, fh, mmRecentTS()); err != nil {
		t.Fatal(err)
	}
	srv.store.InvalidateNodeCache()
	recent := mmRecentTS()
	seedMediaMesh(t, srv,
		`CREATE TABLE IF NOT EXISTS mediamesh_prefix_next (prefix TEXT NOT NULL, public_key TEXT NOT NULL,
			side TEXT NOT NULL, packets INTEGER NOT NULL, PRIMARY KEY (prefix, public_key, side))`,
		`INSERT INTO mediamesh_prefix VALUES ('9E3C', 'relayed', '`+recent+`', '`+recent+`', 3)`,
		`INSERT INTO mediamesh_prefix_next VALUES ('9E3C', 'ffff`+strings.Repeat("1", 60)+`', 'before', 2)`,
		`INSERT INTO mediamesh_prefix_next VALUES ('9E3C', '`+fh+`', 'observer', 12)`,
	)
	var got MediaMeshAnalytics
	getJSON(t, router, "/api/analytics/mediamesh", &got)
	if len(got.UnknownRepeaters) != 1 {
		t.Fatalf("unknown = %+v", got.UnknownRepeaters)
	}
	next := got.UnknownRepeaters[0].Next
	if len(next) != 2 {
		t.Fatalf("next = %+v, want 2", next)
	}
	if next[0].Name != "First Hill" || next[0].Side != "observer" || next[0].Packets != 12 || next[0].Near != "First Hill, Seattle" {
		t.Errorf("busiest neighbour = %+v", next[0])
	}
	if next[1].Name != "" || next[1].Side != "before" || next[1].Packets != 2 {
		t.Errorf("unnamed neighbour = %+v", next[1])
	}
}

func TestMediaMeshMediaStatsOf(t *testing.T) {
	if got := mediaMeshMediaStatsOf(nil); got != (MediaMeshMediaStats{}) {
		t.Errorf("empty = %+v", got)
	}
	if got := mediaMeshMediaStatsOf([]int{3, 1, 2}); got.Packets != 3 || got.MedianHops != 2 || got.MaxHops != 3 {
		t.Errorf("odd = %+v", got)
	}
	if got := mediaMeshMediaStatsOf([]int{4, 1, 2, 3}); got.MedianHops != 2.5 || got.MaxHops != 4 {
		t.Errorf("even = %+v", got)
	}
}

// A repeater carries its MediaMesh history: first seen and media relayed.
func TestMediaMeshAnalyticsRepeaterHistory(t *testing.T) {
	srv, router := setupTestServer(t)
	seedMediaMesh(t, srv,
		`CREATE TABLE IF NOT EXISTS mediamesh_node_stats (public_key TEXT PRIMARY KEY, first_seen TEXT NOT NULL,
			relayed_7d INTEGER NOT NULL DEFAULT 0)`,
		`INSERT INTO node_mediamesh VALUES ('aabbccdd11223344', 'rxtx', '911.15,250,7,5', 'status', '`+mmRecentTS()+`')`,
		`INSERT INTO mediamesh_node_stats VALUES ('aabbccdd11223344', '2026-10-20T08:00:00Z', 37)`,
	)
	var got MediaMeshAnalytics
	getJSON(t, router, "/api/analytics/mediamesh", &got)
	if len(got.Repeaters) != 1 {
		t.Fatalf("repeaters = %+v", got.Repeaters)
	}
	if r := got.Repeaters[0]; r.FirstSeen != "2026-10-20T08:00:00Z" || r.RelayedWeek != 37 {
		t.Errorf("history = %q, %d; want 2026-10-20T08:00:00Z, 37", r.FirstSeen, r.RelayedWeek)
	}
}
