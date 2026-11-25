package main

import (
	"testing"
	"time"
)

func TestPrivateChannelClips(t *testing.T) {
	t0 := time.Date(2026, 11, 24, 19, 58, 0, 0, time.UTC)
	o := func(name string, hops int) privateObs {
		path := make([]string, hops)
		for i := range path {
			path[i] = "aabb"
		}
		return privateObs{observer: name, name: name, path: path}
	}
	var ps []privatePiece
	// channel 0x2c: 11 pieces over 50 s, heard at 2 and 5 hops
	for i := 0; i < 11; i++ {
		ps = append(ps, privatePiece{channel: 0x2c, at: t0.Add(time.Duration(i*5) * time.Second), obs: []privateObs{o("near", 2), o("far", 5)}})
	}
	// its repair round 90 s later: the same clip
	ps = append(ps, privatePiece{channel: 0x2c, at: t0.Add(140 * time.Second), obs: []privateObs{o("near", 2)}})
	// 10 minutes later on the same channel: another clip
	for i := 0; i < 3; i++ {
		ps = append(ps, privatePiece{channel: 0x2c, at: t0.Add(10*time.Minute + time.Duration(i)*time.Second), obs: []privateObs{o("near", 1)}})
	}
	// two lone pieces on another channel: not a clip
	ps = append(ps, privatePiece{channel: 0x07, at: t0, obs: []privateObs{o("near", 1)}}, privatePiece{channel: 0x07, at: t0.Add(5 * time.Minute)})

	got := privateChannelClips(ps)
	if len(got) != 2 {
		t.Fatalf("want 2 clips, got %+v", got)
	}
	newer, older := got[0], got[1]
	if newer.Heard != 3 || newer.Channel != "2c" || newer.Outcome != "private" {
		t.Fatalf("newer %+v", newer)
	}
	if older.Heard != 12 || older.Hops != 5 || older.ObsName != "far" || older.Observers != 2 || older.DurationS != 140 || older.Kind != "unknown" {
		t.Fatalf("older %+v", older)
	}
	if older.SID == newer.SID || older.SID[0] != 'p' {
		t.Fatalf("keys %q %q", older.SID, newer.SID)
	}

	// worked out again once its first pieces left memory: one clip still
	late := privateChannelClips(ps[6:12])
	if len(late) != 1 || late[0].SID == older.SID {
		t.Fatalf("late %+v", late)
	}
	merged := dedupePrivateClips(append(append([]MediaMeshClip{}, got...), late...))
	if len(merged) != 2 || merged[1].Heard != 12 {
		t.Fatalf("merged %+v", merged)
	}
}

func TestJudgeByReceipt(t *testing.T) {
	c := MediaMeshClip{SID: "aaaa0001", Kind: "unknown", Outcome: "unannounced", Heard: 3, HeardIdx: []int{0, 1, 3}}
	judgeByReceipt(&c)
	if c.TotalFrom != "" || c.Total != 0 {
		t.Fatalf("judged without a receipt: %+v", c)
	}
	c.Delivery = &MediaMeshDelivery{Recipients: 1, Whole: 1, Total: 5, Kind: "photo"}
	judgeByReceipt(&c)
	if c.Total != 5 || c.TotalFrom != "receipt" || c.Kind != "photo" || len(c.Missing) != 2 || c.Missing[0] != 2 || c.Missing[1] != 4 {
		t.Fatalf("%+v", c)
	}
}
