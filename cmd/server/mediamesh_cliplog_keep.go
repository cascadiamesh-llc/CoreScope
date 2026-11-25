package main

// Keeping each clip's flight recorder for a week, so its path can be
// replayed on a map after its packets leave memory (memory holds hours).
// Every few minutes (keepMMClipsLoop) the log of each clip heard in the
// last mmClipLogFresh is worked out and kept beside the coverage points
// (mm_cliplogs), only ever written over by a fuller one; the flight
// recorder endpoint answers from it when memory has less. Clips on private
// channels get a log too: their packets in the order heard, each with every
// path it took (mediaMeshPrivateClipLog).

import (
	"database/sql"
	"encoding/json"
	"log"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	mmClipLogKeepDays = 8
	// a clip is still being heard (its log kept again) this long after its
	// last piece: repair rounds come minutes later
	mmClipLogFresh = 90 * time.Minute
)

func ensureMMClipLogs(db *sql.DB) error {
	_, err := db.Exec(`CREATE TABLE IF NOT EXISTS mm_cliplogs (sid TEXT PRIMARY KEY, at TEXT NOT NULL, heard INTEGER NOT NULL, log TEXT NOT NULL);
	CREATE INDEX IF NOT EXISTS mm_cliplogs_at ON mm_cliplogs (at)`)
	return err
}

// keepClipLog writes l under key where it's fuller than the kept one.
func keepClipLog(db *sql.DB, key, at string, l *MediaMeshClipLog) error {
	if l == nil || len(l.Pieces) == 0 {
		return nil
	}
	if err := ensureMMClipLogs(db); err != nil {
		return err
	}
	b, err := json.Marshal(l)
	if err != nil {
		return err
	}
	_, err = db.Exec(`INSERT INTO mm_cliplogs (sid, at, heard, log) VALUES (?, ?, ?, ?)
		ON CONFLICT(sid) DO UPDATE SET at = excluded.at, heard = excluded.heard, log = excluded.log
		WHERE excluded.heard > mm_cliplogs.heard`, key, at, clipLogHeard(l), string(b))
	return err
}

// keptClipLog: the kept log of the clip with key raw, or nil.
func keptClipLog(db *sql.DB, raw string) *MediaMeshClipLog {
	if ensureMMClipLogs(db) != nil {
		return nil
	}
	var s string
	if db.QueryRow(`SELECT log FROM mm_cliplogs WHERE sid = ?`, raw).Scan(&s) != nil {
		return nil
	}
	var l MediaMeshClipLog
	if json.Unmarshal([]byte(s), &l) != nil {
		return nil
	}
	return &l
}

// keptClipLogKeys: the keys of the logs kept for clips since `since`.
func keptClipLogKeys(db *sql.DB, since string) map[string]bool {
	out := map[string]bool{}
	if ensureMMClipLogs(db) != nil {
		return out
	}
	rows, err := db.Query(`SELECT sid FROM mm_cliplogs WHERE at >= ?`, since)
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var k string
		if rows.Scan(&k) == nil {
			out[k] = true
		}
	}
	return out
}

func pruneMMClipLogs(db *sql.DB, days int) {
	if ensureMMClipLogs(db) != nil {
		return
	}
	db.Exec(`DELETE FROM mm_cliplogs WHERE at < ?`, time.Now().UTC().Add(-time.Duration(days)*24*time.Hour).Format(time.RFC3339))
}

// keepMMClipLogsNow keeps the log of every clip in out heard in the last
// mmClipLogFresh.
func (s *Server) keepMMClipLogsNow(db *sql.DB, out *MediaMeshClips, now time.Time) {
	if s.store == nil {
		return
	}
	since := now.Add(-24 * time.Hour).Format(time.RFC3339)
	for _, list := range [][]MediaMeshClip{out.Clips, out.Unannounced, out.PrivateChannel} {
		for _, c := range list {
			last := parseTimestamp(c.LastAt)
			if last.IsZero() {
				last = parseTimestamp(c.At)
			}
			if last.IsZero() || now.Sub(last) > mmClipLogFresh {
				continue
			}
			build, ok := clipLogBuilder(strings.ToLower(c.SID))
			if !ok {
				continue
			}
			if err := keepClipLog(db, strings.ToLower(c.SID), clipAt(c), build(s.store, since)); err != nil {
				log.Printf("[mediamesh] keeping the log of clip %s: %v", c.SID, err)
				return
			}
		}
	}
}

// markReplays says which clips can be replayed: those with a kept log, or
// heard since memory's oldest packet (memFrom, RFC 3339).
func markReplays(out *MediaMeshClips, kept map[string]bool, memFrom string) {
	mark := func(list []MediaMeshClip) {
		for i := range list {
			c := &list[i]
			c.Replay = c.Heard > 0 && (kept[strings.ToLower(c.SID)] || (memFrom != "" && clipAt(*c) >= memFrom))
		}
	}
	mark(out.Clips)
	mark(out.Unannounced)
	mark(out.PrivateChannel)
}

// parsePrivateClipKey reads a private-channel clip's key: "p", the channel
// hash (2 hex digits, or "xx" when unknown), then the unix second its first
// piece was heard, in hex.
func parsePrivateClipKey(raw string) (ch int, first time.Time, ok bool) {
	if len(raw) < 4 || raw[0] != 'p' {
		return 0, time.Time{}, false
	}
	ch = -1
	if raw[1:3] != "xx" {
		v, err := strconv.ParseUint(raw[1:3], 16, 8)
		if err != nil {
			return 0, time.Time{}, false
		}
		ch = int(v)
	}
	sec, err := strconv.ParseInt(raw[3:], 16, 64)
	if err != nil || sec <= 0 {
		return 0, time.Time{}, false
	}
	return ch, time.Unix(sec, 0).UTC(), true
}

// mediaMeshPrivateClipLog: the log of the private-channel clip on channel
// ch whose first piece was heard at first: its unreadable channel data on
// radio2 from then on, until a gap of privateClipGap.
func (s *PacketStore) mediaMeshPrivateClipLog(key string, ch int, first time.Time) *MediaMeshClipLog {
	out := &MediaMeshClipLog{SID: key, Private: true, Pieces: []MediaMeshClipPiece{}, Hops: map[string]MediaMeshClipHop{}}
	type pk struct {
		at    time.Time
		piece MediaMeshClipPiece
		pp    privatePiece
	}
	var xs []pk
	hopSet := map[string]bool{}
	since := first.Add(-2 * time.Minute).Format(time.RFC3339)
	until := first.Add(3 * time.Hour)
	s.mu.RLock()
	mediaMeshMu.RLock()
	for _, tx := range s.packets {
		if tx == nil || tx.FirstSeen < since {
			continue
		}
		c, unreadable := mediaUnreadableChannel(tx)
		if !unreadable || c != ch {
			continue
		}
		at := parseTimestamp(tx.FirstSeen)
		if at.After(until) {
			continue
		}
		x := pk{at: at, piece: MediaMeshClipPiece{Hash: tx.Hash, Bytes: len(tx.RawHex) / 2, Heard: []MediaMeshClipHeard{}},
			pp: privatePiece{channel: ch, at: at}}
		for _, o := range tx.Observations {
			if _, ok := mediaMeshObs[o.ID]; !ok {
				continue
			}
			p := parsePathJSON(o.PathJSON)
			if p == nil {
				p = []string{}
			}
			for _, h := range p {
				hopSet[strings.ToLower(h)] = true
			}
			when := o.Timestamp
			if when == "" {
				when = tx.FirstSeen
			}
			x.piece.Heard = append(x.piece.Heard, MediaMeshClipHeard{Observer: o.ObserverID, Name: o.ObserverName, At: when, Path: p})
			x.pp.obs = append(x.pp.obs, privateObs{observer: o.ObserverID, name: o.ObserverName, path: p})
		}
		if len(x.piece.Heard) > 0 {
			xs = append(xs, x)
		}
	}
	mediaMeshMu.RUnlock()
	s.mu.RUnlock()
	sort.Slice(xs, func(i, j int) bool { return xs[i].at.Before(xs[j].at) })
	start := -1
	for i, x := range xs {
		if !x.at.Before(first.Add(-time.Second)) {
			start = i
			break
		}
	}
	if start < 0 {
		return out
	}
	end := start + 1
	for end < len(xs) && xs[end].at.Sub(xs[end-1].at) < privateClipGap {
		end++
	}
	var pps []privatePiece
	for i, x := range xs[start:end] {
		p := x.piece
		p.Index = i
		sort.Slice(p.Heard, func(a, b int) bool { return p.Heard[a].At < p.Heard[b].At })
		out.Pieces = append(out.Pieces, p)
		pps = append(pps, x.pp)
	}
	c := privateChannelClip(ch, pps)
	c.SID = key
	out.Clip = &c
	out.Hops = s.clipLogHops(hopSet)
	return out
}
