package main

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// MediaMesh (radio2): observers tag what used it; see mediamesh.go and
// internal/dbschema/mediamesh.go.

// A flood ADVERT with an empty path: the advertiser is the node that sent it.
const mediaMeshAdvertHex = "120046D62DE27D4C5194D7821FC5A34A45565DCC2537B300B9AB6275255CEFB65D840CE5C169C94C9AED39E8BCB6CB6EB0335497A198B33A1A610CD3B03D8DCFC160900E5244280323EE0B44CACAB8F02B5B38B91CFA18BD067B0B5E63E94CFC85F758A8530B9240933402E0E6B8F84D5252322D52"
const mediaMeshAdvertPubkey = "46d62de27d4c5194d7821fc5a34a45565dcc2537b300b9ab6275255cefb65d84"

func mmCountRows(t *testing.T, s *Store, query string, args ...interface{}) int {
	t.Helper()
	var n int
	if err := s.db.QueryRow(query, args...).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func nodeMediaMesh(t *testing.T, s *Store, pubkey string) (mode, radio, source string, ok bool) {
	t.Helper()
	var r *string
	err := s.db.QueryRow(`SELECT mode, radio, source FROM node_mediamesh WHERE public_key = ?`, pubkey).
		Scan(&mode, &r, &source)
	if err != nil {
		return "", "", "", false
	}
	if r != nil {
		radio = *r
	}
	return mode, radio, source, true
}

func TestMediaMeshFlag(t *testing.T) {
	for _, tc := range []struct {
		payload string
		want    bool
	}{
		{`{"mediamesh":true}`, true},
		{`{"mediamesh":false}`, false},
		{`{"mediamesh":"true"}`, true},
		{`{"mediamesh":"1"}`, true},
		{`{"mediamesh":1}`, true},
		{`{"mediamesh":"yes"}`, false},
		{`{}`, false},
	} {
		var msg map[string]interface{}
		if err := json.Unmarshal([]byte(tc.payload), &msg); err != nil {
			t.Fatal(err)
		}
		if got := mediaMeshFlag(msg); got != tc.want {
			t.Errorf("%s: got %v, want %v", tc.payload, got, tc.want)
		}
	}
}

func TestHandleMessageMediaMeshPacket(t *testing.T) {
	store, source := newTestContext(t)
	msg := &mockMessage{
		topic: "meshcore/SEA/obs1/packets",
		payload: []byte(`{"raw":"` + mediaMeshAdvertHex + `","direction":"rx","SNR":"9.5","RSSI":"-71",` +
			`"rx_radio_id":"radio2","mediamesh":true}`),
	}
	handleMessage(store, "test", source, msg, nil, nil, &Config{})

	if n := mmCountRows(t, store, `SELECT COUNT(*) FROM observation_mediamesh`); n != 1 {
		t.Fatalf("observation_mediamesh rows = %d, want 1", n)
	}
	var radioID string
	if err := store.db.QueryRow(`SELECT radio_id FROM observation_radios`).Scan(&radioID); err != nil || radioID != "radio2" {
		t.Fatalf("observation_radios radio_id = %q (%v), want radio2", radioID, err)
	}
	// The advertiser sent it on radio2: heard, so it transmits there.
	mode, _, src, ok := nodeMediaMesh(t, store, mediaMeshAdvertPubkey)
	if !ok || mode != "rxtx" || src != "heard" {
		t.Fatalf("node_mediamesh = %q/%q (%v), want rxtx/heard", mode, src, ok)
	}
}

// Every observer before this change: nothing new is written.
func TestHandleMessageWithoutMediaMeshWritesNothing(t *testing.T) {
	store, source := newTestContext(t)
	msg := &mockMessage{
		topic:   "meshcore/SEA/obs1/packets",
		payload: []byte(`{"raw":"` + mediaMeshAdvertHex + `","direction":"rx","SNR":"9.5","RSSI":"-71"}`),
	}
	handleMessage(store, "test", source, msg, nil, nil, &Config{})
	if n := mmCountRows(t, store, `SELECT COUNT(*) FROM transmissions`); n != 1 {
		t.Fatalf("transmissions = %d, want 1", n)
	}
	for _, table := range []string{"observation_mediamesh", "node_mediamesh", "observation_radios"} {
		if n := mmCountRows(t, store, `SELECT COUNT(*) FROM `+table); n != 0 {
			t.Errorf("%s rows = %d, want 0", table, n)
		}
	}
}

// A packet the observer sent on radio2 is MediaMesh, and the observer runs
// MediaMesh both ways: it sent on radio2.
func TestHandleMessageMediaMeshTxMarksObserver(t *testing.T) {
	store, source := newTestContext(t)
	obs := strings.Repeat("d", 64)
	msg := &mockMessage{
		topic: "meshcore/SEA/" + strings.ToUpper(obs) + "/packets",
		payload: []byte(`{"raw":"` + mediaMeshAdvertHex + `","direction":"tx",` +
			`"tx_radio_id":"radio2","mediamesh":true}`),
	}
	handleMessage(store, "test", source, msg, nil, nil, &Config{})
	if n := mmCountRows(t, store, `SELECT COUNT(*) FROM observation_mediamesh`); n != 1 {
		t.Fatalf("observation_mediamesh rows = %d, want 1", n)
	}
	if n := mmCountRows(t, store, `SELECT COUNT(*) FROM observation_radios WHERE radio_id = 'radio2'`); n != 1 {
		t.Fatalf("tx_radio_id not kept")
	}
	var mode, src string
	err := store.db.QueryRow(`SELECT mode, source FROM node_mediamesh WHERE public_key = ?`, obs).Scan(&mode, &src)
	if err != nil || mode != "rxtx" || src != "heard" {
		t.Fatalf("observer node_mediamesh = %q/%q (%v), want rxtx/heard", mode, src, err)
	}
	if n := mmCountRows(t, store, `SELECT COUNT(*) FROM node_mediamesh`); n != 1 {
		t.Errorf("node_mediamesh rows = %d, want only the observer", n)
	}
}

// An observer id that is not a public key names nobody.
func TestHandleMessageMediaMeshTxNonKeyObserver(t *testing.T) {
	store, source := newTestContext(t)
	msg := &mockMessage{
		topic: "meshcore/SEA/obs1/packets",
		payload: []byte(`{"raw":"` + mediaMeshAdvertHex + `","direction":"tx",` +
			`"tx_radio_id":"radio2","mediamesh":true}`),
	}
	handleMessage(store, "test", source, msg, nil, nil, &Config{})
	if n := mmCountRows(t, store, `SELECT COUNT(*) FROM observation_mediamesh`); n != 1 {
		t.Fatalf("observation_mediamesh rows = %d, want 1", n)
	}
	if n := mmCountRows(t, store, `SELECT COUNT(*) FROM node_mediamesh`); n != 0 {
		t.Errorf("node_mediamesh rows = %d, want 0", n)
	}
}

func TestMediaMeshSender(t *testing.T) {
	a := strings.Repeat("a", 64)
	b := strings.Repeat("b", 64)
	rx, tx := "rx", "tx"
	flood := &PacketData{PayloadType: 4, RouteType: 1, PathJSON: `["aa","bb"]`, Direction: &rx}
	if got := mediaMeshSender(flood, []*string{&a, &b}); got != b {
		t.Errorf("flood: sender %q, want the last hop", got)
	}
	if got := mediaMeshSender(flood, []*string{&a, nil}); got != "" {
		t.Errorf("unresolved last hop: sender %q, want none", got)
	}
	empty := &PacketData{PayloadType: 4, RouteType: 1, PathJSON: `[]`, FromPubkey: strings.ToUpper(a), Direction: &rx}
	if got := mediaMeshSender(empty, nil); got != a {
		t.Errorf("empty path: sender %q, want the originator", got)
	}
	zeroHop := &PacketData{PayloadType: 4, RouteType: 2, PathJSON: `[]`, FromPubkey: a, Direction: &rx}
	if got := mediaMeshSender(zeroHop, nil); got != a {
		t.Errorf("zero-hop direct: sender %q, want the originator", got)
	}
	lastLeg := &PacketData{PayloadType: 2, RouteType: 2, PathJSON: `[]`, FromPubkey: a, Direction: &rx}
	if got := mediaMeshSender(lastLeg, nil); got != "" {
		t.Errorf("direct TXT_MSG with an empty path may come from the last repeater: sender %q, want none", got)
	}
	direct := &PacketData{PayloadType: 4, RouteType: 2, PathJSON: `["aa"]`, Direction: &rx}
	if got := mediaMeshSender(direct, []*string{&a}); got != "" {
		t.Errorf("direct route: sender %q, want none", got)
	}
	sent := &PacketData{PayloadType: 4, RouteType: 1, PathJSON: `["aa"]`, Direction: &tx, ObserverID: strings.ToUpper(b)}
	if got := mediaMeshSender(sent, []*string{&a}); got != b {
		t.Errorf("tx: sender %q, want the observer itself", got)
	}
}

func TestStatusRadiosMarksObserverNode(t *testing.T) {
	store, source := newTestContext(t)
	obs := strings.Repeat("c", 64)
	now := time.Now().UTC().Format("2006-01-02T15:04:05.000000+00:00")
	msg := &mockMessage{
		topic: "meshcore/SEA/" + strings.ToUpper(obs) + "/status",
		payload: []byte(`{"status":"online","timestamp":"` + now + `","origin":"First Hill",` +
			`"origin_id":"` + strings.ToUpper(obs) + `","radio":"910.525000,62.5,7,5",` +
			`"radios":[{"id":"radio2","radio":"911.150000,250.0,7,5","mode":"rxtx","mediamesh":true,"temporary":false}]}`),
	}
	handleMessage(store, "test", source, msg, nil, nil, &Config{})
	mode, radio, src, ok := nodeMediaMesh(t, store, obs)
	if !ok || mode != "rxtx" || radio != "911.15,250,7,5" || src != "status" {
		t.Fatalf("node_mediamesh = %q %q %q (%v), want rxtx 911.15,250,7,5 status", mode, radio, src, ok)
	}
	// The #1869 radio history also gets the radio2 setting under its id.
	if n := mmCountRows(t, store, `SELECT COUNT(*) FROM observer_radios WHERE radio_id = 'radio2'`); n != 1 {
		t.Errorf("observer_radios radio2 rows = %d, want 1", n)
	}
}

func TestNeighborsReportRadio2(t *testing.T) {
	store := openNeighborsStore(t)
	self := strings.Repeat("d", 64)
	on := strings.Repeat("e", 64)
	off := strings.Repeat("f", 64)
	unknown := strings.Repeat("1", 64)
	msg := map[string]interface{}{
		"timestamp": "2026-10-29T08:00:00Z",
		"origin_id": strings.ToUpper(self),
		"self": map[string]interface{}{"scopes": "sea", "default_scope": "*",
			"radio2": map[string]interface{}{"mode": "rxtx", "radio": "910.525000,250.0,7,5", "temporary": false}},
		"neighbors": []interface{}{
			map[string]interface{}{"pubkey": strings.ToUpper(on), "status": "timeout",
				"radio2": map[string]interface{}{"mode": "rx", "radio": "911.150000,250.0,7,5", "temporary": true}},
			map[string]interface{}{"pubkey": off, "status": "responded", "scopes": "sea",
				"radio2": map[string]interface{}{"mode": "off"}},
			map[string]interface{}{"pubkey": unknown, "status": "responded", "scopes": "sea"},
			map[string]interface{}{"pubkey": "not-hex", "radio2": map[string]interface{}{"mode": "rx"}},
		},
	}
	handleNeighborsReport(store, "test", self, msg)

	if mode, radio, src, ok := nodeMediaMesh(t, store, self); !ok || mode != "rxtx" || radio != "910.525,250,7,5" || src != "status" {
		t.Errorf("self = %q %q %q (%v)", mode, radio, src, ok)
	}
	if mode, radio, src, ok := nodeMediaMesh(t, store, on); !ok || mode != "rx" || radio != "911.15,250,7,5" || src != "neighbor" {
		t.Errorf("on = %q %q %q (%v)", mode, radio, src, ok)
	}
	if mode, radio, _, ok := nodeMediaMesh(t, store, off); !ok || mode != "off" || radio != "" {
		t.Errorf("off = %q %q (%v)", mode, radio, ok)
	}
	if _, _, _, ok := nodeMediaMesh(t, store, unknown); ok {
		t.Errorf("a neighbour without radio2 is unknown, not stored")
	}
	if n := mmCountRows(t, store, `SELECT COUNT(*) FROM node_mediamesh`); n != 3 {
		t.Errorf("node_mediamesh rows = %d, want 3", n)
	}
}

func TestRecordMediaMeshNewestWins(t *testing.T) {
	s := newTestStore(t)
	pk := strings.Repeat("a", 64)
	t0 := time.Date(2026, 10, 29, 8, 0, 0, 0, time.UTC)
	must := func(r MediaMeshReport, at time.Time) {
		t.Helper()
		if err := s.RecordMediaMesh(r, at); err != nil {
			t.Fatal(err)
		}
	}
	must(MediaMeshReport{PubKey: pk, Mode: "rx", Radio: "911.15,250,7,5", Source: "neighbor"}, t0)
	// Heard sending: rxtx, keeps the radio it reported.
	must(MediaMeshReport{PubKey: pk, Mode: "rxtx", Source: "heard"}, t0.Add(time.Minute))
	if mode, radio, src, _ := nodeMediaMesh(t, s, pk); mode != "rxtx" || radio != "911.15,250,7,5" || src != "heard" {
		t.Fatalf("after heard: %q %q %q", mode, radio, src)
	}
	// An older report does not overwrite a newer one.
	must(MediaMeshReport{PubKey: pk, Mode: "off", Source: "neighbor"}, t0)
	if mode, _, _, _ := nodeMediaMesh(t, s, pk); mode != "rxtx" {
		t.Fatalf("older report won: %q", mode)
	}
	// A newer "off" clears it, radio included.
	must(MediaMeshReport{PubKey: pk, Mode: "off", Source: "neighbor"}, t0.Add(2*time.Minute))
	if mode, radio, _, _ := nodeMediaMesh(t, s, pk); mode != "off" || radio != "" {
		t.Fatalf("off: %q %q", mode, radio)
	}
}

func TestMediaMeshHeardDebounce(t *testing.T) {
	var h mediaMeshHeard
	t0 := time.Date(2026, 10, 29, 8, 0, 0, 0, time.UTC)
	if !h.due("a", t0) || h.due("a", t0.Add(30*time.Second)) || !h.due("b", t0) {
		t.Fatal("debounce within a minute per node")
	}
	if !h.due("a", t0.Add(61*time.Second)) {
		t.Fatal("due again after a minute")
	}
}

func TestPruneMediaMesh(t *testing.T) {
	store, source := newTestContext(t)
	msg := &mockMessage{
		topic:   "meshcore/SEA/obs1/packets",
		payload: []byte(`{"raw":"` + mediaMeshAdvertHex + `","direction":"rx","rx_radio_id":"radio2","mediamesh":true}`),
	}
	handleMessage(store, "test", source, msg, nil, nil, &Config{})
	if _, err := store.db.Exec(`UPDATE transmissions SET first_seen = '2020-01-01T00:00:00Z'`); err != nil {
		t.Fatal(err)
	}
	if _, err := store.PruneOldPackets(1); err != nil {
		t.Fatal(err)
	}
	if n := mmCountRows(t, store, `SELECT COUNT(*) FROM observation_mediamesh`); n != 0 {
		t.Errorf("observation_mediamesh rows = %d after prune, want 0", n)
	}
	if _, err := store.db.Exec(`UPDATE node_mediamesh SET last_seen = '2020-01-01T00:00:00Z'`); err != nil {
		t.Fatal(err)
	}
	if n, err := store.PruneMediaMeshNodes(time.Now()); err != nil || n != 1 {
		t.Errorf("PruneMediaMeshNodes = %d (%v), want 1", n, err)
	}
}

func TestMediaMeshRelayers(t *testing.T) {
	a, b, c := strings.Repeat("a", 64), strings.Repeat("b", 64), strings.Repeat("c", 64)
	rx, tx := "rx", "tx"
	// Received flood a -> b -> c (2-byte hashes): c is the forwarder heard
	// (the sender mark); a and b relayed it before.
	flood := &PacketData{PayloadType: 6, RouteType: 1, PathJSON: `["aaaa","bbbb","cccc"]`, Direction: &rx}
	got := mediaMeshRelayers(flood, []*string{&a, &b, &c})
	if strings.Join(got, ",") != a+","+b {
		t.Errorf("rx flood: relayers %v, want a,b", got)
	}
	// An unresolved (ambiguous) hop is skipped, the others still count.
	if got := mediaMeshRelayers(flood, []*string{nil, &b, &c}); strings.Join(got, ",") != b {
		t.Errorf("ambiguous hop: relayers %v, want b", got)
	}
	// 1-byte hashes are shared by too many repeaters: never relayed evidence.
	oneByte := &PacketData{PayloadType: 6, RouteType: 1, PathJSON: `["aa","bb","cc"]`, Direction: &rx}
	if got := mediaMeshRelayers(oneByte, []*string{&a, &b, &c}); len(got) != 0 {
		t.Errorf("1-byte hops: relayers %v, want none", got)
	}
	// 3-byte hashes count.
	threeByte := &PacketData{PayloadType: 6, RouteType: 1, PathJSON: `["aaaaaa","cccccc"]`, Direction: &rx}
	if got := mediaMeshRelayers(threeByte, []*string{&a, &c}); strings.Join(got, ",") != a {
		t.Errorf("3-byte hops: relayers %v, want a", got)
	}
	// One hop: only the heard forwarder, no earlier relayers.
	one := &PacketData{PayloadType: 6, RouteType: 1, PathJSON: `["cccc"]`, Direction: &rx}
	if got := mediaMeshRelayers(one, []*string{&c}); len(got) != 0 {
		t.Errorf("one hop: relayers %v, want none", got)
	}
	// Transport (scoped) floods count like floods: #mediamesh is a scope.
	scoped := &PacketData{PayloadType: 6, RouteType: 0, PathJSON: `["aaaa","cccc"]`, Direction: &rx}
	if got := mediaMeshRelayers(scoped, []*string{&a, &c}); strings.Join(got, ",") != a {
		t.Errorf("transport flood: relayers %v, want a", got)
	}
	// A direct route's path is the route still to travel: nothing.
	direct := &PacketData{PayloadType: 6, RouteType: 2, PathJSON: `["aaaa","bbbb"]`, Direction: &rx}
	if got := mediaMeshRelayers(direct, []*string{&a, &b}); len(got) != 0 {
		t.Errorf("direct route: relayers %v, want none", got)
	}
	// Sent by the observer c: every hop but its own, appended when forwarding.
	sent := &PacketData{PayloadType: 6, RouteType: 1, PathJSON: `["aaaa","bbbb","cccc"]`, Direction: &tx, ObserverID: strings.ToUpper(c)}
	if got := mediaMeshRelayers(sent, []*string{&a, &b, &c}); strings.Join(got, ",") != a+","+b {
		t.Errorf("tx flood: relayers %v, want a,b", got)
	}
	// Path and resolution out of step: no guesses.
	if got := mediaMeshRelayers(flood, []*string{&a, &b}); len(got) != 0 {
		t.Errorf("mismatched resolution: relayers %v, want none", got)
	}
}

func TestMediaMeshRelaySightingsNeedTwoPackets(t *testing.T) {
	var m mediaMeshRelaySightings
	t0 := time.Date(2026, 11, 10, 8, 0, 0, 0, time.UTC)
	if m.confirmed("a", "pkt1", t0) {
		t.Fatal("first sighting confirmed a mark")
	}
	if m.confirmed("a", "pkt1", t0.Add(time.Minute)) {
		t.Fatal("the same packet again (another observation of it) confirmed a mark")
	}
	if !m.confirmed("a", "pkt2", t0.Add(time.Hour)) {
		t.Fatal("a second, different packet within 2 days did not confirm")
	}
	if m.confirmed("b", "", t0) || m.confirmed("b", "", t0.Add(time.Hour)) {
		t.Fatal("packets without a hash confirmed a mark")
	}
	// Sightings more than 2 days apart start over.
	if m.confirmed("c", "pkt1", t0) || m.confirmed("c", "pkt2", t0.Add(49*time.Hour)) {
		t.Fatal("sightings more than 2 days apart confirmed a mark")
	}
	if !m.confirmed("c", "pkt3", t0.Add(50*time.Hour)) {
		t.Fatal("a fresh pair within 2 days did not confirm")
	}
}

func TestRecordMediaMeshRelayedIsWeakest(t *testing.T) {
	s := newTestStore(t)
	t0 := time.Date(2026, 11, 10, 8, 0, 0, 0, time.UTC)
	fresh, own, off := strings.Repeat("a", 64), strings.Repeat("b", 64), strings.Repeat("c", 64)

	// No mark yet: relayed adds one.
	if err := s.RecordMediaMeshRelayed(fresh, t0); err != nil {
		t.Fatal(err)
	}
	if mode, radio, src, ok := nodeMediaMesh(t, s, fresh); !ok || mode != "rxtx" || radio != "" || src != "relayed" {
		t.Fatalf("new relayed mark: %q %q %q (%v)", mode, radio, src, ok)
	}
	// Stronger evidence replaces a relayed mark.
	if err := s.RecordMediaMesh(MediaMeshReport{PubKey: fresh, Mode: "rxtx", Source: "heard"}, t0.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	if _, _, src, _ := nodeMediaMesh(t, s, fresh); src != "heard" {
		t.Fatalf("heard did not replace relayed: %q", src)
	}

	// The node's own report, with its radio: a later relayed sighting keeps it.
	if err := s.RecordMediaMesh(MediaMeshReport{PubKey: own, Mode: "rx", Radio: "911.15,250,7,5", Source: "status"}, t0); err != nil {
		t.Fatal(err)
	}
	if err := s.RecordMediaMeshRelayed(own, t0.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if mode, radio, src, _ := nodeMediaMesh(t, s, own); mode != "rx" || radio != "911.15,250,7,5" || src != "status" {
		t.Fatalf("relayed overwrote the node's own report: %q %q %q", mode, radio, src)
	}

	// A report that radio2 is off is not turned back on by a relayed sighting.
	if err := s.RecordMediaMesh(MediaMeshReport{PubKey: off, Mode: "off", Source: "neighbor"}, t0); err != nil {
		t.Fatal(err)
	}
	if err := s.RecordMediaMeshRelayed(off, t0.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if mode, _, src, _ := nodeMediaMesh(t, s, off); mode != "off" || src != "neighbor" {
		t.Fatalf("relayed overrode an off report: %q %q", mode, src)
	}

	// A relayed mark is refreshed by later sightings, never moved back.
	later := t0.Add(2 * time.Hour)
	other := strings.Repeat("d", 64)
	for _, at := range []time.Time{t0, later, t0.Add(time.Hour)} {
		if err := s.RecordMediaMeshRelayed(other, at); err != nil {
			t.Fatal(err)
		}
	}
	var seen string
	if err := s.db.QueryRow(`SELECT last_seen FROM node_mediamesh WHERE public_key = ?`, other).Scan(&seen); err != nil {
		t.Fatal(err)
	}
	if seen != later.Format(time.RFC3339) {
		t.Fatalf("relayed last_seen = %s, want %s", seen, later.Format(time.RFC3339))
	}
}

func TestNoteMediaMeshObservationMarksWholePath(t *testing.T) {
	s := newTestStore(t)
	a, b, c := strings.Repeat("a", 64), strings.Repeat("b", 64), strings.Repeat("c", 64)
	rx := "rx"
	packet := func(hash string) *PacketData {
		return &PacketData{
			PayloadType: 6, RouteType: 1, PathJSON: `["aaaa","bbbb","cccc"]`, Direction: &rx,
			ObserverID: strings.Repeat("e", 64), MediaMesh: true, Hash: hash,
		}
	}
	resolved := []*string{&a, &b, &c}

	// First packet: the heard forwarder is marked, the earlier hops are not yet.
	s.noteMediaMeshObservation(1, 1, packet("pkt1"), resolved)
	s.ProcessMediaMeshRelays(time.Now().Add(mediaMeshRelayDelay + time.Second))
	if _, _, src, ok := nodeMediaMesh(t, s, c); !ok || src != "heard" {
		t.Fatalf("heard forwarder: %q (%v), want heard", src, ok)
	}
	for _, pk := range []string{a, b} {
		if _, _, _, ok := nodeMediaMesh(t, s, pk); ok {
			t.Fatalf("%s… marked after a single packet", pk[:4])
		}
	}
	// A second, different packet over the same path confirms them.
	s.noteMediaMeshObservation(2, 2, packet("pkt2"), resolved)
	if n := mmCountRows(t, s, `SELECT COUNT(*) FROM node_mediamesh WHERE source = 'relayed'`); n != 0 {
		t.Fatalf("%d relayed marks before the main-mesh check ran", n)
	}
	s.ProcessMediaMeshRelays(time.Now().Add(mediaMeshRelayDelay + time.Second))
	for _, pk := range []string{a, b} {
		if mode, _, src, ok := nodeMediaMesh(t, s, pk); !ok || mode != "rxtx" || src != "relayed" {
			t.Errorf("%s…: %q %q (%v), want rxtx/relayed", pk[:4], mode, src, ok)
		}
	}
	// Not MediaMesh: nothing at all.
	s2 := newTestStore(t)
	for i, h := range []string{"pkt1", "pkt2"} {
		plain := packet(h)
		plain.MediaMesh = false
		s2.noteMediaMeshObservation(int64(i+1), int64(i+1), plain, resolved)
		s2.ProcessMediaMeshRelays(time.Now().Add(mediaMeshRelayDelay + time.Second))
	}
	if n := mmCountRows(t, s2, `SELECT COUNT(*) FROM node_mediamesh`); n != 0 {
		t.Fatalf("non-MediaMesh packets wrote %d marks", n)
	}
}

func TestPruneRelayedMarksAfterTwoDays(t *testing.T) {
	s := newTestStore(t)
	now := time.Date(2026, 11, 10, 8, 0, 0, 0, time.UTC)
	relayedOld, relayedFresh, heardOld := strings.Repeat("a", 64), strings.Repeat("b", 64), strings.Repeat("c", 64)
	if err := s.RecordMediaMeshRelayed(relayedOld, now.Add(-49*time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err := s.RecordMediaMeshRelayed(relayedFresh, now.Add(-47*time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err := s.RecordMediaMesh(MediaMeshReport{PubKey: heardOld, Mode: "rxtx", Source: "heard"}, now.Add(-49*time.Hour)); err != nil {
		t.Fatal(err)
	}
	if n, err := s.PruneMediaMeshNodes(now); err != nil || n != 1 {
		t.Fatalf("PruneMediaMeshNodes = %d (%v), want 1 (the old relayed mark)", n, err)
	}
	if _, _, _, ok := nodeMediaMesh(t, s, relayedOld); ok {
		t.Error("relayed mark older than 2 days survived")
	}
	if _, _, _, ok := nodeMediaMesh(t, s, relayedFresh); !ok {
		t.Error("relayed mark under 2 days old was pruned")
	}
	if _, _, _, ok := nodeMediaMesh(t, s, heardOld); !ok {
		t.Error("a heard mark was pruned at 2 days; it keeps 30")
	}
}

// The false positives of v3.16.0-mediamesh.5: a repeater with radio2.cross on
// forwarded a main-mesh flood onto radio2, and every main-mesh hop before it
// was marked. Path from packet fde901b6ff4b7c9e, heard by Rainier View on
// both radios a second apart.
func TestMainMeshPathPrefixCrossedFlood(t *testing.T) {
	radio2 := []string{"99DBE4", "CE9A20", "C4C2A7", "149BBA", "D3C496", "FBA9FE", "5CBBEE", "5E12EE", "1C0D4D", "3D43BD", "5CBBEE", "62CCBF"}
	mains := [][]string{
		{"99DBE4", "CE9A20", "C4C2A7", "149BBA", "D3C496", "FBA9FE", "5CBBEE", "5E12EE", "1C0D4D", "3D43BD"},
		{"99DBE4", "CE9A20", "C4C2A7", "149BBA", "D3C496", "FBA9FE", "5CBBEE", "5E12EE", "1C0D4D", "3D43BD", "5CBBEE"},
		{"99DBE4", "CE9A20", "C4C2A7", "149BBA", "D3C496", "FBA9FE", "5CBBEE", "5E12EE", "1C0D4D", "3D43BD", "7D95D3", "705221"},
	}
	if got := mainMeshPathPrefix(radio2, mains); got != 11 {
		t.Fatalf("mainMeshPathPrefix = %d, want 11 (every hop before the crossing repeater)", got)
	}
	if got := mainMeshPathPrefix(radio2, nil); got != 0 {
		t.Fatalf("no main-mesh observations: %d, want 0", got)
	}
	if got := mainMeshPathPrefix([]string{"aaaa", "bbbb"}, [][]string{{"AAAA", "cccc"}}); got != 1 {
		t.Fatalf("case-insensitive prefix = %d, want 1", got)
	}
}

func TestRelayedMarksSkipHopsHeardOnMainMesh(t *testing.T) {
	s := newTestStore(t)
	a, b, c, d := strings.Repeat("a", 64), strings.Repeat("b", 64), strings.Repeat("c", 64), strings.Repeat("d", 64)
	rx := "rx"
	now := time.Now()
	for _, h := range []string{"pkt1", "pkt2"} {
		// The main mesh heard the packet through aaaa and bbbb.
		if _, err := s.InsertTransmission(&PacketData{
			Hash: h, RawHex: "1500", RouteType: 1, PayloadType: 5,
			PathJSON: `["aaaa","bbbb"]`, Direction: &rx, Timestamp: now.UTC().Format(time.RFC3339),
		}); err != nil {
			t.Fatal(err)
		}
		var txID int64
		if err := s.db.QueryRow(`SELECT id FROM transmissions WHERE hash = ?`, h).Scan(&txID); err != nil {
			t.Fatal(err)
		}
		// Then a repeater after bbbb put it on radio2: cccc relayed it there
		// and dddd is the forwarder the observer heard.
		s.noteMediaMeshObservation(0, txID, &PacketData{
			PayloadType: 5, RouteType: 1, PathJSON: `["aaaa","bbbb","cccc","dddd"]`, Direction: &rx,
			ObserverID: strings.Repeat("e", 64), MediaMesh: true, Hash: h,
		}, []*string{&a, &b, &c, &d})
	}
	s.ProcessMediaMeshRelays(now.Add(mediaMeshRelayDelay + time.Second))
	for _, pk := range []string{a, b} {
		if _, _, src, ok := nodeMediaMesh(t, s, pk); ok {
			t.Errorf("%s… marked %q, but it carried the packet on the main mesh", pk[:4], src)
		}
	}
	if _, _, src, ok := nodeMediaMesh(t, s, c); !ok || src != "relayed" {
		t.Errorf("cccc: %q (%v), want relayed", src, ok)
	}
	if _, _, src, ok := nodeMediaMesh(t, s, d); !ok || src != "heard" {
		t.Errorf("dddd: %q (%v), want heard", src, ok)
	}
}

func TestResetMediaMeshRelayedOnce(t *testing.T) {
	s := newTestStore(t)
	now := time.Now()
	relayed, heard := strings.Repeat("a", 64), strings.Repeat("b", 64)
	if err := s.RecordMediaMeshRelayed(relayed, now); err != nil {
		t.Fatal(err)
	}
	if err := s.RecordMediaMesh(MediaMeshReport{PubKey: heard, Mode: "rxtx", Source: "heard"}, now); err != nil {
		t.Fatal(err)
	}
	s.ResetMediaMeshRelayedOnce()
	if _, _, _, ok := nodeMediaMesh(t, s, relayed); ok {
		t.Error("old relayed mark survived the reset")
	}
	if _, _, _, ok := nodeMediaMesh(t, s, heard); !ok {
		t.Error("reset removed a heard mark")
	}
	// Runs once: marks made after it stay.
	if err := s.RecordMediaMeshRelayed(relayed, now); err != nil {
		t.Fatal(err)
	}
	s.ResetMediaMeshRelayedOnce()
	if _, _, _, ok := nodeMediaMesh(t, s, relayed); !ok {
		t.Error("second reset removed a new relayed mark")
	}
}
