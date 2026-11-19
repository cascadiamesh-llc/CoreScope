package main

import (
	"testing"
	"time"
)

// Channel data the analyzer can't read is media only in a burst; readable
// channel data only of the media type; raw clip packets always.
func TestMediaMeshIsMedia(t *testing.T) {
	withMediaMesh(t)
	base := time.Date(2026, 11, 19, 10, 0, 0, 0, time.UTC)
	grp, raw := mediaPayloadGrpData, mediaPayloadRawCustom
	id := 0
	mk := func(pt *int, decoded string, sec int, onMM bool) *StoreTx {
		id++
		if onMM {
			mediaMeshMu.Lock()
			mediaMeshObs[id] = struct{}{}
			mediaMeshMu.Unlock()
		}
		return &StoreTx{ID: id, PayloadType: pt, DecodedJSON: decoded, FirstSeen: base.Add(time.Duration(sec) * time.Second).Format(time.RFC3339),
			Observations: []*StoreObs{{ID: id}}}
	}
	burst := []*StoreTx{mk(&grp, `{"channelHash":100}`, 0, true), mk(&grp, `{"channelHash":100}`, 20, true), mk(&grp, `{"channelHash":100}`, 50, true)}
	team := []*StoreTx{mk(&grp, `{"channelHash":230}`, 0, true), mk(&grp, `{"channelHash":230}`, 600, true), mk(&grp, `{"channelHash":230}`, 1200, true)}
	pair := []*StoreTx{mk(&grp, `{"channelHash":7}`, 0, true), mk(&grp, `{"channelHash":7}`, 4, true)}
	// not on radio2: doesn't help another packet make a burst
	mainOnly := mk(&grp, `{"channelHash":7}`, 10, false)
	readMedia := mk(&grp, `{"channelHash":100,"dataType":22083,"decryptedBlob":"56eeb59589d8"}`, 0, true)
	readOther := mk(&grp, `{"channelHash":100,"dataType":1}`, 0, true)
	clip := mk(&raw, `{"raw":"561a2b3c4d00"}`, 0, true)
	s := &PacketStore{}
	s.packets = append(append(append(append(s.packets, burst...), team...), pair...), mainOnly, readMedia, readOther, clip)
	s.mu.RLock()
	mediaMeshMu.RLock()
	b := s.mediaMeshBurstsLocked("")
	mediaMeshMu.RUnlock()
	s.mu.RUnlock()
	for i, tx := range burst {
		if !mediaMeshIsMedia(tx, b) {
			t.Errorf("burst %d: not media", i)
		}
	}
	for i, tx := range append(append(team, pair...), readOther) {
		if mediaMeshIsMedia(tx, b) {
			t.Errorf("%d (%s): media", i, tx.DecodedJSON)
		}
	}
	if !mediaMeshIsMedia(readMedia, b) || !mediaMeshIsMedia(clip, b) {
		t.Error("readable media and raw clip packets are media")
	}
	if got := s.mediaMeshBurstsLocked(base.Add(30 * time.Second).Format(time.RFC3339)); len(got) != 0 {
		t.Errorf("since cuts the burst short: %d", len(got))
	}
}
