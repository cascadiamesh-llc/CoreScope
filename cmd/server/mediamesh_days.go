package main

// The time machine (public/mediamesh-timemachine.js): MediaMesh day by day.
// Each day's state is kept beside the coverage points (the mm_days table):
// the MediaMesh repeaters with their positions, the links heard on radio2,
// the week's backbone and the day's packet counts, written over through the
// day and kept as they ended. Days before the first one kept are put
// together in the browser from when each repeater was first seen.
//
// GET /api/mediamesh/history →
//   { "days": [{ "day" (YYYY-MM-DD, UTC), "repeaters": [{ "k", "n", "lat",
//     "lon" }], "links": [{ "from", "observer", "count", "snr" }],
//     "backbone": [{ "a", "b", "a_lat", "a_lon", "b_lat", "b_lon",
//     "packets" }], "transmissions", "media_packets" }] }

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"sync"
	"time"
)

const mmDaysMinGap = 30 * time.Minute

// mmDay is one day of MediaMesh.
type mmDay struct {
	Day           string      `json:"day"`
	Repeaters     []mmDayRep  `json:"repeaters"`
	Links         []mmDayLink `json:"links"`
	Backbone      []mmDayEdge `json:"backbone"`
	Transmissions int         `json:"transmissions"`
	MediaPackets  int         `json:"media_packets"`
}

type mmDayRep struct {
	Key  string  `json:"k"`
	Name string  `json:"n,omitempty"`
	Lat  float64 `json:"lat"`
	Lon  float64 `json:"lon"`
}

type mmDayLink struct {
	From     string   `json:"from"`
	Observer string   `json:"observer"`
	Count    int      `json:"count"`
	SNR      *float64 `json:"snr,omitempty"`
}

type mmDayEdge struct {
	A       string  `json:"a"`
	B       string  `json:"b"`
	ALat    float64 `json:"a_lat"`
	ALon    float64 `json:"a_lon"`
	BLat    float64 `json:"b_lat"`
	BLon    float64 `json:"b_lon"`
	Packets int     `json:"packets"`
}

var mmDaysMu sync.Mutex
var mmDaysLast time.Time

// dayFrom: a day of MediaMesh from the analytics, as the time machine keeps
// it. shown leaves out nodes that mustn't be named (blacklisted, hidden).
func dayFrom(day string, mm *MediaMeshAnalytics, shown func(string) bool) mmDay {
	d := mmDay{Day: day, Repeaters: []mmDayRep{}, Links: []mmDayLink{}, Backbone: []mmDayEdge{}}
	if mm == nil {
		return d
	}
	for _, r := range mm.Repeaters {
		if r.Lat == nil || r.Lon == nil || r.PositionFromName || (shown != nil && !shown(r.PublicKey)) {
			continue
		}
		d.Repeaters = append(d.Repeaters, mmDayRep{Key: r.PublicKey, Name: r.Name, Lat: *r.Lat, Lon: *r.Lon})
	}
	for _, l := range mm.Links {
		if shown != nil && !shown(l.From) {
			continue
		}
		d.Links = append(d.Links, mmDayLink{From: l.From, Observer: l.ObserverID, Count: l.Count, SNR: l.AvgSNR})
	}
	for _, e := range mm.Backbone {
		if shown != nil && (!shown(e.A) || !shown(e.B)) {
			continue
		}
		d.Backbone = append(d.Backbone, mmDayEdge{A: e.A, B: e.B, ALat: e.ALat, ALon: e.ALon, BLat: e.BLat, BLon: e.BLon, Packets: e.Packets})
	}
	d.Transmissions = mm.MediaMeshTransmissions
	d.MediaPackets = mm.Media.Packets
	return d
}

func ensureMMDays(db *sql.DB) error {
	_, err := db.Exec(`CREATE TABLE IF NOT EXISTS mm_days (day TEXT PRIMARY KEY, snap TEXT NOT NULL)`)
	return err
}

// recordMMDay writes (over) the day's row.
func recordMMDay(db *sql.DB, d mmDay) error {
	if err := ensureMMDays(db); err != nil {
		return err
	}
	b, err := json.Marshal(d)
	if err != nil {
		return err
	}
	_, err = db.Exec(`INSERT OR REPLACE INTO mm_days (day, snap) VALUES (?, ?)`, d.Day, string(b))
	return err
}

// readMMDays: every day kept, oldest first.
func readMMDays(db *sql.DB) ([]mmDay, error) {
	if err := ensureMMDays(db); err != nil {
		return nil, err
	}
	rows, err := db.Query(`SELECT snap FROM mm_days ORDER BY day`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []mmDay{}
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			return nil, err
		}
		var d mmDay
		if json.Unmarshal([]byte(s), &d) == nil && d.Day != "" {
			out = append(out, d)
		}
	}
	return out, rows.Err()
}

// recordMMDayNow: today's row from the last day's analytics, at most every
// mmDaysMinGap unless forced.
func (s *Server) recordMMDayNow(st *covPointsStore, force bool) {
	if s.store == nil || st == nil {
		return
	}
	mmDaysMu.Lock()
	defer mmDaysMu.Unlock()
	now := time.Now().UTC()
	if !force && now.Sub(mmDaysLast) < mmDaysMinGap {
		return
	}
	mmDaysLast = now
	mm := s.store.GetMediaMeshAnalytics("", TimeWindow{Since: now.Add(-24 * time.Hour).Format(time.RFC3339), Label: "24h"})
	_ = recordMMDay(st.db, dayFrom(now.Format("2006-01-02"), mm, s.mediaMeshNodeShown))
}

func (s *Server) handleMediaMeshHistory(w http.ResponseWriter, r *http.Request) {
	st, err := s.coveragePoints()
	if st == nil {
		writeError(w, http.StatusServiceUnavailable, err.Error())
		return
	}
	s.recordMMDayNow(st, false)
	days, err := readMMDays(st.db)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	w.Header().Set("Cache-Control", "public, max-age=300")
	writeJSON(w, map[string]interface{}{"days": days})
}
