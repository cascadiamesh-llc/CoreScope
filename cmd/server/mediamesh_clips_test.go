package main

import (
	"encoding/hex"
	"net/http/httptest"
	"strconv"
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

// The flight recorder: every piece of one clip each observer heard on
// radio2, found by either of its ids, parity pieces apart, and nothing from
// the main radio or from another clip.
func TestMediaMeshClipLog(t *testing.T) {
	srv, router := setupTestServer(t)
	seedMediaMesh(t, srv)
	at := time.Now().UTC().Add(-time.Hour)
	ts := func(sec int) string { return at.Add(time.Duration(sec) * time.Second).Format(time.RFC3339) }
	grpTxt, raw := PayloadGRP_TXT, mediaPayloadRawCustom
	obsID := 900000
	obs := func(name string, sec int, path string, onMM bool) *StoreObs {
		obsID++
		if onMM {
			mediaMeshMu.Lock()
			mediaMeshObs[obsID] = struct{}{}
			mediaMeshMu.Unlock()
		}
		return &StoreObs{ID: obsID, ObserverID: "obs-" + name, ObserverName: name, PathJSON: path, Timestamp: ts(sec)}
	}
	sid := uint32(0x1a2b3c4d)
	piece := func(wire uint32, info, sec int, o ...*StoreObs) *StoreTx {
		b := []byte{0x56, byte(wire >> 24), byte(wire >> 16), byte(wire >> 8), byte(wire), byte(info), 0xee}
		return &StoreTx{Hash: "h" + strconv.Itoa(obsID), FirstSeen: ts(sec), PayloadType: &raw,
			DecodedJSON: `{"raw":"` + hex.EncodeToString(b) + `"}`, Observations: o}
	}
	txs := []*StoreTx{
		{Hash: "ann", FirstSeen: ts(0), PayloadType: &grpTxt, DecodedJSON: `{"text":"Jade: VI1:` + strconv.FormatUint(uint64(sid), 36) + `:14:3:0 Photo","channel":"#seattle"}`,
			Observations: []*StoreObs{obs("Near", 0, `["aa"]`, false)}},
		piece(sid, 0, 5, obs("Far", 6, `["aa","bb"]`, true), obs("Near", 5, `["aa"]`, true)),
		piece(sid, 2, 9, obs("Far", 10, `["aa","bb"]`, true), obs("Main", 9, `["aa"]`, false)),
		piece(sid^mediaClipFecXor, 1, 12, obs("Far", 12, `["aa","bb"]`, true)),
		piece(0x0badf00d, 0, 7, obs("Far", 7, `["aa"]`, true)),
	}
	srv.store.mu.Lock()
	srv.store.packets = append(srv.store.packets, txs...)
	srv.store.mu.Unlock()

	for _, ask := range []uint32{sid, sid ^ mediaClipFecXor} {
		log := srv.store.mediaMeshClipLog(ask, at.Add(-time.Hour).Format(time.RFC3339))
		if log.SID != "1a2b3c4d" || log.Clip == nil || log.Announcement == nil {
			t.Fatalf("asked %08x: %+v", ask, log)
		}
		if log.Clip.Outcome != "parity" || log.Clip.Heard != 2 || log.Clip.ObsName != "Far" || log.Clip.Hops != 2 {
			t.Errorf("verdict: %+v", log.Clip)
		}
		if log.Announcement.Channel != "#seattle" || len(log.Announcement.Heard) != 1 {
			t.Errorf("announcement: %+v", log.Announcement)
		}
		if len(log.Pieces) != 3 {
			t.Fatalf("pieces: %+v", log.Pieces)
		}
		p0, p2, par := log.Pieces[0], log.Pieces[1], log.Pieces[2]
		if p0.Index != 0 || len(p0.Heard) != 2 || p0.Heard[0].Name != "Near" || p0.Heard[1].Name != "Far" {
			t.Errorf("piece 0: %+v", p0)
		}
		if p2.Index != 2 || len(p2.Heard) != 1 {
			t.Errorf("piece 2 (one copy on the main radio): %+v", p2)
		}
		if !par.Parity || par.Index != -1 || par.Block != 0 || par.J != 1 {
			t.Errorf("parity: %+v", par)
		}
		if _, ok := log.Hops["bb"]; !ok {
			t.Errorf("hops: %+v", log.Hops)
		}
	}
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest("GET", "/api/analytics/mediamesh/clips/zz", nil))
	if rec.Code != 400 {
		t.Errorf("bad sid: %d", rec.Code)
	}
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest("GET", "/api/analytics/mediamesh/clips/00000001", nil))
	if rec.Code != 404 {
		t.Errorf("unknown clip: %d", rec.Code)
	}
	var got MediaMeshClipLog
	getJSON(t, router, "/api/analytics/mediamesh/clips/1a2b3c4d", &got)
	if got.Clip == nil || len(got.Pieces) != 3 {
		t.Errorf("endpoint: %+v", got)
	}
}

func TestUnannouncedMediaClips(t *testing.T) {
	t0 := time.Date(2026, 11, 19, 18, 0, 0, 0, time.UTC)
	anns := []mediaClipAnn{{sid: 1, kind: "photo", total: 2, at: t0}}
	near, far := []string{"aa"}, []string{"aa", "bb"}
	var p []mediaClipPiece
	add := func(sid uint32, info int, obs string, path []string, sec int) {
		p = append(p, mediaClipPiece{sid: sid, info: info, bytes: 150, observer: obs, obsName: obs, path: path, at: t0.Add(time.Duration(sec) * time.Second)})
	}
	add(1, 0, "far", far, 5) // announced: not here
	add(1, 1, "far", far, 9)
	// a clip sent in a direct message: 5 pieces, piece 2 twice, then 1 parity
	for i, sec := range []int{10, 14, 18, 22, 26, 27} {
		idx := i
		if i == 5 {
			idx = 2
		}
		add(0xA1B2C3D4, idx, "far", far, sec)
		add(0xA1B2C3D4, idx, "near", near, sec-1)
	}
	add(0xA1B2C3D4^mediaClipFecXor, 0, "far", far, 30)
	// the same id two hours later: another clip
	add(0xA1B2C3D4, 0, "far", near, 7200)
	add(0xA1B2C3D4, 1, "far", near, 7230)
	// one piece alone says nothing about speed
	add(0x0BADF00D, 0, "far", far, 40)

	got := unannouncedMediaClips(anns, p)
	if len(got) != 2 {
		t.Fatalf("%d clips: %+v", len(got), got)
	}
	later, c := got[0], got[1]
	if c.SID != "a1b2c3d4" || c.Outcome != "unannounced" || c.Total != 0 || c.Kind != "unknown" {
		t.Fatalf("%+v", c)
	}
	if c.Observer != "far" || c.Hops != 2 || c.Heard != 5 || c.Parity != 1 || c.Observers != 2 {
		t.Fatalf("far end %s hops %d heard %d parity %d observers %d", c.Observer, c.Hops, c.Heard, c.Parity, c.Observers)
	}
	// timed from piece 0 to piece 4 as first heard: 4 pieces sent after the clock started
	if c.DurationS != 16 || c.Bytes != 750 || c.RateBytes != 600 || c.BytesEstimated {
		t.Fatalf("%.0f s %d bytes, %d timed (the parity piece is no clip data, a repeat counts once)", c.DurationS, c.Bytes, c.RateBytes)
	}
	if later.SID != "a1b2c3d4" || later.Heard != 2 || later.DurationS != 30 || later.At <= c.At {
		t.Fatalf("the later clip: %+v", later)
	}
}

// A clip sent privately that the observers heard only some of: the piece
// numbers say how many were sent between, counted on through 255 -> 0.
func TestUnannouncedClipSpan(t *testing.T) {
	t0 := time.Date(2026, 11, 22, 17, 48, 0, 0, time.UTC)
	var p []mediaClipPiece
	for i, idx := range []int{121, 140, 200, 253, 4, 9} {
		p = append(p, mediaClipPiece{sid: 0x10346c47, info: idx, bytes: 163, observer: "far", obsName: "far", path: []string{"aa", "bb"}, at: t0.Add(time.Duration(i*50) * time.Second)})
	}
	got := unannouncedMediaClips(nil, p)
	if len(got) != 1 {
		t.Fatalf("%d clips", len(got))
	}
	c := got[0]
	// 121 .. 265: 144 pieces after the first, over 250 s
	if c.DurationS != 250 || c.RateBytes != 144*163 || c.Bytes != 145*163 || !c.BytesEstimated || c.Heard != 6 {
		t.Fatalf("%+v", c)
	}
	if k := float64(c.RateBytes) * 8 / c.DurationS / 1000; k < 0.7 || k > 0.8 {
		t.Fatalf("%.2f kbit/s", k)
	}
	// numbers that don't run forward say nothing: back to what was heard
	if span, _ := piecesSpanned([]pieceAt{{index: 5, bytes: 1, at: t0}, {index: 5, bytes: 1, at: t0.Add(time.Second)}}); span != 0 {
		t.Fatalf("span %d", span)
	}
}
