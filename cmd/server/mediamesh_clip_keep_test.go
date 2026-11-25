package main

import (
	"database/sql"
	_ "github.com/mattn/go-sqlite3"
	"path/filepath"
	"testing"
)

func openKeepDB(t *testing.T) *sql.DB {
	db, err := sql.Open("sqlite3", "file:"+filepath.Join(t.TempDir(), "k.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

func TestKeepAndMerge(t *testing.T) {
	db := openKeepDB(t)
	day1 := &MediaMeshClips{
		Clips:       []MediaMeshClip{{SID: "c1", At: "2026-11-22T10:00:00Z", Outcome: "whole", Heard: 10, Total: 10}, {SID: "c2", At: "2026-11-22T11:00:00Z", Outcome: "partial", Heard: 5, Total: 8}},
		Unannounced: []MediaMeshClip{{SID: "u1", FirstAt: "2026-11-22T12:00:00Z", Outcome: "unannounced", Heard: 7, DurationS: 30}},
		Hours:       []MediaMeshClipHour{{T: "2026-11-22T10:00:00Z", Packets: 40, Clips: 1}},
	}
	if err := keepMMClips(db, day1); err != nil {
		t.Fatal(err)
	}
	// later, c1's first pieces have left memory: a worse account must not win;
	// c2 got more pieces: it should; the hour now looks smaller
	later := &MediaMeshClips{
		Clips: []MediaMeshClip{{SID: "c1", At: "2026-11-22T10:00:00Z", Outcome: "partial", Heard: 3, Total: 10}, {SID: "c2", At: "2026-11-22T11:00:00Z", Outcome: "whole", Heard: 8, Total: 8}},
		Hours: []MediaMeshClipHour{{T: "2026-11-22T10:00:00Z", Packets: 12, Clips: 1}},
	}
	if err := keepMMClips(db, later); err != nil {
		t.Fatal(err)
	}
	kept, err := keptMMClips(db, "2026-11-22T00:00:00Z")
	if err != nil {
		t.Fatal(err)
	}
	by := map[string]MediaMeshClip{}
	for _, c := range kept.Clips {
		by[c.SID] = c
	}
	if by["c1"].Outcome != "whole" || by["c2"].Outcome != "whole" || len(kept.Unannounced) != 1 || len(kept.Hours) != 1 || kept.Hours[0].Packets != 40 {
		t.Fatalf("%+v", kept)
	}
	if k2, _ := keptMMClips(db, "2026-11-22T10:30:00Z"); len(k2.Clips) != 1 || len(k2.Hours) != 1 || len(k2.Unannounced) != 1 {
		t.Fatalf("since: %+v", k2)
	}

	// now: memory holds only the last hours; the announcement of u1 is back in
	fresh := &MediaMeshClips{
		Clips: []MediaMeshClip{{SID: "u1", At: "2026-11-22T12:00:00Z", Outcome: "partial", Heard: 2, Total: 9}, {SID: "c3", At: "2026-11-23T04:00:00Z", Outcome: "whole", Heard: 4, Total: 4}},
		Hours: []MediaMeshClipHour{{T: "2026-11-23T04:00:00Z", Packets: 3}},
	}
	mergeMMClips(kept, fresh)
	if len(fresh.Clips) != 4 || fresh.Clips[0].SID != "c3" || fresh.Clips[3].SID != "c1" {
		t.Fatalf("clips %+v", fresh.Clips)
	}
	if len(fresh.Unannounced) != 0 {
		t.Fatalf("an announced clip also listed unannounced: %+v", fresh.Unannounced)
	}
	if len(fresh.Hours) != 2 || fresh.Hours[0].T != "2026-11-22T10:00:00Z" {
		t.Fatalf("hours %+v", fresh.Hours)
	}
}

func TestKeepPrivateChannelClips(t *testing.T) {
	db := openKeepDB(t)
	whole := MediaMeshClip{SID: "p2c1", Channel: "2c", Outcome: "private", Heard: 12,
		At: "2026-11-24T19:58:00Z", FirstAt: "2026-11-24T19:58:00Z", LastAt: "2026-11-24T20:00:20Z"}
	if err := keepMMClips(db, &MediaMeshClips{PrivateChannel: []MediaMeshClip{whole}}); err != nil {
		t.Fatal(err)
	}
	// its first pieces have left memory: it starts later, under another key
	late := MediaMeshClip{SID: "p2c2", Channel: "2c", Outcome: "private", Heard: 4,
		At: "2026-11-24T19:59:30Z", FirstAt: "2026-11-24T19:59:30Z", LastAt: "2026-11-24T20:00:20Z"}
	fresh := &MediaMeshClips{PrivateChannel: []MediaMeshClip{late}}
	if err := keepMMClips(db, fresh); err != nil {
		t.Fatal(err)
	}
	kept, err := keptMMClips(db, "2026-11-24T00:00:00Z")
	if err != nil || len(kept.PrivateChannel) != 2 {
		t.Fatalf("%v %+v", err, kept)
	}
	mergeMMClips(kept, fresh)
	if len(fresh.PrivateChannel) != 1 || fresh.PrivateChannel[0].Heard != 12 {
		t.Fatalf("%+v", fresh.PrivateChannel)
	}
}

func TestPrune(t *testing.T) {
	db := openKeepDB(t)
	keepMMClips(db, &MediaMeshClips{Clips: []MediaMeshClip{{SID: "old", At: "2020-01-01T00:00:00Z", Outcome: "whole"}}, Hours: []MediaMeshClipHour{{T: "2020-01-01T00:00:00Z", Packets: 1}}})
	pruneMMClips(db, 35)
	k, _ := keptMMClips(db, "2000-01-01T00:00:00Z")
	if len(k.Clips) != 0 || len(k.Hours) != 0 {
		t.Fatalf("%+v", k)
	}
}
