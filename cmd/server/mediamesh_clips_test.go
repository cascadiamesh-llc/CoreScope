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
	// every piece of clip 1 reached 3 hops; clip 3's 23 too; clip 4 none
	if h := by["00000001"].HeardByHop; len(h) != 3 || h[0] != 4 || h[2] != 4 {
		t.Errorf("clip 1 by hop: %v", h)
	}
	if h := by["00000003"].HeardByHop; len(h) != 3 || h[2] != 23 {
		t.Errorf("clip 3 by hop: %v", h)
	}
	if by["00000004"].HeardByHop != nil {
		t.Errorf("clip 4 by hop: %v", by["00000004"].HeardByHop)
	}
}

func TestHeardByHop(t *testing.T) {
	// pieces 0..3 heard at most 1, 3, 3 and 0 hops out
	got := heardByHop(map[int]int{0: 1, 1: 3, 2: 3, 3: 0})
	if len(got) != 3 || got[0] != 3 || got[1] != 2 || got[2] != 2 {
		t.Fatalf("%v", got)
	}
	if heardByHop(map[int]int{0: 12})[mediaClipMaxHops-1] != 1 || len(heardByHop(map[int]int{0: 12})) != mediaClipMaxHops {
		t.Fatal("capped")
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
		piece(sid^mediaClipRepairXor, 5, 14, obs("Far", 14, `["aa","bb"]`, true)),
		piece(0x0badf00d, 0, 7, obs("Far", 7, `["aa"]`, true)),
	}
	srv.store.mu.Lock()
	srv.store.packets = append(srv.store.packets, txs...)
	srv.store.mu.Unlock()

	for _, ask := range []uint32{sid, sid ^ mediaClipFecXor, sid ^ mediaClipRepairXor} {
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
		if len(log.Pieces) != 4 {
			t.Fatalf("pieces: %+v", log.Pieces)
		}
		p0, p2, par, rep := log.Pieces[0], log.Pieces[1], log.Pieces[2], log.Pieces[3]
		if !rep.Parity || !rep.Repair || rep.Seed != 5 || rep.Index != -1 {
			t.Errorf("repair: %+v", rep)
		}
		if log.Clip.Parity != 2 {
			t.Errorf("parity and repair pieces: %d", log.Clip.Parity)
		}
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
	if got.Clip == nil || len(got.Pieces) != 4 {
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
	// every gap is long: no steady stretch to judge pauses by, nothing cut
	if c.SendingS != 250 {
		t.Fatalf("sending %.0f s", c.SendingS)
	}
	// numbers that don't run forward say nothing: back to what was heard
	if span, _ := piecesSpanned([]pieceAt{{index: 5, bytes: 1, at: t0}, {index: 5, bytes: 1, at: t0.Add(time.Second)}}); span != 0 {
		t.Fatalf("span %d", span)
	}
}

// Today's 7-hop clip as Rainier View heard it: steady at about a piece every
// 1.2 s, with two long waits. The waits are cut to the usual pace.
func TestSendingSeconds(t *testing.T) {
	t0 := time.Date(2026, 11, 22, 17, 48, 47, 0, time.UTC)
	at := func(m, s int) time.Time { return t0.Add(time.Duration(m*60+s) * time.Second) }
	ps := []pieceAt{
		{121, 163, at(0, 0)}, {124, 163, at(0, 20)}, {143, 163, at(0, 33)}, {140, 163, at(0, 36)}, {147, 163, at(0, 42)},
		{163, 163, at(0, 49)}, {168, 163, at(0, 58)}, {171, 163, at(1, 0)}, {188, 163, at(2, 18)}, {198, 163, at(2, 26)},
		{201, 163, at(2, 27)}, {218, 163, at(2, 58)}, {219, 163, at(3, 3)}, {225, 163, at(3, 3)}, {220, 163, at(3, 5)},
		{228, 163, at(3, 5)}, {239, 163, at(4, 2)}, {243, 163, at(4, 3)}, {253, 163, at(4, 12)}, {4, 163, at(4, 16)},
		{248, 163, at(4, 17)}, {9, 163, at(4, 24)},
	}
	whole := 264.0
	got := sendingSeconds(ps)
	if got >= whole-60 || got <= 60 {
		t.Fatalf("sending %.0f s of %.0f", got, whole)
	}
	span, size := piecesSpanned(ps)
	if span != 144 {
		t.Fatalf("span %d: the late 248 is no wrap", span)
	}
	if k := float64(span*size) * 8 / got / 1000; k < 1.2 || k > 1.6 {
		t.Fatalf("%.2f kbit/s while sending over %.0f s", k, got)
	}
	if sendingSeconds(ps[:1]) != 0 {
		t.Fatal("one piece")
	}
}

// Fast MediaMesh's repair pieces (sid ^ 0x0F0DEC0D, by seed) mend any lost
// pieces, one each, whichever they are; a repeated seed counts once.
func TestRepairPiecesRebuild(t *testing.T) {
	t0 := time.Date(2026, 11, 22, 21, 54, 0, 0, time.UTC)
	anns := []mediaClipAnn{{sid: 0xfdb6c3b8, kind: "photo", total: 18, at: t0}, {sid: 0x00000002, kind: "photo", total: 18, at: t0}}
	var p []mediaClipPiece
	add := func(sid uint32, info, sec int) {
		p = append(p, mediaClipPiece{sid: sid, info: info, bytes: 163, observer: "far", obsName: "far", path: []string{"aa", "bb"}, at: t0.Add(time.Duration(sec) * time.Second)})
	}
	// clip 1: 14 of 18 heard, then 4 repair pieces (one twice)
	for i := 0; i < 18; i++ {
		if i != 3 && i != 7 && i != 11 && i != 15 {
			add(0xfdb6c3b8, i, i)
		}
	}
	for _, seed := range []int{40, 41, 41, 99, 120} {
		add(0xfdb6c3b8^mediaClipRepairXor, seed, 30)
	}
	// clip 2: 10 of 18 heard and 3 repair pieces: not enough
	for i := 0; i < 10; i++ {
		add(2, i, i)
	}
	for _, seed := range []int{1, 2, 3} {
		add(2^mediaClipRepairXor, seed, 30)
	}
	by := map[string]MediaMeshClip{}
	for _, c := range analyseMediaClips(anns, p) {
		by[c.SID] = c
	}
	if c := by["fdb6c3b8"]; c.Outcome != "parity" || len(c.Rebuilt) != 4 || c.Parity != 4 || c.Heard != 14 || len(c.Missing) != 0 {
		t.Fatalf("clip 1: %+v", c)
	}
	if c := by["00000002"]; c.Outcome != "partial" || len(c.Missing) != 8 || c.Parity != 3 {
		t.Fatalf("clip 2: %+v", c)
	}
	// repair pieces of an announced clip are no clip sent privately
	if u := unannouncedMediaClips(anns, p); len(u) != 0 {
		t.Fatalf("unannounced: %+v", u)
	}
	// and a private clip's repair pieces count as its parity, not a clip of their own
	var q []mediaClipPiece
	for i := 0; i < 5; i++ {
		q = append(q, mediaClipPiece{sid: 0xA1B2C3D4, info: i, bytes: 163, observer: "far", path: []string{"aa"}, at: t0.Add(time.Duration(i) * time.Second)})
	}
	q = append(q, mediaClipPiece{sid: 0xA1B2C3D4 ^ mediaClipRepairXor, info: 7, bytes: 163, observer: "far", path: []string{"aa"}, at: t0.Add(9 * time.Second)})
	q = append(q, mediaClipPiece{sid: 0xA1B2C3D4 ^ mediaClipRepairXor, info: 8, bytes: 163, observer: "far", path: []string{"aa"}, at: t0.Add(10 * time.Second)})
	u := unannouncedMediaClips(nil, q)
	if len(u) != 1 || u[0].SID != "a1b2c3d4" || u[0].Parity != 2 || u[0].Heard != 5 {
		t.Fatalf("private: %+v", u)
	}
}

// Repair pieces sent long after a clip was whole (for other listeners) don't
// stretch its time: it's timed to when the far end could have it whole, and
// sized as the whole clip, rebuilt pieces included.
func TestClipTimedToWhole(t *testing.T) {
	t0 := time.Date(2026, 11, 22, 21, 17, 0, 0, time.UTC)
	anns := []mediaClipAnn{{sid: 5, kind: "voice", total: 3, at: t0}, {sid: 6, kind: "photo", total: 4, at: t0}}
	var p []mediaClipPiece
	add := func(sid uint32, info, sec int) {
		p = append(p, mediaClipPiece{sid: sid, info: info, bytes: 150, observer: "far", obsName: "far", path: []string{"aa"}, at: t0.Add(time.Duration(sec) * time.Second)})
	}
	add(5, 0, 0)
	add(5, 1, 1)
	add(5, 2, 2)
	for i := 0; i < 60; i++ {
		add(5^mediaClipRepairXor, i, 10+i*40)
	}
	// 6: pieces 0 and 2 at 0 and 2 s, then repair pieces at 5 and 9 s make it whole, more at 600 s
	add(6, 0, 0)
	add(6, 2, 2)
	add(6^mediaClipRepairXor, 1, 5)
	add(6^mediaClipRepairXor, 2, 9)
	add(6^mediaClipRepairXor, 3, 600)
	by := map[string]MediaMeshClip{}
	for _, c := range analyseMediaClips(anns, p) {
		by[c.SID] = c
	}
	if c := by["00000005"]; c.Outcome != "whole" || c.DurationS != 2 || c.Bytes != 450 || c.RateBytes != 300 || c.BytesEstimated {
		t.Fatalf("voice: %+v", c)
	}
	if c := by["00000006"]; c.Outcome != "parity" || c.DurationS != 9 || c.Bytes != 600 || !c.BytesEstimated || c.RateBytes != 450 || c.SendingS != 9 {
		t.Fatalf("photo: %+v", c)
	}
}
