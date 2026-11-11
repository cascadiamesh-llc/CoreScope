package main

import (
	"log"
	"strings"
	"sync"
	"time"

	"github.com/meshcore-analyzer/dbschema"
	"github.com/meshcore-analyzer/packetpath"
)

// MediaMesh: radio2, a second LoRa profile that Keymind Cascade repeaters,
// Wadamesh TAK standalones and MeshCore Open TAK use for photos and voice
// (schema and the observer contract: internal/dbschema/mediamesh.go). This
// file reads what observers say about it and records it:
//
//   - packets with `mediamesh: true` -> observation_mediamesh (sparse);
//   - the node that sent a MediaMesh packet an observer heard, a status
//     `radios[]` entry with `mediamesh: true`, and a neighbors report's
//     `radio2` -> node_mediamesh, newest evidence first.
//
// Every key is optional. A message without them (every observer before this
// change) is ingested exactly as before: nothing here writes for it.

const (
	mediaMeshModeOff  = "off"
	mediaMeshModeRx   = "rx"
	mediaMeshModeRxTx = "rxtx"

	mediaMeshSourceStatus   = "status"   // the node's own status message
	mediaMeshSourceNeighbor = "neighbor" // a zero-hop neighbour's report of it
	mediaMeshSourceHeard    = "heard"    // heard sending a MediaMesh packet
	// An earlier hop of a MediaMesh flood the observer heard: it forwarded the
	// packet on radio2 too. Weaker than the others (a repeater with
	// radio2.cross on can move a packet onto radio2 mid-path, after hops that
	// carried it on the main radio), so it never replaces them.
	mediaMeshSourceRelayed = "relayed"

	// A node heard sending on radio2 is re-stamped at most this often: a
	// photo is dozens of packets, and each would otherwise be an UPSERT.
	mediaMeshHeardDebounce = time.Minute
	// Bounds the debounce map (one entry per transmitting node); it is reset
	// when full, which costs at most one extra UPSERT per node.
	mediaMeshHeardMapMax = 8192
	// node_mediamesh rows not refreshed for this long are pruned.
	mediaMeshNodeRetention = 30 * 24 * time.Hour
	// Relayed marks (weaker evidence) are pruned sooner, and need two
	// different MediaMesh packets within this long before they are made.
	mediaMeshRelayedRetention = 2 * 24 * time.Hour
	// Relayed marks only count hops whose path hash is at least this many
	// bytes: a 1-byte hash is shared by too many repeaters to trust.
	mediaMeshRelayedMinHashBytes = 2
)

// mediaMeshFlag reads the packet's `mediamesh` key: a JSON boolean, with the
// strings "true" and "1" tolerated (firmware formats other numbers as strings).
// Missing or anything else is false.
func mediaMeshFlag(msg map[string]interface{}) bool {
	switch v := msg["mediamesh"].(type) {
	case bool:
		return v
	case string:
		s := strings.ToLower(strings.TrimSpace(v))
		return s == "true" || s == "1"
	case float64:
		return v == 1
	}
	return false
}

// normalizeMediaMeshMode keeps the three modes the contract defines.
func normalizeMediaMeshMode(v interface{}) string {
	s, _ := v.(string)
	switch strings.ToLower(strings.TrimSpace(s)) {
	case mediaMeshModeRx:
		return mediaMeshModeRx
	case mediaMeshModeRxTx, "rx&tx":
		return mediaMeshModeRxTx
	case mediaMeshModeOff:
		return mediaMeshModeOff
	}
	return ""
}

// MediaMeshReport is one piece of evidence about a node's radio2.
type MediaMeshReport struct {
	PubKey string // lower-case 64-hex node key
	Mode   string // rx | rxtx | off
	Radio  string // canonical "MHz,kHz,SF,CR"; "" when off or unknown
	Source string
}

// mediaMeshFromRadio2 reads a neighbors-message `radio2` object.
func mediaMeshFromRadio2(pubkey string, v interface{}, source string) (MediaMeshReport, bool) {
	obj, ok := v.(map[string]interface{})
	if !ok {
		return MediaMeshReport{}, false
	}
	pubkey = strings.ToLower(strings.TrimSpace(pubkey))
	if !targetPubkeyRe.MatchString(pubkey) {
		return MediaMeshReport{}, false
	}
	mode := normalizeMediaMeshMode(obj["mode"])
	if mode == "" {
		return MediaMeshReport{}, false
	}
	r := MediaMeshReport{PubKey: pubkey, Mode: mode, Source: source}
	if mode != mediaMeshModeOff {
		if radio, ok := obj["radio"].(string); ok {
			r.Radio = clampObserverField(dbschema.CanonicalRadio(radio), maxObserverTextLen)
		}
	}
	return r, true
}

// mediaMeshFromStatus reads a status message's `radios` list: the entry with
// `mediamesh: true`, for the observer's own node.
func mediaMeshFromStatus(observerID string, msg map[string]interface{}) (MediaMeshReport, bool) {
	list, _ := msg["radios"].([]interface{})
	for _, item := range list {
		e, ok := item.(map[string]interface{})
		if !ok || !mediaMeshFlag(e) {
			continue
		}
		mode := normalizeMediaMeshMode(e["mode"])
		if mode == "" || mode == mediaMeshModeOff {
			mode = mediaMeshModeRx // listed as on, mode not given: at least listening
		}
		return mediaMeshFromRadio2(observerID, map[string]interface{}{
			"mode": mode, "radio": e["radio"],
		}, mediaMeshSourceStatus)
	}
	return MediaMeshReport{}, false
}

// mediaMeshFromNeighbors reads a neighbors report: `self.radio2` for the
// observer's own node and each neighbour's `radio2`. A missing key is unknown
// and yields nothing.
func mediaMeshFromNeighbors(originID string, msg map[string]interface{}) []MediaMeshReport {
	var out []MediaMeshReport
	if self, ok := msg["self"].(map[string]interface{}); ok {
		if r, ok := mediaMeshFromRadio2(originID, self["radio2"], mediaMeshSourceStatus); ok {
			out = append(out, r)
		}
	}
	neighbors, _ := msg["neighbors"].([]interface{})
	for _, raw := range neighbors {
		n, ok := raw.(map[string]interface{})
		if !ok {
			continue
		}
		pubkey, _ := n["pubkey"].(string)
		if r, ok := mediaMeshFromRadio2(pubkey, n["radio2"], mediaMeshSourceNeighbor); ok {
			out = append(out, r)
		}
	}
	return out
}

// mediaMeshSender is the node that transmitted a MediaMesh packet the
// observer reported. For one it received:
//   - a flood packet with an empty path: its originator, heard straight;
//     (earlier hops of a flood: mediaMeshRelayers, a weaker "relayed" mark);
//   - a flood packet with a path: the last hop, the forwarder the observer
//     heard. Only an unambiguously resolved hop counts (a 1-byte prefix
//     shared by several repeaters is not evidence, as for last_heard, #2260);
//   - a direct-route ADVERT with an empty path: a zero-hop advert, from its
//     originator.
//
// Any other direct-route packet gives nothing: its path is the route still
// to travel, and an empty one can mean the last repeater on it sent it.
//
// A packet the observer sent itself (direction "tx") was sent by the
// observer: a repeater that publishes its own radio2 transmissions runs
// MediaMesh, sending as well as listening. Serial observers report them once
// the firmware prints the sent frame ahead of its TX line.
func mediaMeshSender(data *PacketData, resolved []*string) string {
	if data.Direction != nil && strings.EqualFold(*data.Direction, "tx") {
		return strings.ToLower(data.ObserverID)
	}
	if !packetpath.PathBytesAreHops(byte(data.PayloadType)) {
		return ""
	}
	hops := parsePathArray(data.PathJSON)
	flood := pathHopsTransmitted(data)
	if len(hops) == 0 {
		if flood || data.PayloadType == PayloadADVERT {
			return strings.ToLower(data.FromPubkey)
		}
		return ""
	}
	if !flood {
		return ""
	}
	if len(resolved) != len(hops) {
		return ""
	}
	last := resolved[len(resolved)-1]
	if last == nil {
		return ""
	}
	return strings.ToLower(*last)
}

// mediaMeshRelayers are the repeaters that forwarded a MediaMesh flood before
// the node mediaMeshSender marks: for one the observer received, every hop but
// the last (the forwarder it heard); for one it sent, every hop but its own,
// which a forwarding repeater appends before sending. With radio2.cross off,
// the Keymind Cascade default that the MediaMesh presets leave alone, a packet
// on radio2 stayed on radio2 the whole way, so each of them received and
// forwarded it there. Only hops resolved to one node count; a direct-route
// path is the route still to travel and says nothing.
func mediaMeshRelayers(data *PacketData, resolved []*string) []string {
	if !pathHopsTransmitted(data) {
		return nil
	}
	hops := parsePathArray(data.PathJSON)
	if len(hops) == 0 || len(resolved) != len(hops) {
		return nil
	}
	sent := data.Direction != nil && strings.EqualFold(*data.Direction, "tx")
	candidates := resolved
	if !sent {
		candidates = resolved[:len(resolved)-1]
	}
	self := strings.ToLower(data.ObserverID)
	var out []string
	for i, r := range candidates {
		if r == nil || len(hops[i]) < 2*mediaMeshRelayedMinHashBytes {
			continue
		}
		if pk := strings.ToLower(*r); targetPubkeyRe.MatchString(pk) && pk != self {
			out = append(out, pk)
		}
	}
	return out
}

// mediaMeshRelaySightings holds, per repeater, the first MediaMesh packet it
// was seen relaying. A relayed mark is made only once a second, different
// packet confirms it within mediaMeshRelayedRetention, so one bad hop match
// does not mark a repeater. Kept in memory: a restart only delays marks.
type mediaMeshRelaySightings struct {
	mu    sync.Mutex
	first map[string]relaySighting
}

type relaySighting struct {
	packet string
	at     time.Time
}

// confirmed records a sighting of pubkey relaying packet and reports whether
// it has now been seen relaying two different packets within the window.
func (m *mediaMeshRelaySightings) confirmed(pubkey, packet string, now time.Time) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.first == nil || len(m.first) >= mediaMeshHeardMapMax {
		m.first = make(map[string]relaySighting)
	}
	s, ok := m.first[pubkey]
	if !ok || now.Sub(s.at) > mediaMeshRelayedRetention {
		m.first[pubkey] = relaySighting{packet: packet, at: now}
		return false
	}
	return packet != "" && packet != s.packet
}

// mediaMeshHeard debounces "heard sending on radio2" writes per node.
type mediaMeshHeard struct {
	mu   sync.Mutex
	last map[string]time.Time
}

func (h *mediaMeshHeard) due(pubkey string, now time.Time) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.last == nil || len(h.last) >= mediaMeshHeardMapMax {
		h.last = make(map[string]time.Time)
	}
	if t, ok := h.last[pubkey]; ok && now.Sub(t) < mediaMeshHeardDebounce {
		return false
	}
	h.last[pubkey] = now
	return true
}

// recordObservationMediaMesh marks one observation as MediaMesh.
func (s *Store) recordObservationMediaMesh(observationID int64) {
	if observationID == 0 {
		return
	}
	if _, err := s.db.Exec(`INSERT OR IGNORE INTO observation_mediamesh (observation_id) VALUES (?)`,
		observationID); err != nil {
		s.Stats.WriteErrors.Add(1)
		log.Printf("[db] observation mediamesh (non-fatal): %v", err)
	}
}

// RecordMediaMesh stores evidence about a node's radio2, newest first. A
// "heard" report (mode rxtx, no radio) keeps a radio the node reported itself.
func (s *Store) RecordMediaMesh(r MediaMeshReport, now time.Time) error {
	if r.PubKey == "" || r.Mode == "" || r.Source == "" {
		return nil
	}
	ts := now.UTC().Format(time.RFC3339)
	_, err := s.db.Exec(`
		INSERT INTO node_mediamesh (public_key, mode, radio, source, last_seen)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(public_key) DO UPDATE SET
			mode      = excluded.mode,
			radio     = CASE WHEN excluded.mode = 'off' THEN NULL
			                 ELSE COALESCE(excluded.radio, radio) END,
			source    = excluded.source,
			last_seen = excluded.last_seen
		WHERE excluded.last_seen >= node_mediamesh.last_seen`,
		r.PubKey, r.Mode, nilIfEmpty(r.Radio), r.Source, ts)
	if err != nil {
		s.Stats.WriteErrors.Add(1)
	}
	return err
}

// RecordMediaMeshRelayed marks a node seen forwarding a MediaMesh flood. It
// adds a mark or refreshes a "relayed" one, and never touches a mark from
// stronger evidence (the node's own report, a neighbour's, heard sending),
// including one that says radio2 is off.
func (s *Store) RecordMediaMeshRelayed(pubkey string, now time.Time) error {
	if pubkey == "" {
		return nil
	}
	ts := now.UTC().Format(time.RFC3339)
	_, err := s.db.Exec(`
		INSERT INTO node_mediamesh (public_key, mode, radio, source, last_seen)
		VALUES (?, ?, NULL, ?, ?)
		ON CONFLICT(public_key) DO UPDATE SET
			last_seen = excluded.last_seen
		WHERE node_mediamesh.source = excluded.source
		  AND excluded.last_seen >= node_mediamesh.last_seen`,
		pubkey, mediaMeshModeRxTx, mediaMeshSourceRelayed, ts)
	if err != nil {
		s.Stats.WriteErrors.Add(1)
	}
	return err
}

// noteMediaMeshObservation runs for every stored observation (the caller
// holds writerMu): nothing for a non-MediaMesh one, else the sparse row, a
// debounced "heard" mark for the sender when it resolves, and debounced
// "relayed" marks for the earlier hops of a flood.
func (s *Store) noteMediaMeshObservation(obsID int64, data *PacketData, resolved []*string) {
	if !data.MediaMesh {
		return
	}
	s.recordObservationMediaMesh(obsID)
	now := time.Now()
	if sender := mediaMeshSender(data, resolved); targetPubkeyRe.MatchString(sender) && s.mediaMeshHeard.due(sender, now) {
		if err := s.RecordMediaMesh(MediaMeshReport{
			PubKey: sender, Mode: mediaMeshModeRxTx, Source: mediaMeshSourceHeard,
		}, now); err != nil {
			log.Printf("[db] node mediamesh heard (non-fatal): %v", err)
		}
	}
	for _, relayer := range mediaMeshRelayers(data, resolved) {
		if !s.mediaMeshRelaySightings.confirmed(relayer, data.Hash, now) {
			continue
		}
		if !s.mediaMeshRelayed.due(relayer, now) {
			continue
		}
		if err := s.RecordMediaMeshRelayed(relayer, now); err != nil {
			log.Printf("[db] node mediamesh relayed (non-fatal): %v", err)
		}
	}
}

// PruneMediaMeshNodes drops node_mediamesh rows not refreshed for 30 days,
// and relayed marks not refreshed for 2 days.
func (s *Store) PruneMediaMeshNodes(now time.Time) (int64, error) {
	cutoff := now.Add(-mediaMeshNodeRetention).UTC().Format(time.RFC3339)
	relayedCutoff := now.Add(-mediaMeshRelayedRetention).UTC().Format(time.RFC3339)
	res, err := s.db.Exec(`DELETE FROM node_mediamesh
		WHERE last_seen < ? OR (source = ? AND last_seen < ?)`,
		cutoff, mediaMeshSourceRelayed, relayedCutoff)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}
