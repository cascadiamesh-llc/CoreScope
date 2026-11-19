package main

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"sort"
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
	// carried it on the main radio), so it never replaces them, and hops the
	// main mesh also heard the packet through are left out (see
	// mainMeshPathPrefix).
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
	// Relayed marks wait this long after the MediaMesh observation, so the
	// main-mesh observations of the same packet (from every other observer)
	// are in before the path is judged.
	mediaMeshRelayDelay = 3 * time.Minute
	// Bounds the queue of MediaMesh floods waiting to be judged.
	mediaMeshRelayQueueMax = 50000
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

// mediaMeshUnknownSender is the path hash of the forwarder an observer heard
// on radio2 when no single known node matches it (no advert yet): the last
// hop of a received flood, 2 or 3 bytes. Empty otherwise.
func mediaMeshUnknownSender(data *PacketData, resolved []*string) string {
	if data.Direction != nil && strings.EqualFold(*data.Direction, "tx") {
		return ""
	}
	if !pathHopsTransmitted(data) {
		return ""
	}
	hops := parsePathArray(data.PathJSON)
	if len(hops) == 0 || len(resolved) != len(hops) || resolved[len(hops)-1] != nil {
		return ""
	}
	last := hops[len(hops)-1]
	if len(last) < 2*mediaMeshRelayedMinHashBytes {
		return ""
	}
	return strings.ToUpper(last)
}

// RecordMediaMeshPrefix stores MediaMesh evidence for a repeater known only by
// its path hash. A 2-byte hash and a 3-byte one it begins share one row, under
// the longer. "heard" outranks "relayed". The caller holds writerMu.
func (s *Store) RecordMediaMeshPrefix(hop, source string, seen time.Time) error {
	hop = strings.ToUpper(hop)
	ts := seen.UTC().Format(time.RFC3339)
	key := hop
	// A longer hash already stored that begins with this one: use it.
	var longer string
	if s.db.QueryRow(`SELECT prefix FROM mediamesh_prefix WHERE prefix LIKE ? AND prefix != ? ORDER BY length(prefix) DESC LIMIT 1`,
		hop+"%", hop).Scan(&longer) == nil {
		key = longer
	}
	if _, err := s.db.Exec(`
		INSERT INTO mediamesh_prefix (prefix, source, first_seen, last_seen, packets)
		VALUES (?, ?, ?, ?, 1)
		ON CONFLICT(prefix) DO UPDATE SET
			source     = CASE WHEN mediamesh_prefix.source = 'heard' OR excluded.source = 'heard'
			                  THEN 'heard' ELSE excluded.source END,
			first_seen = MIN(mediamesh_prefix.first_seen, excluded.first_seen),
			last_seen  = MAX(mediamesh_prefix.last_seen, excluded.last_seen),
			packets    = mediamesh_prefix.packets + 1`, key, source, ts, ts); err != nil {
		s.Stats.WriteErrors.Add(1)
		return err
	}
	// Shorter hashes this one begins with fold into it.
	rows, err := s.db.Query(`SELECT prefix, source, first_seen, packets FROM mediamesh_prefix
		WHERE ? LIKE prefix || '%' AND prefix != ?`, key, key)
	if err != nil {
		return err
	}
	type short struct {
		prefix, source, first string
		packets               int
	}
	var shorter []short
	for rows.Next() {
		var r short
		if rows.Scan(&r.prefix, &r.source, &r.first, &r.packets) == nil {
			shorter = append(shorter, r)
		}
	}
	rows.Close()
	for _, r := range shorter {
		if _, err := s.db.Exec(`UPDATE mediamesh_prefix SET
				source     = CASE WHEN source = 'heard' OR ? = 'heard' THEN 'heard' ELSE source END,
				first_seen = MIN(first_seen, ?),
				packets    = packets + ?
			WHERE prefix = ?`, r.source, r.first, r.packets, key); err != nil {
			return err
		}
		if _, err := s.db.Exec(`DELETE FROM mediamesh_prefix WHERE prefix = ?`, r.prefix); err != nil {
			return err
		}
	}
	return nil
}

// ResolveMediaMeshPrefixes turns stored hashes into marks for the node they
// now match, once exactly one known node does (its advert has been heard):
// "heard" as a heard mark, "relayed" as a relayed one, stamped with the
// hash's last sighting. When several known nodes share the hash but only one
// of them is already a MediaMesh repeater, the hash is that repeater's: with
// thousands of repeaters (and vanity keys like dadada…) short hashes collide,
// and the one on MediaMesh is the one a MediaMesh path names. Returns the
// number resolved.
func (s *Store) ResolveMediaMeshPrefixes(now time.Time) int {
	type row struct{ prefix, source, lastSeen string }
	rows, err := s.db.Query(`SELECT prefix, source, last_seen FROM mediamesh_prefix`)
	if err != nil {
		return 0
	}
	var all []row
	for rows.Next() {
		var r row
		if rows.Scan(&r.prefix, &r.source, &r.lastSeen) == nil {
			all = append(all, r)
		}
	}
	rows.Close()
	resolved := 0
	for _, r := range all {
		keys := s.mediaMeshPrefixKeys(`SELECT public_key FROM nodes WHERE public_key LIKE ? LIMIT 2`, r.prefix)
		if len(keys) > 1 {
			keys = s.mediaMeshPrefixKeys(`SELECT public_key FROM node_mediamesh WHERE public_key LIKE ? LIMIT 2`, r.prefix)
		}
		if len(keys) != 1 || !targetPubkeyRe.MatchString(keys[0]) {
			continue
		}
		seen, err := time.Parse(time.RFC3339, r.lastSeen)
		if err != nil {
			seen = now
		}
		writerMu.Lock()
		if r.source == mediaMeshSourceHeard {
			err = s.RecordMediaMesh(MediaMeshReport{PubKey: keys[0], Mode: mediaMeshModeRxTx, Source: mediaMeshSourceHeard}, seen)
		} else {
			err = s.RecordMediaMeshRelayed(keys[0], seen)
		}
		if err == nil {
			_, err = s.db.Exec(`DELETE FROM mediamesh_prefix WHERE prefix = ?`, r.prefix)
		}
		writerMu.Unlock()
		if err == nil {
			resolved++
		}
	}
	return resolved
}

// mediaMeshNextWindow is how far back the neighbours of unknown hashes are
// looked for.
const mediaMeshNextWindow = 7 * 24 * time.Hour

// mediaMeshHopMatches reports whether a path hop names an unknown hash: the
// same bytes, or one the start of the other (a 2-byte hop and the 3-byte
// hash it begins), at least 2 bytes long.
func mediaMeshHopMatches(hop, prefix string) bool {
	hop, prefix = strings.ToUpper(hop), strings.ToUpper(prefix)
	if len(hop) < 2*mediaMeshRelayedMinHashBytes {
		return false
	}
	return strings.HasPrefix(prefix, hop) || strings.HasPrefix(hop, prefix)
}

// UpdateMediaMeshPrefixNeighbours rebuilds mediamesh_prefix_next: for each
// unknown hash, the named nodes next to it in last week's MediaMesh paths
// (the resolved hop before it, the one after it, and for the last hop of a
// received packet the observer that heard it), with packet counts. It shows
// roughly where a repeater that has never advertised is. Returns the number
// of rows written.
func (s *Store) UpdateMediaMeshPrefixNeighbours(now time.Time) int {
	var prefixes []string
	rows, err := s.db.Query(`SELECT prefix FROM mediamesh_prefix`)
	if err != nil {
		return 0
	}
	for rows.Next() {
		var p string
		if rows.Scan(&p) == nil {
			prefixes = append(prefixes, strings.ToUpper(p))
		}
	}
	rows.Close()
	type key struct{ prefix, pubkey, side string }
	counts := map[key]map[string]bool{} // distinct packets per neighbour
	if len(prefixes) > 0 {
		rows, err := s.db.Query(`SELECT t.hash, COALESCE(o.path_json, ''), COALESCE(o.resolved_path, ''),
				COALESCE(o.direction, ''), COALESCE(obs.id, '')
			FROM observation_mediamesh m
			JOIN observations o ON o.id = m.observation_id
			JOIN transmissions t ON t.id = o.transmission_id
			LEFT JOIN observers obs ON obs.rowid = o.observer_idx
			WHERE o.timestamp >= ? AND o.path_json IS NOT NULL AND o.path_json != '[]'`,
			now.Add(-mediaMeshNextWindow).Unix())
		if err != nil {
			log.Printf("[mediamesh] unknown neighbours: %v", err)
			return 0
		}
		note := func(prefix, pubkey, side, hash string) {
			pubkey = strings.ToLower(pubkey)
			if !targetPubkeyRe.MatchString(pubkey) {
				return
			}
			k := key{prefix, pubkey, side}
			if counts[k] == nil {
				counts[k] = map[string]bool{}
			}
			counts[k][hash] = true
		}
		for rows.Next() {
			var hash, pj, rj, dir, observer string
			if rows.Scan(&hash, &pj, &rj, &dir, &observer) != nil {
				continue
			}
			hops := parsePathArray(pj)
			var resolved []*string
			if rj == "" || json.Unmarshal([]byte(rj), &resolved) != nil || len(resolved) != len(hops) {
				resolved = make([]*string, len(hops))
			}
			for i, hop := range hops {
				for _, p := range prefixes {
					if !mediaMeshHopMatches(hop, p) {
						continue
					}
					if i > 0 && resolved[i-1] != nil {
						note(p, *resolved[i-1], "before", hash)
					}
					if i+1 < len(hops) && resolved[i+1] != nil {
						note(p, *resolved[i+1], "after", hash)
					}
					if i == len(hops)-1 && !strings.EqualFold(dir, "tx") && observer != "" {
						note(p, observer, "observer", hash)
					}
				}
			}
		}
		rows.Close()
	}
	writerMu.Lock()
	defer writerMu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return 0
	}
	if _, err := tx.Exec(`DELETE FROM mediamesh_prefix_next`); err != nil {
		tx.Rollback()
		return 0
	}
	written := 0
	for k, hashes := range counts {
		if _, err := tx.Exec(`INSERT INTO mediamesh_prefix_next (prefix, public_key, side, packets) VALUES (?, ?, ?, ?)`,
			k.prefix, k.pubkey, k.side, len(hashes)); err != nil {
			tx.Rollback()
			return 0
		}
		written++
	}
	if err := tx.Commit(); err != nil {
		return 0
	}
	return written
}

// mediaMeshTrustedHops keeps the hops of a MediaMesh observation that say
// the packet travelled on MediaMesh through that node, by the same rules as
// relayed marks: a flood (a direct route's path is still to travel), hops
// after any the main mesh also heard the packet through (a repeater with
// radio2.cross on copies main-mesh floods onto radio2, path and all), and 2-
// or 3-byte hashes (1-byte ones match too many nodes). The rest become nil,
// so they are neither credited nor linked. resolved must be as long as hops.
func mediaMeshTrustedHops(data *PacketData, hops []string, resolved []*string, mainPaths [][]string) []*string {
	out := make([]*string, len(resolved))
	if !pathHopsTransmitted(data) {
		return out
	}
	onMain := mainMeshPathPrefix(hops, mainPaths)
	for i, r := range resolved {
		if r != nil && i >= onMain && len(hops[i]) >= 2*mediaMeshRelayedMinHashBytes {
			out[i] = r
		}
	}
	return out
}

// mainMeshPathsSince is mainMeshPaths for every packet with a MediaMesh
// observation since the given time, by transmission id.
func (s *Store) mainMeshPathsSince(since int64) (map[int64][][]string, error) {
	rows, err := s.db.Query(`SELECT o.transmission_id, o.path_json FROM observations o
		LEFT JOIN observation_mediamesh m ON m.observation_id = o.id
		LEFT JOIN observation_mainmesh mm ON mm.observation_id = o.id
		WHERE o.transmission_id IN (SELECT o2.transmission_id FROM observation_mediamesh m2
				JOIN observations o2 ON o2.id = m2.observation_id WHERE o2.timestamp >= ?)
		  AND (m.observation_id IS NULL OR mm.observation_id IS NOT NULL)
		  AND o.path_json IS NOT NULL AND o.path_json != '[]'`, since)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int64][][]string{}
	for rows.Next() {
		var id int64
		var pj string
		if err := rows.Scan(&id, &pj); err != nil {
			return nil, err
		}
		if hops := parsePathArray(pj); len(hops) > 0 {
			out[id] = append(out[id], hops)
		}
	}
	return out, rows.Err()
}

// mediaClipGapS: packets of one clip come in a burst; a gap longer than this
// on the same channel through the same repeater starts another clip.
const mediaClipGapS = 30

// mediaClipKey is the clip a media packet belongs to when its bytes can be
// read ("s" and the session id, a parity piece under its clip's id), else
// "" and the channel it was sent on, for estimating.
func mediaClipKey(d *PacketData) (key string, channel int) {
	var p struct {
		Raw           string `json:"raw"`
		DataType      *int   `json:"dataType"`
		DecryptedBlob string `json:"decryptedBlob"`
		ChannelHash   *int   `json:"channelHash"`
	}
	channel = -1
	if json.Unmarshal([]byte(d.DecodedJSON), &p) != nil {
		return "", channel
	}
	if p.ChannelHash != nil {
		channel = *p.ChannelHash
	}
	h := p.Raw
	if d.PayloadType == payloadGrpData {
		h = ""
		if p.DataType != nil && *p.DataType == mediaChannelDataType {
			h = p.DecryptedBlob
		}
	}
	b, err := hex.DecodeString(h)
	if err != nil || len(b) < 5 || (b[0] != 0x56 && b[0] != 0x57 && b[0] != 0x53 && b[0] != 0x54) {
		return "", channel
	}
	sid := uint32(b[1])<<24 | uint32(b[2])<<16 | uint32(b[3])<<8 | uint32(b[4])
	if alt := sid ^ 0xFEC0FEC0; alt < sid {
		sid = alt // a clip and its parity pieces count once
	}
	return fmt.Sprintf("s%08x", sid), channel
}

// mediaClipTally counts the clips one repeater relayed: exactly by session
// id where the packets could be read, else estimated from bursts.
type mediaClipTally struct {
	exact  map[string]bool
	bursts []mediaClipBurst
}

type mediaClipBurst struct {
	channel int
	ts      int64
}

func (c *mediaClipTally) add(key string, channel int, ts int64) {
	if key != "" {
		c.exact[key] = true
		return
	}
	c.bursts = append(c.bursts, mediaClipBurst{channel, ts})
}

// count is the clips: the exact ones, plus one per burst of unreadable
// packets on a channel; estimated says whether any were estimated.
func (c *mediaClipTally) count() (n int, estimated int) {
	n = len(c.exact)
	sort.Slice(c.bursts, func(i, j int) bool {
		if c.bursts[i].channel != c.bursts[j].channel {
			return c.bursts[i].channel < c.bursts[j].channel
		}
		return c.bursts[i].ts < c.bursts[j].ts
	})
	for i, b := range c.bursts {
		if i == 0 || b.channel != c.bursts[i-1].channel || b.ts-c.bursts[i-1].ts > mediaClipGapS {
			estimated++
		}
	}
	return n + estimated, estimated
}

// UpdateMediaMeshNodeStats rebuilds mediamesh_node_stats from the stored
// MediaMesh photo and voice packets (GRP_DATA, RAW_CUSTOM that carry media):
// for every node that relayed one (a hop mediaMeshTrustedHops keeps) or heard
// one (the observer),
// the earliest time, kept if earlier than the stored one; and the number of
// different packets each relayed in the last week. Also rebuilds the
// backbone (mediamesh_edge: who passed packets to whom this week) and the
// per-day counts (mediamesh_node_daily, two weeks). Nodes marked MediaMesh
// some other way (a status report) get first_seen = their mark's time the
// first time round. Returns the number of nodes with a row.
func (s *Store) UpdateMediaMeshNodeStats(now time.Time) int {
	since := now.Add(-mediaMeshNodeRetention).Unix()
	mainPaths, err := s.mainMeshPathsSince(since)
	if err != nil {
		log.Printf("[mediamesh] node stats main paths: %v", err)
		return 0
	}
	rows, err := s.db.Query(`SELECT t.id, t.hash, t.payload_type, t.route_type, COALESCE(t.decoded_json, ''),
			COALESCE(o.path_json, ''), COALESCE(o.resolved_path, ''),
			COALESCE(obs.id, ''), COALESCE(o.direction, ''), o.timestamp
		FROM observation_mediamesh m
		JOIN observations o ON o.id = m.observation_id
		JOIN transmissions t ON t.id = o.transmission_id
		LEFT JOIN observers obs ON obs.rowid = o.observer_idx
		WHERE o.timestamp >= ? AND t.payload_type IN (?, ?)`,
		since, payloadGrpData, payloadRawCustom)
	if err != nil {
		log.Printf("[mediamesh] node stats: %v", err)
		return 0
	}
	first := map[string]int64{}
	relayed := map[string]map[string]bool{}
	weekAgo := now.Add(-7 * 24 * time.Hour).Unix()
	fortnightAgo := now.Add(-14 * 24 * time.Hour).Unix()
	type pair struct{ a, b string }
	edges := map[pair]map[string]bool{}
	type nodeDay struct{ pk, day string }
	daily := map[nodeDay]map[string]bool{}
	link := func(x, y, hash string) {
		x, y = strings.ToLower(x), strings.ToLower(y)
		if x == y || !targetPubkeyRe.MatchString(x) || !targetPubkeyRe.MatchString(y) {
			return
		}
		if y < x {
			x, y = y, x
		}
		k := pair{x, y}
		if edges[k] == nil {
			edges[k] = map[string]bool{}
		}
		edges[k][hash] = true
	}
	see := func(pk string, ts int64) {
		pk = strings.ToLower(pk)
		if !targetPubkeyRe.MatchString(pk) {
			return
		}
		if f, ok := first[pk]; !ok || ts < f {
			first[pk] = ts
		}
	}
	clips := map[string]*mediaClipTally{}
	type statRow struct {
		d       PacketData
		txID    int64
		ts      int64
		rj, dir string
	}
	var all []statRow
	var unread []mediaBurstItem
	for rows.Next() {
		var r statRow
		if rows.Scan(&r.txID, &r.d.Hash, &r.d.PayloadType, &r.d.RouteType, &r.d.DecodedJSON, &r.d.PathJSON, &r.rj, &r.d.ObserverID, &r.dir, &r.ts) != nil {
			continue
		}
		if r.dir != "" {
			r.d.Direction = &r.dir
		}
		if !mediaMeshCarriesMedia(&r.d) {
			continue
		}
		if ch, ok := mediaUnreadableChannel(&r.d); ok {
			unread = append(unread, mediaBurstItem{id: r.txID, channel: ch, ts: r.ts})
		}
		all = append(all, r)
	}
	rows.Close()
	// Channel data the analyzer can't read is media only in a burst: a clip
	// is many pieces at once, while a lone packet every few minutes is
	// something else (MeshCore Open TAK's team positions, for one).
	inBurst := mediaBursts(unread)
	for _, r := range all {
		d, txID, ts, rj, dir := r.d, r.txID, r.ts, r.rj, r.dir
		if _, unreadable := mediaUnreadableChannel(&d); unreadable && !inBurst[txID] {
			continue
		}
		hash, observer := d.Hash, d.ObserverID
		see(observer, ts)
		hops := parsePathArray(d.PathJSON)
		var resolved []*string
		if rj == "" || json.Unmarshal([]byte(rj), &resolved) != nil || len(resolved) != len(hops) {
			continue
		}
		resolved = mediaMeshTrustedHops(&d, hops, resolved, mainPaths[txID])
		day := time.Unix(ts, 0).UTC().Format("2006-01-02")
		clipKey, channel, clipRead := "", -1, false
		for i, r := range resolved {
			if r == nil {
				continue
			}
			see(*r, ts)
			pk := strings.ToLower(*r)
			if ts >= weekAgo {
				if relayed[pk] == nil {
					relayed[pk] = map[string]bool{}
				}
				relayed[pk][hash] = true
				if !clipRead {
					clipKey, channel = mediaClipKey(&d)
					clipRead = true
				}
				if clips[pk] == nil {
					clips[pk] = &mediaClipTally{exact: map[string]bool{}}
				}
				clips[pk].add(clipKey, channel, ts)
				if i > 0 && resolved[i-1] != nil {
					link(*resolved[i-1], pk, hash)
				}
				if i == len(resolved)-1 && observer != "" && !strings.EqualFold(dir, "tx") {
					link(pk, observer, hash)
				}
			}
			if ts >= fortnightAgo {
				k := nodeDay{pk, day}
				if daily[k] == nil {
					daily[k] = map[string]bool{}
				}
				daily[k][hash] = true
			}
		}
	}
	writerMu.Lock()
	defer writerMu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return 0
	}
	fail := func() int { tx.Rollback(); return 0 }
	if _, err := tx.Exec(`UPDATE mediamesh_node_stats SET relayed_7d = 0`); err != nil {
		return fail()
	}
	// Prepared once: there can be tens of thousands of rows, and the
	// ingest writer waits while this transaction holds writerMu.
	insStat, err := tx.Prepare(`INSERT INTO mediamesh_node_stats (public_key, first_seen, relayed_7d) VALUES (?, ?, ?)
			ON CONFLICT(public_key) DO UPDATE SET
				first_seen = MIN(mediamesh_node_stats.first_seen, excluded.first_seen),
				relayed_7d = excluded.relayed_7d`)
	if err != nil {
		return fail()
	}
	defer insStat.Close()
	for pk, ts := range first {
		if _, err := insStat.Exec(pk, time.Unix(ts, 0).UTC().Format(time.RFC3339), len(relayed[pk])); err != nil {
			return fail()
		}
	}
	if _, err := tx.Exec(`INSERT OR IGNORE INTO mediamesh_node_stats (public_key, first_seen, relayed_7d)
		SELECT public_key, last_seen, 0 FROM node_mediamesh`); err != nil {
		return fail()
	}
	if _, err := tx.Exec(`DELETE FROM mediamesh_edge`); err != nil {
		return fail()
	}
	insEdge, err := tx.Prepare(`INSERT INTO mediamesh_edge (a, b, packets) VALUES (?, ?, ?)`)
	if err != nil {
		return fail()
	}
	defer insEdge.Close()
	for k, hs := range edges {
		if _, err := insEdge.Exec(k.a, k.b, len(hs)); err != nil {
			return fail()
		}
	}
	if _, err := tx.Exec(`DELETE FROM mediamesh_node_clips`); err != nil {
		return fail()
	}
	insClips, err := tx.Prepare(`INSERT INTO mediamesh_node_clips (public_key, clips_7d, estimated_7d) VALUES (?, ?, ?)`)
	if err != nil {
		return fail()
	}
	defer insClips.Close()
	for pk, c := range clips {
		n, estimated := c.count()
		if _, err := insClips.Exec(pk, n, estimated); err != nil {
			return fail()
		}
	}
	if _, err := tx.Exec(`DELETE FROM mediamesh_node_daily`); err != nil {
		return fail()
	}
	insDaily, err := tx.Prepare(`INSERT INTO mediamesh_node_daily (public_key, day, packets) VALUES (?, ?, ?)`)
	if err != nil {
		return fail()
	}
	defer insDaily.Close()
	for k, hs := range daily {
		if _, err := insDaily.Exec(k.pk, k.day, len(hs)); err != nil {
			return fail()
		}
	}
	if err := tx.Commit(); err != nil {
		return 0
	}
	var n int
	s.db.QueryRow(`SELECT COUNT(*) FROM mediamesh_node_stats`).Scan(&n)
	return n
}

// mediaMeshPrefixKeys runs a "public_key LIKE prefix%" query and returns the
// keys, lowercased; nil on error.
func (s *Store) mediaMeshPrefixKeys(query, prefix string) []string {
	rows, err := s.db.Query(query, strings.ToLower(prefix)+"%")
	if err != nil {
		return nil
	}
	defer rows.Close()
	var keys []string
	for rows.Next() {
		var k string
		if rows.Scan(&k) == nil {
			keys = append(keys, strings.ToLower(k))
		}
	}
	return keys
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
	var out []string
	for _, c := range mediaMeshRelayerHops(data, resolved) {
		if c.pubkey != "" {
			out = append(out, c.pubkey)
		}
	}
	return out
}

// relayCandidate is one hop of a MediaMesh flood that may get a relayed mark:
// its position in the path and the node it resolved to.
type relayCandidate struct {
	index  int
	pubkey string // empty for a hop no known node matches
	hop    string // the path hash, upper-case hex
}

// mediaMeshRelayerHops is mediaMeshRelayers with each hop's path position.
// Only packets that carry media count (mediaMeshCarriesMedia).
func mediaMeshRelayerHops(data *PacketData, resolved []*string) []relayCandidate {
	if !pathHopsTransmitted(data) || !mediaMeshCarriesMedia(data) {
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
	var out []relayCandidate
	for i, r := range candidates {
		if len(hops[i]) < 2*mediaMeshRelayedMinHashBytes {
			continue
		}
		hop := strings.ToUpper(hops[i])
		if r == nil {
			// No single known node: kept by its hash (mediamesh_prefix).
			out = append(out, relayCandidate{index: i, hop: hop})
			continue
		}
		if pk := strings.ToLower(*r); targetPubkeyRe.MatchString(pk) && pk != self {
			out = append(out, relayCandidate{index: i, pubkey: pk, hop: hop})
		}
	}
	return out
}

// Media packets, as Keymind Cascade's tx.media rule picks them for radio2
// (src/helpers/CompanionTrafficRouting.h): photos, voice and video from
// MeshCore Open TAK and Wadamesh TAK.
const (
	payloadGrpData       = 0x06
	payloadRawCustom     = 0x0F
	mediaChannelDataType = 0x5643 // Open TAK 'VC'
)

// mediaBurstGapS and mediaBurstMin: unreadable channel data counts as media
// when at least mediaBurstMin packets on its channel fall within
// mediaBurstGapS seconds of each other.
const (
	mediaBurstGapS = 60
	mediaBurstMin  = 3
)

// mediaBurstItem is one transmission of unreadable channel data.
type mediaBurstItem struct {
	id      int64 // transmission id
	channel int
	ts      int64 // unix seconds
}

// mediaBursts says which transmissions sit in a burst on their channel: at
// least mediaBurstMin of them within mediaBurstGapS seconds. Each
// transmission is judged by its first time heard.
func mediaBursts(items []mediaBurstItem) map[int64]bool {
	first := map[int64]mediaBurstItem{}
	for _, it := range items {
		if f, ok := first[it.id]; !ok || it.ts < f.ts {
			first[it.id] = it
		}
	}
	byCh := map[int][]mediaBurstItem{}
	for _, it := range first {
		byCh[it.channel] = append(byCh[it.channel], it)
	}
	out := map[int64]bool{}
	for _, xs := range byCh {
		sort.Slice(xs, func(i, j int) bool { return xs[i].ts < xs[j].ts })
		r := 0
		for l := range xs {
			if r < l {
				r = l
			}
			for r+1 < len(xs) && xs[r+1].ts-xs[l].ts <= mediaBurstGapS {
				r++
			}
			if r-l+1 >= mediaBurstMin {
				for k := l; k <= r; k++ {
					out[xs[k].id] = true
				}
			}
		}
	}
	return out
}

// mediaUnreadableChannel is the channel of channel data the analyzer could
// not read (no data type decoded), and whether it is such a packet.
func mediaUnreadableChannel(d *PacketData) (int, bool) {
	if d.PayloadType != payloadGrpData {
		return 0, false
	}
	var p struct {
		DataType    *int `json:"dataType"`
		ChannelHash *int `json:"channelHash"`
	}
	if d.DecodedJSON != "" && json.Unmarshal([]byte(d.DecodedJSON), &p) == nil && p.DataType != nil {
		return 0, false
	}
	ch := -1
	if p.ChannelHash != nil {
		ch = *p.ChannelHash
	}
	return ch, true
}

// mediaMeshCarriesMedia reports whether a packet is the kind that carries
// photos, voice or video. Ordinary traffic on radio2 (requests, chat,
// adverts) usually got there through a repeater with radio2.cross on, so it
// says nothing about the repeaters earlier in its path.
//
//   - GRP_DATA: channel data. The data type is encrypted; when the analyzer
//     holds the channel key and the type is not Open TAK media, it is not
//     media. Otherwise it counts.
//   - RAW_CUSTOM: Open TAK's binary clip packets, recognised by their
//     leading bytes as the firmware does.
func mediaMeshCarriesMedia(data *PacketData) bool {
	switch data.PayloadType {
	case payloadGrpData:
		var p struct {
			DataType *int `json:"dataType"`
		}
		if data.DecodedJSON != "" && json.Unmarshal([]byte(data.DecodedJSON), &p) == nil &&
			p.DataType != nil && *p.DataType != mediaChannelDataType {
			return false
		}
		return true
	case payloadRawCustom:
		var p struct {
			Raw string `json:"raw"`
		}
		if json.Unmarshal([]byte(data.DecodedJSON), &p) != nil {
			return false
		}
		b, err := hex.DecodeString(p.Raw)
		return err == nil && rawMediaPayload(b)
	}
	return false
}

// rawMediaPayload mirrors the firmware's rawTrafficKind media test.
func rawMediaPayload(data []byte) bool {
	n := len(data)
	if n == 0 {
		return false
	}
	if (data[0] == 0x56 && n >= 7) || (data[0] == 0x57 && n >= 8) {
		return true
	}
	if data[0] == 0x72 && n >= 13 {
		flags := data[5]
		count := int(data[12])
		if flags&^7 != 0 || (flags&1 == 0 && count != 0) || count > n-13 {
			return false
		}
		end := 13 + count
		if flags&4 == 0 {
			return n == end
		}
		return n > end && data[end] <= 63 && n-end-1 == int(data[end])
	}
	return false
}

// sameHop reports whether two path entries name the same hop. Entries of one
// packet have one hash size; a prefix match tolerates a mixed record.
func sameHop(a, b string) bool {
	a, b = strings.ToLower(a), strings.ToLower(b)
	if a == "" || b == "" {
		return false
	}
	return strings.HasPrefix(a, b) || strings.HasPrefix(b, a)
}

// mainMeshPathPrefix is how many leading hops of a MediaMesh observation's
// path the packet is known to have travelled on the main mesh: the longest
// prefix it shares with any main-radio observation of the same packet.
//
// A repeater with radio2.cross on or auto forwards main-mesh floods onto
// radio2 as well. Such a packet is heard on radio2 with its whole main-mesh
// path in front of the crossing repeater, and the same packet, with the same
// leading hops, is heard on the main radio by the observers around it. Those
// leading hops carried it on the main mesh and say nothing about MediaMesh.
func mainMeshPathPrefix(mediaMeshPath []string, mainPaths [][]string) int {
	best := 0
	for _, m := range mainPaths {
		n := 0
		for n < len(m) && n < len(mediaMeshPath) && sameHop(m[n], mediaMeshPath[n]) {
			n++
		}
		if n > best {
			best = n
		}
	}
	return best
}

// pendingRelay is a MediaMesh flood waiting mediaMeshRelayDelay before its
// earlier hops are judged.
type pendingRelay struct {
	txID   int64
	packet string
	path   []string
	cands  []relayCandidate
	at     time.Time // when queued
	seen   time.Time // when the packet was heard (marks are stamped with it)
}

type mediaMeshRelayQueue struct {
	mu    sync.Mutex
	items []pendingRelay
}

func (q *mediaMeshRelayQueue) push(p pendingRelay) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if len(q.items) >= mediaMeshRelayQueueMax {
		q.items = q.items[1:]
	}
	q.items = append(q.items, p)
}

// due removes and returns the items queued at or before cutoff.
func (q *mediaMeshRelayQueue) due(cutoff time.Time) []pendingRelay {
	q.mu.Lock()
	defer q.mu.Unlock()
	n := 0
	for n < len(q.items) && !q.items[n].at.After(cutoff) {
		n++
	}
	out := append([]pendingRelay(nil), q.items[:n]...)
	q.items = append(q.items[:0], q.items[n:]...)
	return out
}

// mainMeshPaths returns the paths of the packet's observations heard on the
// main radio: rows not on radio2, and MediaMesh rows that also had a
// main-radio copy (observation_mainmesh).
func (s *Store) mainMeshPaths(txID int64) ([][]string, error) {
	rows, err := s.db.Query(`SELECT o.path_json FROM observations o
		LEFT JOIN observation_mediamesh m ON m.observation_id = o.id
		LEFT JOIN observation_mainmesh mm ON mm.observation_id = o.id
		WHERE o.transmission_id = ? AND (m.observation_id IS NULL OR mm.observation_id IS NOT NULL)
		  AND o.path_json IS NOT NULL AND o.path_json != '[]'`, txID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out [][]string
	for rows.Next() {
		var pj string
		if err := rows.Scan(&pj); err != nil {
			return nil, err
		}
		if hops := parsePathArray(pj); len(hops) > 0 {
			out = append(out, hops)
		}
	}
	return out, rows.Err()
}

// ProcessMediaMeshRelays judges the MediaMesh floods queued at least
// mediaMeshRelayDelay ago: hops the main mesh also heard the packet through
// are dropped, and each remaining hop counts as a sighting. A packet no
// observer heard on the main mesh at all travelled on MediaMesh the whole
// way, so one sighting in it makes the mark; otherwise it takes two
// different packets. Returns the number of marks written.
func (s *Store) ProcessMediaMeshRelays(now time.Time) int {
	marked := 0
	for _, p := range s.mediaMeshRelayQueue.due(now.Add(-mediaMeshRelayDelay)) {
		mainPaths, err := s.mainMeshPaths(p.txID)
		if err != nil {
			log.Printf("[db] mediamesh relay main paths (non-fatal): %v", err)
			continue
		}
		onMain := mainMeshPathPrefix(p.path, mainPaths)
		mediaMeshOnly := len(mainPaths) == 0
		var write []string
		for _, c := range p.cands {
			if c.index < onMain {
				continue
			}
			key := c.pubkey
			if key == "" {
				key = "?" + c.hop
			}
			seen := p.seen
			if seen.IsZero() {
				seen = now
			}
			// Always noted, so a later packet can confirm it.
			twice := s.mediaMeshRelaySightings.confirmed(key, p.packet, seen)
			if !twice && !mediaMeshOnly {
				continue
			}
			if !s.mediaMeshRelayed.due(key, seen) {
				continue
			}
			write = append(write, key)
		}
		if len(write) == 0 {
			continue
		}
		seen := p.seen
		if seen.IsZero() {
			seen = now
		}
		writerMu.Lock()
		for _, key := range write {
			var err error
			if strings.HasPrefix(key, "?") {
				err = s.RecordMediaMeshPrefix(key[1:], mediaMeshSourceRelayed, seen)
			} else {
				err = s.RecordMediaMeshRelayed(key, seen)
			}
			if err != nil {
				log.Printf("[db] node mediamesh relayed (non-fatal): %v", err)
				continue
			}
			marked++
		}
		writerMu.Unlock()
	}
	return marked
}

// BackfillMediaMeshRelays queues every MediaMesh photo and voice flood still
// stored (up to mediaMeshNodeRetention old) for judging, stamped with the
// time it was heard: the relay queue and sightings live in memory, so a
// restart would otherwise forget them, and this also finds repeaters missed
// before the current rules. Old evidence makes old marks, which fade as
// usual. Unknown hashes (no advert yet) go to mediamesh_prefix, including the
// forwarder an observer heard. Returns the number queued.
func (s *Store) BackfillMediaMeshRelays(now time.Time) int {
	since := now.Add(-mediaMeshNodeRetention).Unix()
	rows, err := s.db.Query(`SELECT t.id, t.hash, t.payload_type, t.route_type,
			COALESCE(t.decoded_json, ''), COALESCE(o.path_json, ''),
			COALESCE(o.resolved_path, ''), COALESCE(o.direction, ''), COALESCE(obs.id, ''),
			o.timestamp
		FROM observation_mediamesh m
		JOIN observations o ON o.id = m.observation_id
		JOIN transmissions t ON t.id = o.transmission_id
		LEFT JOIN observers obs ON obs.rowid = o.observer_idx
		WHERE o.timestamp >= ? AND t.payload_type IN (?, ?)
		ORDER BY o.timestamp`, since, payloadGrpData, payloadRawCustom)
	if err != nil {
		log.Printf("[mediamesh] relay backfill: %v", err)
		return 0
	}
	defer rows.Close()
	queued := 0
	at := now.Add(-mediaMeshRelayDelay)
	type heardHop struct {
		hop  string
		seen time.Time
	}
	var heard []heardHop
	for rows.Next() {
		var txID, ts int64
		var d PacketData
		var resolvedJSON, dir string
		if err := rows.Scan(&txID, &d.Hash, &d.PayloadType, &d.RouteType, &d.DecodedJSON,
			&d.PathJSON, &resolvedJSON, &dir, &d.ObserverID, &ts); err != nil {
			continue
		}
		if dir != "" {
			d.Direction = &dir
		}
		hops := parsePathArray(d.PathJSON)
		var resolved []*string
		if resolvedJSON == "" || json.Unmarshal([]byte(resolvedJSON), &resolved) != nil || len(resolved) != len(hops) {
			resolved = make([]*string, len(hops)) // nothing resolved: every hop is unknown
		}
		seen := time.Unix(ts, 0)
		if hop := mediaMeshUnknownSender(&d, resolved); hop != "" {
			heard = append(heard, heardHop{hop, seen})
		}
		if cands := mediaMeshRelayerHops(&d, resolved); len(cands) > 0 {
			s.mediaMeshRelayQueue.push(pendingRelay{txID: txID, packet: d.Hash,
				path: hops, cands: cands, at: at, seen: seen})
			queued++
		}
	}
	rows.Close()
	if len(heard) > 0 {
		writerMu.Lock()
		for _, h := range heard {
			if err := s.RecordMediaMeshPrefix(h.hop, mediaMeshSourceHeard, h.seen); err != nil {
				log.Printf("[mediamesh] prefix backfill (non-fatal): %v", err)
			}
		}
		writerMu.Unlock()
	}
	return queued
}

// ResetMediaMeshRelayedOnce deletes every relayed mark made before relayed
// marks checked the main mesh (v3.16.0-mediamesh.6): most came from
// main-mesh floods a cross-enabled repeater forwarded onto radio2.
func (s *Store) ResetMediaMeshRelayedOnce() {
	if _, err := s.db.Exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY)`); err != nil {
		return
	}
	var done int
	if s.db.QueryRow(`SELECT 1 FROM _migrations WHERE name = 'mediamesh_relayed_reset_v1'`).Scan(&done) == nil {
		return
	}
	res, err := s.db.Exec(`DELETE FROM node_mediamesh WHERE source = ?`, mediaMeshSourceRelayed)
	if err != nil {
		log.Printf("[migration] mediamesh relayed reset: %v", err)
		return
	}
	n, _ := res.RowsAffected()
	s.db.Exec(`INSERT OR IGNORE INTO _migrations (name) VALUES ('mediamesh_relayed_reset_v1')`)
	log.Printf("[migration] removed %d MediaMesh relayed marks made without the main-mesh check", n)
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

// mediaMeshExistingMainRow reports whether the observation this MediaMesh
// copy will merge into (same packet, observer and path) already exists as a
// main-radio row: the main-mesh copy came first. Checked before the insert,
// only for MediaMesh copies (a small share of traffic), with the dedup index.
func (s *Store) mediaMeshExistingMainRow(txID int64, observerIdx *int64, pathJSON string) bool {
	if observerIdx == nil {
		return false // NULL observers never merge (the unique index treats NULLs as distinct)
	}
	var id int64
	if s.db.QueryRow(`SELECT id FROM observations
		WHERE transmission_id = ? AND observer_idx = ? AND COALESCE(path_json, '') = ?`,
		txID, *observerIdx, pathJSON).Scan(&id) != nil {
		return false
	}
	var mm int
	return s.db.QueryRow(`SELECT 1 FROM observation_mediamesh WHERE observation_id = ?`, id).Scan(&mm) != nil
}

// noteMainMeshCopy records that a MediaMesh observation row was also heard on
// the main radio: a main-radio copy merged into a MediaMesh row (mainCopy
// false, row already MediaMesh), or a MediaMesh copy merged into an earlier
// main-radio row (mainFirst).
func (s *Store) noteMainMeshCopy(obsID int64, mediaMesh, mainFirst bool) {
	if obsID == 0 {
		return
	}
	if mediaMesh {
		if !mainFirst {
			return
		}
	} else {
		var mm int
		if s.db.QueryRow(`SELECT 1 FROM observation_mediamesh WHERE observation_id = ?`, obsID).Scan(&mm) != nil {
			return
		}
	}
	if _, err := s.db.Exec(`INSERT OR IGNORE INTO observation_mainmesh (observation_id) VALUES (?)`, obsID); err != nil {
		s.Stats.WriteErrors.Add(1)
		log.Printf("[db] observation mainmesh (non-fatal): %v", err)
	}
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
// debounced "heard" mark for the sender when it resolves, and the earlier hops
// of a flood queued for ProcessMediaMeshRelays.
func (s *Store) noteMediaMeshObservation(obsID, txID int64, data *PacketData, resolved []*string) {
	if !data.MediaMesh {
		return
	}
	s.recordObservationMediaMesh(obsID)
	now := time.Now()
	if hop := mediaMeshUnknownSender(data, resolved); hop != "" && s.mediaMeshHeard.due("?"+hop, now) {
		if err := s.RecordMediaMeshPrefix(hop, mediaMeshSourceHeard, now); err != nil {
			log.Printf("[db] mediamesh prefix heard (non-fatal): %v", err)
		}
	}
	if sender := mediaMeshSender(data, resolved); targetPubkeyRe.MatchString(sender) && s.mediaMeshHeard.due(sender, now) {
		if err := s.RecordMediaMesh(MediaMeshReport{
			PubKey: sender, Mode: mediaMeshModeRxTx, Source: mediaMeshSourceHeard,
		}, now); err != nil {
			log.Printf("[db] node mediamesh heard (non-fatal): %v", err)
		}
	}
	if cands := mediaMeshRelayerHops(data, resolved); len(cands) > 0 {
		s.mediaMeshRelayQueue.push(pendingRelay{
			txID:   txID,
			packet: data.Hash,
			path:   parsePathArray(data.PathJSON),
			cands:  cands,
			at:     now,
			seen:   now,
		})
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
	if _, err := s.db.Exec(`DELETE FROM mediamesh_prefix WHERE last_seen < ?`, cutoff); err != nil {
		return 0, err
	}
	return res.RowsAffected()
}
