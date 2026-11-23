package main

// Keeping clips past the packets in memory. The clips, the hourly traffic
// and how fast clips crossed (/api/analytics/mediamesh/clips) are worked
// out from the packets in memory, and memory holds only as many packets as
// fit: with every packet heard by dozens of observers, that can be a few
// hours, not the week asked for. So every few minutes, and whenever the
// clips are asked for, the clips worked out are kept beside the coverage
// points (the mm_clips and mm_clip_hours tables), and the answer is what
// was kept for the period with what's in memory now laid over it.
//
// A clip worked out again once its first pieces have left memory looks
// worse than it was, so a clip is only written over by a better account of
// it (whole before partial, then more pieces heard), and an hour keeps the
// most packets and clips it was ever seen with.

import (
	"database/sql"
	"encoding/json"
	"log"
	"sort"
	"time"
)

const (
	mmClipKeepEvery = 5 * time.Minute
	mmClipKeepDays  = 35
)

func ensureMMClips(db *sql.DB) error {
	_, err := db.Exec(`CREATE TABLE IF NOT EXISTS mm_clips (
		kind TEXT NOT NULL, sid TEXT NOT NULL, at TEXT NOT NULL, clip TEXT NOT NULL,
		PRIMARY KEY (kind, sid));
	CREATE INDEX IF NOT EXISTS mm_clips_at ON mm_clips (at);
	CREATE TABLE IF NOT EXISTS mm_clip_hours (
		t TEXT PRIMARY KEY, packets INTEGER NOT NULL, clips INTEGER NOT NULL, partial INTEGER NOT NULL)`)
	return err
}

// clipRank orders accounts of one clip: whole, then rebuilt from repair
// pieces, then partial, then none; then more pieces heard, more observers,
// a longer span.
func clipBetter(a, b MediaMeshClip) bool {
	rank := func(o string) int {
		switch o {
		case "whole":
			return 4
		case "parity":
			return 3
		case "partial":
			return 2
		case "unannounced":
			return 1
		}
		return 0
	}
	if rank(a.Outcome) != rank(b.Outcome) {
		return rank(a.Outcome) > rank(b.Outcome)
	}
	if a.Heard+a.Parity != b.Heard+b.Parity {
		return a.Heard+a.Parity > b.Heard+b.Parity
	}
	if a.Observers != b.Observers {
		return a.Observers > b.Observers
	}
	return a.DurationS > b.DurationS
}

func clipAt(c MediaMeshClip) string {
	if c.At != "" {
		return c.At
	}
	return c.FirstAt
}

// keepMMClips writes the clips and hours worked out, where better than kept.
func keepMMClips(db *sql.DB, out *MediaMeshClips) error {
	if err := ensureMMClips(db); err != nil {
		return err
	}
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	put := func(kind string, c MediaMeshClip) error {
		if c.SID == "" || clipAt(c) == "" {
			return nil
		}
		c.Delivery = nil // receipts are added when asked
		var old string
		switch err := tx.QueryRow(`SELECT clip FROM mm_clips WHERE kind = ? AND sid = ?`, kind, c.SID).Scan(&old); err {
		case nil:
			var o MediaMeshClip
			if json.Unmarshal([]byte(old), &o) == nil && !clipBetter(c, o) {
				return nil
			}
		case sql.ErrNoRows:
		default:
			return err
		}
		b, err := json.Marshal(c)
		if err != nil {
			return err
		}
		_, err = tx.Exec(`INSERT OR REPLACE INTO mm_clips (kind, sid, at, clip) VALUES (?, ?, ?, ?)`, kind, c.SID, clipAt(c), string(b))
		return err
	}
	for _, c := range out.Clips {
		if err := put("a", c); err != nil {
			return err
		}
	}
	for _, c := range out.Unannounced {
		if err := put("u", c); err != nil {
			return err
		}
	}
	for _, h := range out.Hours {
		if _, err := tx.Exec(`INSERT INTO mm_clip_hours (t, packets, clips, partial) VALUES (?, ?, ?, ?)
			ON CONFLICT(t) DO UPDATE SET packets = MAX(packets, excluded.packets),
				clips = MAX(clips, excluded.clips), partial = MAX(partial, excluded.partial)`,
			h.T, h.Packets, h.Clips, h.Partial); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// keptMMClips: the clips and hours kept since `since` (RFC 3339).
func keptMMClips(db *sql.DB, since string) (*MediaMeshClips, error) {
	if err := ensureMMClips(db); err != nil {
		return nil, err
	}
	out := &MediaMeshClips{Clips: []MediaMeshClip{}, Hours: []MediaMeshClipHour{}, Unannounced: []MediaMeshClip{}}
	rows, err := db.Query(`SELECT kind, clip FROM mm_clips WHERE at >= ?`, since)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var kind, s string
		if err := rows.Scan(&kind, &s); err != nil {
			rows.Close()
			return nil, err
		}
		var c MediaMeshClip
		if json.Unmarshal([]byte(s), &c) != nil {
			continue
		}
		if kind == "a" {
			out.Clips = append(out.Clips, c)
		} else {
			out.Unannounced = append(out.Unannounced, c)
		}
	}
	rows.Close()
	hs, err := db.Query(`SELECT t, packets, clips, partial FROM mm_clip_hours WHERE t >= ? ORDER BY t`, parseTimestamp(since).UTC().Truncate(time.Hour).Format(time.RFC3339))
	if err != nil {
		return nil, err
	}
	defer hs.Close()
	for hs.Next() {
		var h MediaMeshClipHour
		if err := hs.Scan(&h.T, &h.Packets, &h.Clips, &h.Partial); err != nil {
			return nil, err
		}
		out.Hours = append(out.Hours, h)
	}
	return out, hs.Err()
}

// mergeMMClips lays the clips worked out now (fresh) over those kept: the
// better account of each clip, the larger count for each hour, a clip once
// announced never also listed as unannounced. Newest first, at most
// mediaClipsMax of each.
func mergeMMClips(kept, fresh *MediaMeshClips) {
	pick := func(a, b []MediaMeshClip) []MediaMeshClip {
		by := map[string]MediaMeshClip{}
		for _, list := range [][]MediaMeshClip{a, b} {
			for _, c := range list {
				if o, ok := by[c.SID]; !ok || clipBetter(c, o) {
					by[c.SID] = c
				}
			}
		}
		out := make([]MediaMeshClip, 0, len(by))
		for _, c := range by {
			out = append(out, c)
		}
		sort.Slice(out, func(i, j int) bool {
			return clipAt(out[i]) > clipAt(out[j]) || (clipAt(out[i]) == clipAt(out[j]) && out[i].SID < out[j].SID)
		})
		if len(out) > mediaClipsMax {
			out = out[:mediaClipsMax]
		}
		return out
	}
	fresh.Clips = pick(kept.Clips, fresh.Clips)
	announced := map[string]bool{}
	for _, c := range fresh.Clips {
		announced[c.SID] = true
	}
	un := []MediaMeshClip{}
	for _, c := range pick(kept.Unannounced, fresh.Unannounced) {
		if !announced[c.SID] {
			un = append(un, c)
		}
	}
	fresh.Unannounced = un
	hours := map[string]MediaMeshClipHour{}
	for _, list := range [][]MediaMeshClipHour{kept.Hours, fresh.Hours} {
		for _, h := range list {
			o := hours[h.T]
			o.T = h.T
			o.Packets = max(o.Packets, h.Packets)
			o.Clips = max(o.Clips, h.Clips)
			o.Partial = max(o.Partial, h.Partial)
			hours[h.T] = o
		}
	}
	fresh.Hours = fresh.Hours[:0]
	for _, h := range hours {
		fresh.Hours = append(fresh.Hours, h)
	}
	sort.Slice(fresh.Hours, func(i, j int) bool { return fresh.Hours[i].T < fresh.Hours[j].T })
}

func pruneMMClips(db *sql.DB, days int) {
	if ensureMMClips(db) != nil {
		return
	}
	cut := time.Now().UTC().Add(-time.Duration(days) * 24 * time.Hour).Format(time.RFC3339)
	db.Exec(`DELETE FROM mm_clips WHERE at < ?`, cut)
	db.Exec(`DELETE FROM mm_clip_hours WHERE t < ?`, cut)
}

// withKeptMMClips: out (worked out from memory) kept, then laid over what
// was kept for its period. Unchanged when there's nowhere to keep them.
func (s *Server) withKeptMMClips(out *MediaMeshClips) {
	st, _ := s.coveragePoints()
	if st == nil {
		return
	}
	if err := keepMMClips(st.db, out); err != nil {
		log.Printf("[mediamesh] keeping clips: %v", err)
	}
	kept, err := keptMMClips(st.db, out.From)
	if err != nil {
		log.Printf("[mediamesh] reading kept clips: %v", err)
		return
	}
	mergeMMClips(kept, out)
}

// keepMMClipsLoop keeps the last day's clips every mmClipKeepEvery, so
// they're kept whether or not anyone asks before their packets leave memory.
func (s *Server) keepMMClipsLoop(stop <-chan struct{}) {
	s.useKeptMMHours()
	t := time.NewTicker(mmClipKeepEvery)
	defer t.Stop()
	n := 0
	for {
		select {
		case <-t.C:
		case <-stop:
			return
		}
		st, _ := s.coveragePoints()
		if st == nil || s.store == nil {
			continue
		}
		now := time.Now().UTC()
		out := &MediaMeshClips{From: now.Add(-24 * time.Hour).Format(time.RFC3339), To: now.Format(time.RFC3339),
			Clips: []MediaMeshClip{}, Hours: []MediaMeshClipHour{}, Unannounced: []MediaMeshClip{}}
		s.store.mediaMeshClips(out.From, out)
		if err := keepMMClips(st.db, out); err != nil {
			log.Printf("[mediamesh] keeping clips: %v", err)
		}
		s.keepMMHoursNow(st)
		if n++; n%144 == 1 {
			pruneMMClips(st.db, mmClipKeepDays)
			pruneMMHours(st.db, mmClipKeepDays)
		}
	}
}
