package main

import (
	"database/sql"
	"path/filepath"
	"testing"

	_ "github.com/mattn/go-sqlite3"
)

func TestMMDays(t *testing.T) {
	f := func(v float64) *float64 { return &v }
	mm := &MediaMeshAnalytics{
		Repeaters: []MediaMeshRepeater{
			{PublicKey: "aa", Name: "First Hill", Lat: f(47.6), Lon: f(-122.3)},
			{PublicKey: "bb", Name: "Guessed", Lat: f(47.5), Lon: f(-122.2), PositionFromName: true},
			{PublicKey: "cc", Name: "No position"},
			{PublicKey: "dd", Name: "Hidden", Lat: f(47.4), Lon: f(-122.1)},
		},
		Links:                  []MediaMeshLink{{From: "aa", ObserverID: "ob", Count: 3, AvgSNR: f(4.5)}, {From: "dd", ObserverID: "ob", Count: 1}},
		Backbone:               []MediaMeshBackboneEdge{{A: "aa", B: "dd", Packets: 9}, {A: "aa", B: "ee", Packets: 2}},
		MediaMeshTransmissions: 120,
		Media:                  MediaMeshMediaStats{Packets: 40},
	}
	shown := func(k string) bool { return k != "dd" }
	d := dayFrom("2026-11-22", mm, shown)
	if len(d.Repeaters) != 1 || d.Repeaters[0].Key != "aa" || len(d.Links) != 1 || len(d.Backbone) != 1 || d.Transmissions != 120 || d.MediaPackets != 40 {
		t.Fatalf("%+v", d)
	}
	db, err := sql.Open("sqlite3", "file:"+filepath.Join(t.TempDir(), "x.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := recordMMDay(db, d); err != nil {
		t.Fatal(err)
	}
	d2 := d
	d2.MediaPackets = 50
	if err := recordMMDay(db, d2); err != nil { // the day written over
		t.Fatal(err)
	}
	if err := recordMMDay(db, dayFrom("2026-11-20", nil, nil)); err != nil {
		t.Fatal(err)
	}
	got, err := readMMDays(db)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].Day != "2026-11-20" || got[1].MediaPackets != 50 || got[1].Repeaters[0].Name != "First Hill" || *got[1].Links[0].SNR != 4.5 {
		t.Fatalf("%+v", got)
	}
}
