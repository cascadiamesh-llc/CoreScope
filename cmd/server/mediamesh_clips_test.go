package main

import (
	"testing"
	"time"
)

func TestParseMediaClipAnnouncement(t *testing.T) {
	a, ok := parseMediaClipAnnouncement("Jade: VV1:" + "1a2b3c" + ":15:8:9 Video Ferry")
	if !ok || a.kind != "video" || a.total != 8 || a.seconds != 9 {
		t.Fatalf("%+v %v", a, ok)
	}
	if a, ok := parseMediaClipAnnouncement("VI1:abc:14:5:96 Photo"); !ok || a.kind != "photo" || a.seconds != 0 || a.total != 5 {
		t.Errorf("photo: %+v %v", a, ok)
	}
	if a, ok := parseMediaClipAnnouncement("VE3:a:1:3:4"); !ok || a.kind != "voice" {
		t.Errorf("voice: %+v %v", a, ok)
	}
	for _, bad := range []string{"hello", "VV1 is great", "VI1:zzzzzzzzzzzzz:1:5:0", "VI1:a:1:0:0"} {
		if _, ok := parseMediaClipAnnouncement(bad); ok {
			t.Errorf("%q parsed", bad)
		}
	}
	if sid, info, ok := parseMediaClipBytes([]byte{0x56, 0x1a, 0x2b, 0x3c, 0x4d, 7, 0}); !ok || sid != 0x1a2b3c4d || info != 7 {
		t.Errorf("bytes: %x %d %v", sid, info, ok)
	}
	if _, _, ok := parseMediaClipBytes([]byte{0x72, 1, 2, 3, 4, 5}); ok {
		t.Error("a fetch request is not a piece")
	}
}

func TestAnalyseMediaClips(t *testing.T) {
	t0 := time.Date(2026, 11, 18, 12, 0, 0, 0, time.UTC)
	anns := []mediaClipAnn{
		{sid: 1, kind: "photo", total: 4, at: t0},
		{sid: 2, kind: "voice", total: 3, seconds: 6, at: t0.Add(time.Minute)},
		{sid: 3, kind: "video", total: 25, seconds: 9, at: t0.Add(2 * time.Minute)},
		{sid: 4, kind: "photo", total: 2, at: t0.Add(3 * time.Minute)},
	}
	near, far := []string{"aa"}, []string{"aa", "bb", "cc"}
	var p []mediaClipPiece
	add := func(sid uint32, info int, obs string, path []string, sec int) {
		p = append(p, mediaClipPiece{sid: sid, info: info, bytes: 100, observer: obs, obsName: obs, path: path, at: t0.Add(time.Duration(sec) * time.Second)})
	}
	// clip 1: whole at the far end, 3 hops, 30 s
	for i := 0; i < 4; i++ {
		add(1, i, "far", far, 10+i*10)
		add(1, i, "near", near, 5+i*10)
	}
	// clip 2: piece 1 lost, one parity piece for block 0 rebuilds it
	add(2, 0, "far", far, 70)
	add(2, 2, "far", far, 80)
	add(2^mediaClipFecXor, 0, "far", far, 90)
	// clip 3: block 0 loses 2 with 1 parity -> partial; block 1 (20..24) whole
	for i := 0; i < 25; i++ {
		if i != 3 && i != 4 {
			add(3, i, "far", far, 130+i)
		}
	}
	add(3^mediaClipFecXor, 1, "far", far, 160)
	// a stranger with no announcement, and clip 4 never heard
	add(99, 0, "far", far, 10)
	c := analyseMediaClips(anns, p)
	if len(c) != 4 {
		t.Fatalf("%d clips", len(c))
	}
	by := map[string]MediaMeshClip{}
	for _, x := range c {
		by[x.SID] = x
	}
	if x := by["00000001"]; x.Outcome != "whole" || x.Hops != 3 || x.Observer != "far" || x.DurationS != 30 || x.Bytes != 400 || x.Observers != 2 {
		t.Errorf("clip 1: %+v", x)
	}
	if x := by["00000002"]; x.Outcome != "parity" || len(x.Rebuilt) != 1 || x.Rebuilt[0] != 1 || x.Parity != 1 {
		t.Errorf("clip 2: %+v", x)
	}
	if x := by["00000003"]; x.Outcome != "partial" || len(x.Missing) != 2 || x.Heard != 23 {
		t.Errorf("clip 3: %+v", x)
	}
	if x := by["00000004"]; x.Outcome != "none" || x.Heard != 0 {
		t.Errorf("clip 4: %+v", x)
	}
	if c[0].SID != "00000004" {
		t.Errorf("newest first: %s", c[0].SID)
	}
}
