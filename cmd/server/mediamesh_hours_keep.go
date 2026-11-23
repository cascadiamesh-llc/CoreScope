package main

// Keeping the MediaMesh analytics past the packets in memory, as a
// stop-gap while memory holds only hours: the counts, packet types, hours,
// observers, radio2 links and hop counts (computeMediaMeshAnalytics) are
// tallied hour by hour (mmTally) and every 5 minutes each hour's tally is
// kept beside the coverage points (mm_hours, 35 days), only ever written
// over by a fuller one. An answer for the whole network adds the kept
// hours that have lost packets from memory to the hours still in it. The
// repeaters and backbone already come from the ingestor's tables.

import (
	"database/sql"
	"encoding/json"
	"log"
	"sync/atomic"
	"time"
)

// mmKeptHours, when set, gives the kept hours of the window before `before`
// ("2006-01-02T15"). An empty window is the last week.
var mmKeptHours atomic.Pointer[func(window TimeWindow, before string) map[string]*mmTally]

const mmHoursDefaultSpan = 7 * 24 * time.Hour

func ensureMMHours(db *sql.DB) error {
	_, err := db.Exec(`CREATE TABLE IF NOT EXISTS mm_hours (hour TEXT PRIMARY KEY, total INTEGER NOT NULL, tally TEXT NOT NULL)`)
	return err
}

// keepMMHours writes each hour's tally where it's fuller than the one kept.
func keepMMHours(db *sql.DB, tallies map[string]*mmTally) error {
	if err := ensureMMHours(db); err != nil {
		return err
	}
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for h, t := range tallies {
		if h == "" || t == nil || t.Total == 0 {
			continue
		}
		b, err := json.Marshal(t)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(`INSERT INTO mm_hours (hour, total, tally) VALUES (?, ?, ?)
			ON CONFLICT(hour) DO UPDATE SET total = excluded.total, tally = excluded.tally
			WHERE excluded.total > mm_hours.total`, h, t.Total, string(b)); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// keptMMHours: the kept hours in the window and before `before`.
func keptMMHours(db *sql.DB, window TimeWindow, before string, now time.Time) (map[string]*mmTally, error) {
	if err := ensureMMHours(db); err != nil {
		return nil, err
	}
	from := now.UTC().Add(-mmHoursDefaultSpan).Format("2006-01-02T15")
	if window.Since != "" {
		from = mmHourOf(window.Since)
	}
	if window.Until != "" {
		if u := mmHourAfter(window.Until); u != "" && (before == "" || u < before) {
			before = u
		}
	}
	q, args := `SELECT hour, tally FROM mm_hours WHERE hour >= ?`, []interface{}{from}
	if before != "" {
		q += ` AND hour < ?`
		args = append(args, before)
	}
	rows, err := db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]*mmTally{}
	for rows.Next() {
		var h, s string
		if err := rows.Scan(&h, &s); err != nil {
			return nil, err
		}
		t := newMMTally()
		if json.Unmarshal([]byte(s), t) == nil {
			out[h] = t
		}
	}
	return out, rows.Err()
}

func pruneMMHours(db *sql.DB, days int) {
	if ensureMMHours(db) != nil {
		return
	}
	db.Exec(`DELETE FROM mm_hours WHERE hour < ?`, time.Now().UTC().Add(-time.Duration(days)*24*time.Hour).Format("2006-01-02T15"))
}

// useKeptMMHours lets the analytics read the kept hours.
func (s *Server) useKeptMMHours() {
	f := func(window TimeWindow, before string) map[string]*mmTally {
		st, _ := s.coveragePoints()
		if st == nil {
			return nil
		}
		out, err := keptMMHours(st.db, window, before, time.Now())
		if err != nil {
			log.Printf("[mediamesh] reading kept hours: %v", err)
			return nil
		}
		return out
	}
	mmKeptHours.Store(&f)
}

// keepMMHoursNow keeps the hours in memory now.
func (s *Server) keepMMHoursNow(st *covPointsStore) {
	if s.store == nil || st == nil {
		return
	}
	tallies, _ := s.store.mediaMeshTallies(nil, TimeWindow{})
	if err := keepMMHours(st.db, tallies); err != nil {
		log.Printf("[mediamesh] keeping hours: %v", err)
	}
}
