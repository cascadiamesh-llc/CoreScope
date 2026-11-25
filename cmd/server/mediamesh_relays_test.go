package main

import (
	"testing"
	"time"
)

func TestSummarizeMMRelays(t *testing.T) {
	h1, h2 := newMMRelayHour(), newMMRelayHour()
	// hour 1: 4 pieces relayed 2, 24, 24 and 33 times
	h1.Pieces, h1.AirMs = 4, 4000
	h1.Hist = map[int]int{2: 1, 24: 2, 33: 1}
	h1.ByRepeater = map[string]float64{"AAAA": 0.72 * 3600000, "BBBB": 0.1 * 3600000}
	h1.ByStart = map[string]map[int]int{"AAAA": {24: 5}, "CCCC": {3: 2}}
	// hour 2: 2 pieces, BBBB busier
	h2.Pieces, h2.AirMs = 2, 2000
	h2.Hist = map[int]int{24: 2}
	h2.ByRepeater = map[string]float64{"BBBB": 0.3 * 3600000}
	now := time.Date(2026, 11, 25, 12, 0, 0, 0, time.UTC)
	old := newMMRelayHour()
	old.Pieces, old.Hist = 1, map[int]int{5: 1}
	hours := map[string]*mmRelayHour{"2026-11-25T10:00:00Z": h1, "2026-11-25T11:00:00Z": h2, "2026-11-10T10:00:00Z": old}
	out := summarizeMMRelays(hours, now.Add(-7*24*time.Hour), now, func(h string) string {
		if h == "AAAA" {
			return "First Hill"
		}
		return ""
	})
	if out.Pieces != 6 || out.MedianRelays != 24 || out.AirPerPieceS != 1 {
		t.Fatalf("%+v", out)
	}
	if out.Bins[0].Pieces != 1 || out.Bins[4].Pieces != 4 || out.Bins[6].Pieces != 1 {
		t.Fatalf("bins %+v", out.Bins)
	}
	if len(out.ByStart) != 1 || out.ByStart[0].Name != "First Hill" || out.ByStart[0].Median != 24 {
		t.Fatalf("by start %+v (fewer than 5 pieces left out)", out.ByStart)
	}
	if len(out.Weeks) != 2 || out.Weeks[0].Week != "2026-11-09" || out.Weeks[1].Week != "2026-11-23" {
		t.Fatalf("weeks %+v (the older week is outside the window but on the line)", out.Weeks)
	}
	a := out.Repeaters[0]
	if a.Hash != "AAAA" || a.Name != "First Hill" || int(a.BusiestPct+0.5) != 72 || int(a.TypicalPct+0.5) != 36 || a.BusiestAt != "2026-11-25T10:00:00Z" {
		t.Fatalf("repeaters %+v (an hour it sent nothing counts as 0)", out.Repeaters)
	}
	if b := out.Repeaters[1]; b.Name != "BBBB" || int(b.BusiestPct+0.5) != 30 {
		t.Fatalf("unnamed repeater %+v", b)
	}
}

func TestHistMedian(t *testing.T) {
	if m := histMedian(map[int]int{1: 1, 3: 1}); m != 2 {
		t.Fatal(m)
	}
	if m := histMedian(map[int]int{}); m != 0 {
		t.Fatal(m)
	}
	if m := histMedian(map[int]int{5: 3, 9: 1}); m != 5 {
		t.Fatal(m)
	}
}

func TestKeepMMRelayHours(t *testing.T) {
	db := openKeepDB(t)
	full := newMMRelayHour()
	full.Pieces, full.Hist = 10, map[int]int{20: 10}
	if err := keepMMRelayHours(db, map[string]*mmRelayHour{"2026-11-25T10:00:00Z": full}); err != nil {
		t.Fatal(err)
	}
	thin := newMMRelayHour()
	thin.Pieces, thin.Hist = 3, map[int]int{20: 3}
	if err := keepMMRelayHours(db, map[string]*mmRelayHour{"2026-11-25T10:00:00Z": thin}); err != nil {
		t.Fatal(err)
	}
	kept, err := keptMMRelayHours(db, "2026-11-25T00:00:00Z")
	if err != nil || kept["2026-11-25T10:00:00Z"] == nil || kept["2026-11-25T10:00:00Z"].Pieces != 10 {
		t.Fatalf("%v %+v", err, kept)
	}
}

func TestKeepClipLogsAndPrivateKeys(t *testing.T) {
	db := openKeepDB(t)
	heard := func(n int) *MediaMeshClipLog {
		l := &MediaMeshClipLog{SID: "d2e93aee"}
		for i := 0; i < n; i++ {
			l.Pieces = append(l.Pieces, MediaMeshClipPiece{Index: i, Heard: []MediaMeshClipHeard{{Observer: "o", At: "2026-11-25T19:38:46Z", Path: []string{"FBA9"}}}})
		}
		return l
	}
	if err := keepClipLog(db, "d2e93aee", "2026-11-25T19:38:42Z", heard(5)); err != nil {
		t.Fatal(err)
	}
	if err := keepClipLog(db, "d2e93aee", "2026-11-25T19:38:42Z", heard(2)); err != nil {
		t.Fatal(err)
	}
	if l := keptClipLog(db, "d2e93aee"); l == nil || len(l.Pieces) != 5 {
		t.Fatalf("a thinner log wrote over a fuller one: %+v", l)
	}
	if k := keptClipLogKeys(db, "2026-11-25T00:00:00Z"); !k["d2e93aee"] {
		t.Fatalf("%v", k)
	}
	if keptClipLog(db, "00000000") != nil {
		t.Fatal("not kept")
	}

	ch, first, ok := parsePrivateClipKey("pe6" + "6925f2e0")
	if !ok || ch != 0xe6 || first.Unix() != 0x6925f2e0 {
		t.Fatalf("%v %v %v", ch, first, ok)
	}
	if ch, _, ok := parsePrivateClipKey("pxx6925f2e0"); !ok || ch != -1 {
		t.Fatal("unknown channel")
	}
	for _, bad := range []string{"d2e93aee", "p", "pzz1", "pe6", "pe6zz"} {
		if _, _, ok := parsePrivateClipKey(bad); ok {
			t.Fatalf("%q read as a key", bad)
		}
	}
	if _, ok := clipLogBuilder("d2e93aee"); !ok {
		t.Fatal("session id")
	}
	if _, ok := clipLogBuilder("pe66925f2e0"); !ok {
		t.Fatal("private key")
	}
	if _, ok := clipLogBuilder("nothex!!"); ok {
		t.Fatal("bad key")
	}
}

func TestMarkReplays(t *testing.T) {
	out := &MediaMeshClips{
		Clips:          []MediaMeshClip{{SID: "aaaa0001", At: "2026-11-20T10:00:00Z", Heard: 3}, {SID: "aaaa0002", At: "2026-11-25T10:00:00Z", Heard: 3}, {SID: "aaaa0003", At: "2026-11-25T10:00:00Z"}},
		PrivateChannel: []MediaMeshClip{{SID: "pe61", At: "2026-11-19T10:00:00Z", Heard: 4}},
	}
	markReplays(out, map[string]bool{"pe61": true}, "2026-11-25T06:00:00Z")
	if out.Clips[0].Replay || !out.Clips[1].Replay || out.Clips[2].Replay || !out.PrivateChannel[0].Replay {
		t.Fatalf("%+v %+v", out.Clips, out.PrivateChannel)
	}
}
