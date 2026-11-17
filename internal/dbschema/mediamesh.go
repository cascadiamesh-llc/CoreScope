package dbschema

import (
	"database/sql"
	"fmt"
)

// MediaMesh: a second LoRa profile ("radio2") that Keymind Cascade repeaters,
// Wadamesh TAK standalones and MeshCore Open TAK use for photos and voice.
// Observers tag what used it (Keymind Cascade MQTT_IMPLEMENTATION.md,
// "radio2 (MediaMesh)"):
//
//   - packets: `"mediamesh": true`, with `rx_radio_id` / `tx_radio_id`;
//   - status: `radios: [{id, radio, mode, mediamesh: true, temporary}]`;
//   - neighbors: `self.radio2` and each neighbour's `radio2` {mode, radio}.
//
// observation_mediamesh is sparse like observation_radios: one row per
// observation that came with `mediamesh: true`, keyed by the observation, so
// the observations table and every query that scans it stay untouched.
//
// node_mediamesh holds the newest evidence that a node runs MediaMesh (mode
// rx|rxtx) or not (off): the node's own status, a neighbour's report of it,
// or the node heard sending on radio2 (source "heard", mode rxtx). A later
// row replaces an older one; "off" clears the mark. Weakest is "relayed" (an
// earlier hop of a MediaMesh flood): it only adds a mark or refreshes a
// relayed one, never replacing the others.
//
// Neither is required by AssertReady: a server that comes up before the
// ingestor created them shows no MediaMesh marks and probes again on its next
// refresh, the same rule as observer_radios.
//
// PREFLIGHT: async=false reason="two small tables, no backfill"
func ensureMediaMesh(rw *sql.DB) error {
	if _, err := rw.Exec(`
		CREATE TABLE IF NOT EXISTS observation_mediamesh (
			observation_id INTEGER PRIMARY KEY
		);
		-- A MediaMesh observation whose observer also heard the packet with
		-- the same path on the main radio: the two copies share one row (the
		-- dedup key has no radio), so this records the main-mesh copy.
		CREATE TABLE IF NOT EXISTS observation_mainmesh (
			observation_id INTEGER PRIMARY KEY
		);
		-- MediaMesh evidence for a repeater the analyzer has no advert from:
		-- only its path hash (2 or 3 bytes, upper-case hex) is known. Turned
		-- into a node_mediamesh mark once the hash matches exactly one node.
		CREATE TABLE IF NOT EXISTS mediamesh_prefix (
			prefix     TEXT PRIMARY KEY,
			source     TEXT NOT NULL,
			first_seen TEXT NOT NULL,
			last_seen  TEXT NOT NULL,
			packets    INTEGER NOT NULL DEFAULT 1
		);
		-- Where an unknown MediaMesh repeater sits: the named nodes next to its
		-- hash in MediaMesh paths over the last week. side: before (the hop
		-- that handed it the packet), after (the hop it handed it to) or
		-- observer (an observer that heard it directly). Rebuilt by the
		-- ingestor every half hour.
		CREATE TABLE IF NOT EXISTS mediamesh_prefix_next (
			prefix     TEXT NOT NULL,
			public_key TEXT NOT NULL,
			side       TEXT NOT NULL,
			packets    INTEGER NOT NULL,
			PRIMARY KEY (prefix, public_key, side)
		);
		-- Per node: when it was first seen on MediaMesh (the earliest photo or
		-- voice packet it relayed or heard; first_seen only ever moves
		-- earlier, so history outlives packet retention) and how many photo
		-- and voice packets it relayed in the last week. Rebuilt by the
		-- ingestor every half hour.
		CREATE TABLE IF NOT EXISTS mediamesh_node_stats (
			public_key TEXT PRIMARY KEY,
			first_seen TEXT NOT NULL,
			relayed_7d INTEGER NOT NULL DEFAULT 0
		);
		-- The MediaMesh backbone: pairs of nodes a photo, video or voice
		-- packet went between directly in the last week (adjacent resolved
		-- hops of its path, and the last hop to the observer that heard it),
		-- a < b, with the number of different packets. Rebuilt with
		-- mediamesh_node_stats.
		CREATE TABLE IF NOT EXISTS mediamesh_edge (
			a       TEXT NOT NULL,
			b       TEXT NOT NULL,
			packets INTEGER NOT NULL,
			PRIMARY KEY (a, b)
		);
		-- Photo, video and voice packets each node relayed per day (UTC),
		-- over the last two weeks. Rebuilt with mediamesh_node_stats.
		CREATE TABLE IF NOT EXISTS mediamesh_node_daily (
			public_key TEXT NOT NULL,
			day        TEXT NOT NULL,
			packets    INTEGER NOT NULL,
			PRIMARY KEY (public_key, day)
		);
		CREATE TABLE IF NOT EXISTS node_mediamesh (
			public_key TEXT PRIMARY KEY,
			mode       TEXT NOT NULL,
			radio      TEXT,
			source     TEXT NOT NULL,
			last_seen  TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_node_mediamesh_last_seen
			ON node_mediamesh(last_seen);
	`); err != nil {
		return fmt.Errorf("create mediamesh tables: %w", err)
	}
	return nil
}
