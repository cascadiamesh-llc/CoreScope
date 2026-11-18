package main

import (
	"context"
	"database/sql"
	"log"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// MediaMesh: radio2, a second LoRa profile that Keymind Cascade repeaters,
// Wadamesh TAK standalones and MeshCore Open TAK use for photos and voice.
// The ingestor records which observations were carried on it
// (observation_mediamesh) and which nodes run it (node_mediamesh); schema and
// the observer contract in internal/dbschema/mediamesh.go, writes in
// cmd/ingestor/mediamesh.go. The server keeps both in memory, read-only
// (#1283), the same way as radio_history.go:
//
//   - the poller calls refreshMediaMesh on every tick, before ingesting, so a
//     new observation's flag is known before it is broadcast;
//   - a full reload every mediaMeshFullReload picks up what the cheap checks
//     cannot see: rows deleted by retention.
//
// Output is additive: `"mediamesh": true` on an observation or packet only
// when set, and `"mediamesh": {...}` on a node only when it runs MediaMesh,
// so nothing changes for anything else.
//
// Cost (rule 0): one set lookup per observation serialised, one map lookup
// per node. The set holds only MediaMesh observations, the map only nodes
// with evidence.

const (
	mediaMeshFullReload = 10 * time.Minute
	// The ingestor rebuilds the unknown repeaters, node stats, clips and
	// backbone every half hour, so the per-tick refresh reads them at most
	// this often rather than every second.
	mediaMeshAuxReload = time.Minute
	// A node's MediaMesh mark counts while its newest evidence is this recent.
	mediaMeshEvidenceWindow = 7 * 24 * time.Hour
	// A mark only from relaying MediaMesh (weaker evidence) fades sooner.
	mediaMeshRelayedWindow = 2 * 24 * time.Hour
)

// MediaMeshNode is what /api/nodes and node detail report for a node that
// runs MediaMesh.
type MediaMeshNode struct {
	Mode     string `json:"mode"`            // rx | rxtx
	Radio    string `json:"radio,omitempty"` // "MHz,kHz,SF,CR" when reported
	Source   string `json:"source"`          // status | neighbor | heard | relayed
	LastSeen string `json:"last_seen"`
}

var (
	mediaMeshMu       sync.RWMutex
	mediaMeshObs      = map[int]struct{}{}
	mediaMeshMainObs  = map[int]struct{}{} // MediaMesh rows also heard on the main radio
	mediaMeshUnknown  atomic.Pointer[[]MediaMeshUnknown]
	mediaMeshStats    atomic.Pointer[map[string]mediaMeshNodeStat]
	mediaMeshEdges    atomic.Pointer[[]mediaMeshEdge]
	mediaMeshDaily    atomic.Pointer[map[string]map[string]int]
	mediaMeshMaxObsID int64
	mediaMeshAuxAt    time.Time // last read of the half-hourly tables; under mediaMeshRefresh
	mediaMeshNodes    atomic.Pointer[map[string]MediaMeshNode]
	mediaMeshNodesTS  string     // newest last_seen loaded (incremental watermark)
	mediaMeshRefresh  sync.Mutex // one refresh at a time
)

// MediaMeshUnknown is a MediaMesh repeater the analyzer has no advert from,
// known only by its path hash (the ingestor's mediamesh_prefix table).
type MediaMeshUnknown struct {
	Prefix    string `json:"prefix"`
	Source    string `json:"source"` // heard | relayed
	FirstSeen string `json:"first_seen"`
	LastSeen  string `json:"last_seen"`
	Packets   int    `json:"packets"`
	// Next: the named nodes seen next to the hash in last week's MediaMesh
	// paths (mediamesh_prefix_next), busiest first: roughly where it is.
	Next []MediaMeshNeighbour `json:"next,omitempty"`
}

// MediaMeshNeighbour is a named node seen next to an unknown repeater's hash.
type MediaMeshNeighbour struct {
	PublicKey string `json:"public_key"`
	Name      string `json:"name,omitempty"`
	Near      string `json:"near,omitempty"`
	// Side: before (handed it the packet), after (it handed the packet on),
	// observer (heard it directly).
	Side    string `json:"side"`
	Packets int    `json:"packets"`
}

// mediaMeshMaxNext caps the neighbours listed per unknown repeater.
const mediaMeshMaxNext = 5

func loadMediaMeshUnknown(conn *sql.DB) ([]MediaMeshUnknown, error) {
	out := []MediaMeshUnknown{}
	if !tableExists(conn, "mediamesh_prefix") {
		return out, nil
	}
	rows, err := conn.Query(`SELECT prefix, source, first_seen, last_seen, packets FROM mediamesh_prefix ORDER BY last_seen DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var u MediaMeshUnknown
		if err := rows.Scan(&u.Prefix, &u.Source, &u.FirstSeen, &u.LastSeen, &u.Packets); err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()
	if !tableExists(conn, "mediamesh_prefix_next") || len(out) == 0 {
		return out, nil
	}
	nrows, err := conn.Query(`SELECT prefix, public_key, side, packets FROM mediamesh_prefix_next
		ORDER BY packets DESC, public_key, side`)
	if err != nil {
		return nil, err
	}
	defer nrows.Close()
	at := map[string]int{}
	for i, u := range out {
		at[strings.ToUpper(u.Prefix)] = i
	}
	for nrows.Next() {
		var prefix string
		var n MediaMeshNeighbour
		if err := nrows.Scan(&prefix, &n.PublicKey, &n.Side, &n.Packets); err != nil {
			return nil, err
		}
		if i, ok := at[strings.ToUpper(prefix)]; ok && len(out[i].Next) < mediaMeshMaxNext {
			out[i].Next = append(out[i].Next, n)
		}
	}
	return out, nrows.Err()
}

// withNeighbourNames returns the unknown repeaters with their neighbours'
// names and Near filled in from the node list. It copies, so the shared
// list stays as loaded.
func withNeighbourNames(in []MediaMeshUnknown, nodes map[string]nodeInfo) []MediaMeshUnknown {
	out := make([]MediaMeshUnknown, len(in))
	for i, u := range in {
		out[i] = u
		if len(u.Next) == 0 {
			continue
		}
		out[i].Next = make([]MediaMeshNeighbour, len(u.Next))
		for j, n := range u.Next {
			if info, ok := nodes[strings.ToLower(n.PublicKey)]; ok {
				n.Name = info.Name
			}
			n.Near = nodeNear(nodes, n.PublicKey)
			out[i].Next[j] = n
		}
	}
	return out
}

// mediaMeshNodeStat is one node's MediaMesh history (the ingestor's
// mediamesh_node_stats): first seen, and photo or voice packets relayed in
// the last week.
type mediaMeshNodeStat struct {
	FirstSeen string
	Relayed7d int
	// Clips7d: clips relayed in the last week (mediamesh_node_clips), of
	// which ClipsEstimated7d were estimated from bursts of unreadable packets.
	Clips7d          int
	ClipsEstimated7d int
}

func loadMediaMeshNodeStats(conn *sql.DB) (map[string]mediaMeshNodeStat, error) {
	out := map[string]mediaMeshNodeStat{}
	if !tableExists(conn, "mediamesh_node_stats") {
		return out, nil
	}
	rows, err := conn.Query(`SELECT public_key, first_seen, relayed_7d FROM mediamesh_node_stats`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var pk string
		var st mediaMeshNodeStat
		if err := rows.Scan(&pk, &st.FirstSeen, &st.Relayed7d); err != nil {
			return nil, err
		}
		out[strings.ToLower(pk)] = st
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if !tableExists(conn, "mediamesh_node_clips") {
		return out, nil
	}
	crows, err := conn.Query(`SELECT public_key, clips_7d, estimated_7d FROM mediamesh_node_clips`)
	if err != nil {
		return nil, err
	}
	defer crows.Close()
	for crows.Next() {
		var pk string
		var n, est int
		if err := crows.Scan(&pk, &n, &est); err != nil {
			return nil, err
		}
		k := strings.ToLower(pk)
		st := out[k]
		st.Clips7d, st.ClipsEstimated7d = n, est
		out[k] = st
	}
	return out, crows.Err()
}

// mediaMeshEdge is one pair of nodes photos, video or voice went between
// directly this week (the ingestor's mediamesh_edge), a < b.
type mediaMeshEdge struct {
	A, B    string
	Packets int
}

// loadMediaMeshBackbone reads the week's backbone and the per-day relay
// counts (public key -> "2006-01-02" -> packets).
func loadMediaMeshBackbone(conn *sql.DB) ([]mediaMeshEdge, map[string]map[string]int, error) {
	edges := []mediaMeshEdge{}
	daily := map[string]map[string]int{}
	if tableExists(conn, "mediamesh_edge") {
		rows, err := conn.Query(`SELECT a, b, packets FROM mediamesh_edge ORDER BY packets DESC, a, b`)
		if err != nil {
			return nil, nil, err
		}
		for rows.Next() {
			var e mediaMeshEdge
			if err := rows.Scan(&e.A, &e.B, &e.Packets); err != nil {
				rows.Close()
				return nil, nil, err
			}
			e.A, e.B = strings.ToLower(e.A), strings.ToLower(e.B)
			edges = append(edges, e)
		}
		rows.Close()
	}
	if tableExists(conn, "mediamesh_node_daily") {
		rows, err := conn.Query(`SELECT public_key, day, packets FROM mediamesh_node_daily`)
		if err != nil {
			return nil, nil, err
		}
		defer rows.Close()
		for rows.Next() {
			var pk, day string
			var n int
			if err := rows.Scan(&pk, &day, &n); err != nil {
				return nil, nil, err
			}
			pk = strings.ToLower(pk)
			if daily[pk] == nil {
				daily[pk] = map[string]int{}
			}
			daily[pk][day] = n
		}
	}
	return edges, daily, nil
}

// mediaMeshNodeStatOf is one node's history, zero without one.
func mediaMeshNodeStatOf(pk string) mediaMeshNodeStat {
	if p := mediaMeshStats.Load(); p != nil {
		return (*p)[strings.ToLower(pk)]
	}
	return mediaMeshNodeStat{}
}

// mediaMeshUnknownAt lists the unknown MediaMesh repeaters with current
// evidence, by the same windows as node marks (relayed 2 days, heard 7).
func mediaMeshUnknownAt(now time.Time) []MediaMeshUnknown {
	out := []MediaMeshUnknown{}
	p := mediaMeshUnknown.Load()
	if p == nil {
		return out
	}
	for _, u := range *p {
		t, err := time.Parse(time.RFC3339, u.LastSeen)
		if err != nil {
			continue
		}
		window := mediaMeshEvidenceWindow
		if u.Source == "relayed" {
			window = mediaMeshRelayedWindow
		}
		if now.Sub(t) <= window {
			out = append(out, u)
		}
	}
	return out
}

// observationMediaMesh reports whether one observation was carried on radio2.
func observationMediaMesh(obsID int) bool {
	mediaMeshMu.RLock()
	_, ok := mediaMeshObs[obsID]
	mediaMeshMu.RUnlock()
	return ok
}

// markObservationRadios marks an observation's JSON as MediaMesh, and as also
// heard on the main radio ("main_mesh") when the observer heard the same path
// on both: the two copies share one observation row.
func markObservationRadios(m map[string]interface{}, obsID int) {
	if !observationMediaMesh(obsID) {
		return
	}
	m["mediamesh"] = true
	mediaMeshMu.RLock()
	_, both := mediaMeshMainObs[obsID]
	mediaMeshMu.RUnlock()
	if both {
		m["main_mesh"] = true
	}
}

// txMediaMesh reports whether any observation of tx was carried on radio2.
func txMediaMesh(tx *StoreTx) bool {
	if tx == nil {
		return false
	}
	mediaMeshMu.RLock()
	defer mediaMeshMu.RUnlock()
	if len(mediaMeshObs) == 0 {
		return false
	}
	return txMediaMeshLocked(tx)
}

// txMediaMeshLocked is txMediaMesh for a caller that holds mediaMeshMu.
func txMediaMeshLocked(tx *StoreTx) bool {
	for _, o := range tx.Observations {
		if _, ok := mediaMeshObs[o.ID]; ok {
			return true
		}
	}
	return false
}

// markMediaMesh adds `"mediamesh": true` to an API object when on.
func markMediaMesh(m map[string]interface{}, on bool) {
	if on {
		m["mediamesh"] = true
	}
}

// nodeMediaMeshAt returns the node's MediaMesh mark: nil when it has none, it
// last said radio2 is off, or the evidence is older than the window.
func nodeMediaMeshAt(pubkey string, now time.Time) *MediaMeshNode {
	p := mediaMeshNodes.Load()
	if p == nil || pubkey == "" {
		return nil
	}
	n, ok := (*p)[strings.ToLower(pubkey)]
	if !ok || n.Mode == "off" {
		return nil
	}
	window := mediaMeshEvidenceWindow
	if n.Source == "relayed" {
		window = mediaMeshRelayedWindow
	}
	if t, err := time.Parse(time.RFC3339, n.LastSeen); err == nil && now.Sub(t) > window {
		return nil
	}
	return &n
}

// EnrichNodeWithMediaMesh adds `"mediamesh": {...}` to a node that runs it.
func EnrichNodeWithMediaMesh(node map[string]interface{}, pubkey string) {
	if n := nodeMediaMeshAt(pubkey, time.Now()); n != nil {
		node["mediamesh"] = n
	} else {
		delete(node, "mediamesh")
	}
}

func loadMediaMeshObservations(conn *sql.DB, sinceID int64) (map[int]struct{}, int64, error) {
	out := map[int]struct{}{}
	maxID := sinceID
	if !tableExists(conn, "observation_mediamesh") {
		return out, maxID, nil
	}
	rows, err := conn.Query(`SELECT observation_id FROM observation_mediamesh
		WHERE observation_id > ? ORDER BY observation_id`, sinceID)
	if err != nil {
		return nil, sinceID, err
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, sinceID, err
		}
		out[int(id)] = struct{}{}
		maxID = id
	}
	return out, maxID, rows.Err()
}

// loadObservationIDs reads a sparse observation_id table above sinceID
// (empty when the table doesn't exist yet).
func loadObservationIDs(conn *sql.DB, table string, sinceID int64) (map[int]struct{}, error) {
	out := map[int]struct{}{}
	if !tableExists(conn, table) {
		return out, nil
	}
	rows, err := conn.Query(`SELECT observation_id FROM `+table+` WHERE observation_id > ?`, sinceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out[int(id)] = struct{}{}
	}
	return out, rows.Err()
}

func loadMediaMeshNodes(conn *sql.DB, since string) (map[string]MediaMeshNode, string, error) {
	out := map[string]MediaMeshNode{}
	newest := since
	if !tableExists(conn, "node_mediamesh") {
		return out, newest, nil
	}
	rows, err := conn.Query(`SELECT public_key, mode, COALESCE(radio, ''), source, last_seen
		FROM node_mediamesh WHERE last_seen > ?`, since)
	if err != nil {
		return nil, since, err
	}
	defer rows.Close()
	for rows.Next() {
		var pk string
		var n MediaMeshNode
		if err := rows.Scan(&pk, &n.Mode, &n.Radio, &n.Source, &n.LastSeen); err != nil {
			return nil, since, err
		}
		n.Radio = canonicalRadio(n.Radio)
		out[strings.ToLower(pk)] = n
		if n.LastSeen > newest {
			newest = n.LastSeen
		}
	}
	return out, newest, rows.Err()
}

// refreshMediaMesh brings the in-memory MediaMesh state up to date. full=false
// is the per-tick check: observation ids above the last one seen, and node
// rows stamped after the newest one loaded.
func refreshMediaMesh(conn *sql.DB, full bool) {
	if conn == nil {
		return
	}
	mediaMeshRefresh.Lock()
	defer mediaMeshRefresh.Unlock()

	mediaMeshMu.RLock()
	sinceObs, sinceTS := mediaMeshMaxObsID, mediaMeshNodesTS
	mediaMeshMu.RUnlock()
	if full {
		sinceObs, sinceTS = 0, ""
	}

	ids, maxID, err := loadMediaMeshObservations(conn, sinceObs)
	if err != nil {
		log.Printf("[mediamesh] observations: %v", err)
		return
	}
	mainIDs, err := loadObservationIDs(conn, "observation_mainmesh", sinceObs)
	if err != nil {
		log.Printf("[mediamesh] main-radio copies: %v", err)
		return
	}
	if full || time.Since(mediaMeshAuxAt) >= mediaMeshAuxReload {
		refreshMediaMeshAux(conn)
	}
	nodes, newest, err := loadMediaMeshNodes(conn, sinceTS)
	if err != nil {
		log.Printf("[mediamesh] nodes: %v", err)
		return
	}

	mediaMeshMu.Lock()
	if full {
		mediaMeshObs = ids
		mediaMeshMainObs = mainIDs
	} else {
		for id := range ids {
			mediaMeshObs[id] = struct{}{}
		}
		for id := range mainIDs {
			mediaMeshMainObs[id] = struct{}{}
		}
	}
	mediaMeshMaxObsID = maxID
	mediaMeshNodesTS = newest
	mediaMeshMu.Unlock()

	if full || len(nodes) > 0 {
		merged := nodes
		if !full {
			if cur := mediaMeshNodes.Load(); cur != nil {
				merged = make(map[string]MediaMeshNode, len(*cur)+len(nodes))
				for k, v := range *cur {
					merged[k] = v
				}
				for k, v := range nodes {
					merged[k] = v
				}
			}
		}
		mediaMeshNodes.Store(&merged)
	}
}

// refreshMediaMeshAux reads the tables the ingestor rebuilds every half
// hour: unknown repeaters, node stats and clips, backbone and daily counts.
func refreshMediaMeshAux(conn *sql.DB) {
	mediaMeshAuxAt = time.Now()
	if unknown, err := loadMediaMeshUnknown(conn); err != nil {
		log.Printf("[mediamesh] unknown repeaters: %v", err)
	} else {
		mediaMeshUnknown.Store(&unknown)
	}
	if stats, err := loadMediaMeshNodeStats(conn); err != nil {
		log.Printf("[mediamesh] node stats: %v", err)
	} else {
		mediaMeshStats.Store(&stats)
	}
	if edges, daily, err := loadMediaMeshBackbone(conn); err != nil {
		log.Printf("[mediamesh] backbone: %v", err)
	} else {
		mediaMeshEdges.Store(&edges)
		mediaMeshDaily.Store(&daily)
	}
}

// runMediaMesh loads the state now and fully again every mediaMeshFullReload
// until ctx ends. The poller does the per-tick part.
func runMediaMesh(ctx context.Context, conn *sql.DB) {
	refreshMediaMesh(conn, true)
	go func() {
		t := time.NewTicker(mediaMeshFullReload)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				refreshMediaMesh(conn, true)
			}
		}
	}()
}
