package main

// MediaMesh link history, for the Forecast (public/mediamesh-forecast.js):
// each link heard on radio2 (a node an observer heard straight off the air)
// as an hourly average SNR, kept beside the coverage points (the
// link_hours table) so it outlasts the packets the analyzer keeps in
// memory. Recorded from the packet store every 6 hours and whenever the
// history is asked for (at most every 30 minutes), kept 120 days.
//
// GET /api/mediamesh/link-history?days=30 →
//   { "hours": [{ "from", "observer_id", "hour" (RFC 3339, UTC), "snr", "n" }] }
//
// GET /api/mediamesh/weather?lat=&lon= passes on Open-Meteo's hourly
// weather for the place (the last 30 days and the next 4: temperature at
// 2 m and at 850 hPa, rain, wind), cached for an hour, so the Forecast
// needn't reach a third party from the browser.

import (
	"database/sql"
	"fmt"
	"io"
	"math"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	linkHistoryDays    = 120
	linkHistoryMinGap  = 30 * time.Minute
	linkHistoryMaxRows = 200000
)

// mediaMeshLinkHour is one link's receptions in one hour.
type mediaMeshLinkHour struct {
	From       string  `json:"from"`
	ObserverID string  `json:"observer_id"`
	Hour       string  `json:"hour"`
	SNR        float64 `json:"snr"`
	N          int     `json:"n"`
}

var linkHistoryMu sync.Mutex
var linkHistoryLast time.Time

// mediaMeshLinkHours: every radio2 link reception the store holds, by link
// and hour (the same receptions the analytics' links are made of).
func (s *PacketStore) mediaMeshLinkHours() []mediaMeshLinkHour {
	type agg struct {
		sum float64
		n   int
	}
	acc := map[string]*agg{}
	_, pm := s.getCachedNodesAndPM()
	s.mu.RLock()
	mediaMeshMu.RLock()
	if len(mediaMeshObs) > 0 {
		seen := make(map[string]bool, len(s.packets))
		for _, tx := range s.packets {
			if tx == nil {
				continue
			}
			if tx.Hash != "" {
				if seen[tx.Hash] {
					continue
				}
				seen[tx.Hash] = true
			}
			for _, o := range tx.Observations {
				if o == nil || o.SNR == nil || o.ObserverID == "" || len(o.Timestamp) < 13 || o.isOwnTransmission() {
					continue
				}
				if _, ok := mediaMeshObs[o.ID]; !ok {
					continue
				}
				if _, both := mediaMeshMainObs[o.ID]; both {
					continue
				}
				from := directHeardNode(tx, o, pm)
				if from == "" || from == strings.ToLower(o.ObserverID) {
					continue
				}
				key := from + "|" + strings.ToLower(o.ObserverID) + "|" + o.Timestamp[:13]
				a := acc[key]
				if a == nil {
					a = &agg{}
					acc[key] = a
				}
				a.sum += *o.SNR
				a.n++
			}
		}
	}
	mediaMeshMu.RUnlock()
	s.mu.RUnlock()
	out := make([]mediaMeshLinkHour, 0, len(acc))
	for k, a := range acc {
		p := strings.SplitN(k, "|", 3)
		t, err := time.Parse("2006-01-02T15", p[2])
		if err != nil {
			continue
		}
		out = append(out, mediaMeshLinkHour{From: p[0], ObserverID: p[1], Hour: t.UTC().Format(time.RFC3339), SNR: a.sum / float64(a.n), N: a.n})
	}
	return out
}

func ensureLinkHours(db *sql.DB) error {
	_, err := db.Exec(`CREATE TABLE IF NOT EXISTS link_hours (from_key TEXT NOT NULL, observer TEXT NOT NULL,
		hour INTEGER NOT NULL, snr REAL NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (from_key, observer, hour))`)
	return err
}

// recordLinkHours writes what the store holds into link_hours (an hour the
// store still has in full replaces what was written before) and drops what
// is older than linkHistoryDays.
func recordLinkHours(db *sql.DB, hours []mediaMeshLinkHour, now time.Time) error {
	if err := ensureLinkHours(db); err != nil {
		return err
	}
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	stmt, err := tx.Prepare(`INSERT OR REPLACE INTO link_hours (from_key, observer, hour, snr, n) VALUES (?, ?, ?, ?, ?)`)
	if err != nil {
		tx.Rollback()
		return err
	}
	for _, h := range hours {
		t, err := time.Parse(time.RFC3339, h.Hour)
		if err != nil {
			continue
		}
		if _, err := stmt.Exec(h.From, h.ObserverID, t.Unix(), h.SNR, h.N); err != nil {
			stmt.Close()
			tx.Rollback()
			return err
		}
	}
	stmt.Close()
	if _, err := tx.Exec(`DELETE FROM link_hours WHERE hour < ?`, now.Add(-linkHistoryDays*24*time.Hour).Unix()); err != nil {
		tx.Rollback()
		return err
	}
	return tx.Commit()
}

// readLinkHours: the hours since `since`, oldest first.
func readLinkHours(db *sql.DB, since time.Time) ([]mediaMeshLinkHour, error) {
	if err := ensureLinkHours(db); err != nil {
		return nil, err
	}
	rows, err := db.Query(`SELECT from_key, observer, hour, snr, n FROM link_hours WHERE hour >= ? ORDER BY hour LIMIT ?`, since.Unix(), linkHistoryMaxRows)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []mediaMeshLinkHour{}
	for rows.Next() {
		var h mediaMeshLinkHour
		var t int64
		if err := rows.Scan(&h.From, &h.ObserverID, &t, &h.SNR, &h.N); err != nil {
			return nil, err
		}
		h.Hour = time.Unix(t, 0).UTC().Format(time.RFC3339)
		out = append(out, h)
	}
	return out, rows.Err()
}

// recordLinkHistory: from the store into the table, at most every
// linkHistoryMinGap unless forced.
func (s *Server) recordLinkHistory(st *covPointsStore, force bool) {
	if s.store == nil || st == nil {
		return
	}
	linkHistoryMu.Lock()
	defer linkHistoryMu.Unlock()
	now := time.Now()
	if !force && now.Sub(linkHistoryLast) < linkHistoryMinGap {
		return
	}
	linkHistoryLast = now
	_ = recordLinkHours(st.db, s.store.mediaMeshLinkHours(), now)
}

func (s *Server) handleMediaMeshLinkHistory(w http.ResponseWriter, r *http.Request) {
	st, err := s.coveragePoints()
	if st == nil {
		writeError(w, http.StatusServiceUnavailable, err.Error())
		return
	}
	days := 30
	if v, err := strconv.Atoi(r.URL.Query().Get("days")); err == nil && v > 0 {
		days = v
	}
	if days > linkHistoryDays {
		days = linkHistoryDays
	}
	s.recordLinkHistory(st, false)
	hours, err := readLinkHours(st.db, time.Now().Add(-time.Duration(days)*24*time.Hour))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	w.Header().Set("Cache-Control", "public, max-age=300")
	writeJSON(w, map[string]interface{}{"hours": hours})
}

const weatherURL = "https://api.open-meteo.com/v1/forecast?latitude=%.2f&longitude=%.2f&hourly=temperature_2m,temperature_850hPa,precipitation,wind_speed_10m&past_days=30&forecast_days=4&timezone=UTC"

var weatherCache = struct {
	sync.Mutex
	m map[string]weatherEntry
}{m: map[string]weatherEntry{}}

type weatherEntry struct {
	at   time.Time
	body []byte
}

var weatherClient = &http.Client{Timeout: 15 * time.Second}

func (s *Server) handleMediaMeshWeather(w http.ResponseWriter, r *http.Request) {
	lat, err1 := strconv.ParseFloat(r.URL.Query().Get("lat"), 64)
	lon, err2 := strconv.ParseFloat(r.URL.Query().Get("lon"), 64)
	if err1 != nil || err2 != nil || math.Abs(lat) > 90 || math.Abs(lon) > 180 {
		writeError(w, http.StatusBadRequest, "lat and lon please")
		return
	}
	key := fmt.Sprintf("%.1f,%.1f", lat, lon)
	weatherCache.Lock()
	e, ok := weatherCache.m[key]
	weatherCache.Unlock()
	if !ok || time.Since(e.at) > time.Hour {
		resp, err := weatherClient.Get(fmt.Sprintf(weatherURL, lat, lon))
		if err != nil {
			writeError(w, http.StatusBadGateway, "the weather service could not be reached")
			return
		}
		body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
		resp.Body.Close()
		if err != nil || resp.StatusCode != http.StatusOK {
			writeError(w, http.StatusBadGateway, "the weather service did not answer")
			return
		}
		e = weatherEntry{at: time.Now(), body: body}
		weatherCache.Lock()
		if len(weatherCache.m) > 50 {
			weatherCache.m = map[string]weatherEntry{}
		}
		weatherCache.m[key] = e
		weatherCache.Unlock()
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "public, max-age=1800")
	w.Write(e.body)
}
