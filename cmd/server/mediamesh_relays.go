package main

// How clips cross radio2: how many MediaMesh repeaters relay each photo,
// video and voice piece, and how much of each hour each repeater's radio2
// spends sending them. From the paths the observers heard: every repeater
// named in any MediaMesh observation of a piece relayed it. Each relay costs
// the piece's LoRa time on air at the radio2 preset (mmRadio2Preset).
//
// Memory holds hours of packets, not the week, so each hour is tallied
// (mmRelayHour) and kept beside the coverage points (mm_relay_hours, as
// long as the clips), only ever written over by a fuller tally. The answer
// is the kept hours with the hours still in memory laid over them.
//
// GET /api/analytics/mediamesh/relays?days=7

import (
	"database/sql"
	"encoding/json"
	"log"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/meshcore-analyzer/lora"
)

// mmRadio2Preset: MediaMesh's radio2, 250 kHz SF7 CR 4/5.
func mmRadio2Preset() lora.Preset {
	return lora.Preset{BWkHz: 250, SF: 7, CR: 5, Preamble: lora.PreambleForSF(7)}
}

// mmRelayHour is one hour's tally of clip pieces relayed on radio2.
type mmRelayHour struct {
	Pieces int `json:"pieces"` // relayed at least once
	// relays -> pieces
	Hist map[int]int `json:"hist"`
	// what all the relays of the hour's pieces took on air, in ms
	AirMs float64 `json:"airMs"`
	// repeater (path hash, upper case) -> ms on air relaying pieces
	ByRepeater map[string]float64 `json:"byRepeater"`
	// where pieces entered the mesh (first repeater's hash) -> relays -> pieces
	ByStart map[string]map[int]int `json:"byStart"`
}

func newMMRelayHour() *mmRelayHour {
	return &mmRelayHour{Hist: map[int]int{}, ByRepeater: map[string]float64{}, ByStart: map[string]map[int]int{}}
}

// mediaMeshRelayHours tallies the photo, video and voice pieces heard on
// radio2 since `since` (RFC 3339) by the hour they were first heard
// ("2006-01-02T15:00:00Z").
func (s *PacketStore) mediaMeshRelayHours(since string) map[string]*mmRelayHour {
	preset := mmRadio2Preset()
	out := map[string]*mmRelayHour{}
	s.mu.RLock()
	mediaMeshMu.RLock()
	defer mediaMeshMu.RUnlock()
	defer s.mu.RUnlock()
	bursts := s.mediaMeshBurstsLocked(since)
	for _, tx := range s.packets {
		if tx == nil || tx.FirstSeen < since || !mediaMeshIsMedia(tx, bursts) {
			continue
		}
		hops := map[string]bool{}
		start := ""
		longest := -1
		for _, o := range tx.Observations {
			if _, ok := mediaMeshObs[o.ID]; !ok {
				continue
			}
			p := parsePathJSON(o.PathJSON)
			for _, h := range p {
				hops[strings.ToUpper(h)] = true
			}
			if len(p) > longest {
				longest = len(p)
				if len(p) > 0 {
					start = strings.ToUpper(p[0])
				}
			}
		}
		if len(hops) == 0 {
			continue // heard straight from the sender only: not relayed
		}
		k := parseTimestamp(tx.FirstSeen).UTC().Truncate(time.Hour).Format(time.RFC3339)
		h := out[k]
		if h == nil {
			h = newMMRelayHour()
			out[k] = h
		}
		toa := float64(lora.TimeOnAir(len(tx.RawHex)/2, preset)) / float64(time.Millisecond)
		h.Pieces++
		h.Hist[len(hops)]++
		h.AirMs += toa * float64(len(hops))
		for hop := range hops {
			// a 1-byte hash names no repeater for sure (packetpath.MinHeardHopBytes)
			if len(hop) >= 4 {
				h.ByRepeater[hop] += toa
			}
		}
		if len(start) >= 4 {
			if h.ByStart[start] == nil {
				h.ByStart[start] = map[int]int{}
			}
			h.ByStart[start][len(hops)]++
		}
	}
	return out
}

func ensureMMRelayHours(db *sql.DB) error {
	_, err := db.Exec(`CREATE TABLE IF NOT EXISTS mm_relay_hours (hour TEXT PRIMARY KEY, pieces INTEGER NOT NULL, tally TEXT NOT NULL)`)
	return err
}

// keepMMRelayHours writes each hour's tally where it's fuller than the kept one.
func keepMMRelayHours(db *sql.DB, hours map[string]*mmRelayHour) error {
	if err := ensureMMRelayHours(db); err != nil {
		return err
	}
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for k, h := range hours {
		if h == nil || h.Pieces == 0 {
			continue
		}
		b, err := json.Marshal(h)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(`INSERT INTO mm_relay_hours (hour, pieces, tally) VALUES (?, ?, ?)
			ON CONFLICT(hour) DO UPDATE SET pieces = excluded.pieces, tally = excluded.tally
			WHERE excluded.pieces > mm_relay_hours.pieces`, k, h.Pieces, string(b)); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// keptMMRelayHours: the kept hours since `since` (RFC 3339).
func keptMMRelayHours(db *sql.DB, since string) (map[string]*mmRelayHour, error) {
	if err := ensureMMRelayHours(db); err != nil {
		return nil, err
	}
	rows, err := db.Query(`SELECT hour, tally FROM mm_relay_hours WHERE hour >= ?`, since)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]*mmRelayHour{}
	for rows.Next() {
		var k, t string
		if err := rows.Scan(&k, &t); err != nil {
			return nil, err
		}
		h := newMMRelayHour()
		if json.Unmarshal([]byte(t), h) == nil {
			out[k] = h
		}
	}
	return out, rows.Err()
}

func pruneMMRelayHours(db *sql.DB, days int) {
	if ensureMMRelayHours(db) != nil {
		return
	}
	db.Exec(`DELETE FROM mm_relay_hours WHERE hour < ?`, time.Now().UTC().Add(-time.Duration(days)*24*time.Hour).Format(time.RFC3339))
}

// MediaMeshRelays is /api/analytics/mediamesh/relays.
type MediaMeshRelays struct {
	From   string `json:"from"`
	To     string `json:"to"`
	Pieces int    `json:"pieces"`
	// pieces by how many repeaters relayed them: 1–5, 6–10, …, 26–30, 31+
	Bins          []MediaMeshRelayBin    `json:"bins"`
	MedianRelays  float64                `json:"medianRelays"`
	AirPerPieceS  float64                `json:"airPerPieceS"` // all a piece's relays together, on average
	ByStart       []MediaMeshRelayStart  `json:"byStart"`
	Weeks         []MediaMeshRelayWeek   `json:"weeks"`
	Repeaters     []MediaMeshRelayRepeat `json:"repeaters"`
	BusyLinePct   float64                `json:"busyLinePct"`
	PresetSummary string                 `json:"preset"`
}

type MediaMeshRelayBin struct {
	Label  string `json:"label"`
	Pieces int    `json:"pieces"`
}

type MediaMeshRelayStart struct {
	Hash   string  `json:"hash"`
	Name   string  `json:"name"`
	Median float64 `json:"median"`
	Pieces int     `json:"pieces"`
}

type MediaMeshRelayWeek struct {
	Week   string  `json:"week"` // the Monday, UTC
	Median float64 `json:"median"`
	Pieces int     `json:"pieces"`
}

// MediaMeshRelayRepeat is one repeater's share of the hour spent sending
// clip pieces on radio2: the median over the hours with clip traffic, and
// its busiest hour.
type MediaMeshRelayRepeat struct {
	Hash       string  `json:"hash"`
	Name       string  `json:"name"`
	TypicalPct float64 `json:"typicalPct"`
	BusiestPct float64 `json:"busiestPct"`
	BusiestAt  string  `json:"busiestAt"`
}

// mmRelayBusyPct: past this share of an hour on air there's little time
// left to listen, and pieces start to collide.
const mmRelayBusyPct = 60

func histMedian(h map[int]int) float64 {
	n := 0
	keys := make([]int, 0, len(h))
	for k, v := range h {
		n += v
		keys = append(keys, k)
	}
	if n == 0 {
		return 0
	}
	sort.Ints(keys)
	at := func(i int) int { // the i-th value, from 0
		for _, k := range keys {
			if i < h[k] {
				return k
			}
			i -= h[k]
		}
		return keys[len(keys)-1]
	}
	if n%2 == 1 {
		return float64(at(n / 2))
	}
	return float64(at(n/2-1)+at(n/2)) / 2
}

// summarizeMMRelays turns hourly tallies into the answer. name gives a
// repeater's name from its path hash ("" when unknown).
func summarizeMMRelays(hours map[string]*mmRelayHour, from, to time.Time, name func(string) string) *MediaMeshRelays {
	out := &MediaMeshRelays{From: from.Format(time.RFC3339), To: to.Format(time.RFC3339), Bins: []MediaMeshRelayBin{},
		ByStart: []MediaMeshRelayStart{}, Weeks: []MediaMeshRelayWeek{}, Repeaters: []MediaMeshRelayRepeat{}, BusyLinePct: mmRelayBusyPct,
		PresetSummary: "250 kHz, SF7, CR 4/5"}
	labels := []string{"1–5", "6–10", "11–15", "16–20", "21–25", "26–30", "31+"}
	bins := make([]int, len(labels))
	hist := map[int]int{}
	starts := map[string]map[int]int{}
	weeks := map[string]map[int]int{}
	var air float64
	type rep struct {
		shares map[string]float64
	}
	reps := map[string]*rep{}
	var inWindow []string
	fromK := from.UTC().Truncate(time.Hour).Format(time.RFC3339)
	for k, h := range hours {
		t := parseTimestamp(k)
		wd := (int(t.Weekday()) + 6) % 7
		wk := t.AddDate(0, 0, -wd).Format("2006-01-02")
		if weeks[wk] == nil {
			weeks[wk] = map[int]int{}
		}
		for r, n := range h.Hist {
			weeks[wk][r] += n
		}
		if k < fromK {
			continue
		}
		inWindow = append(inWindow, k)
		out.Pieces += h.Pieces
		air += h.AirMs
		for r, n := range h.Hist {
			hist[r] += n
			bins[min(len(bins)-1, (r-1)/5)] += n
		}
		for st, hh := range h.ByStart {
			if starts[st] == nil {
				starts[st] = map[int]int{}
			}
			for r, n := range hh {
				starts[st][r] += n
			}
		}
		for hop, ms := range h.ByRepeater {
			if reps[hop] == nil {
				reps[hop] = &rep{shares: map[string]float64{}}
			}
			reps[hop].shares[k] = ms / float64(time.Hour/time.Millisecond) * 100
		}
	}
	for i, l := range labels {
		out.Bins = append(out.Bins, MediaMeshRelayBin{Label: l, Pieces: bins[i]})
	}
	out.MedianRelays = histMedian(hist)
	if out.Pieces > 0 {
		out.AirPerPieceS = air / float64(out.Pieces) / 1000
	}
	for st, hh := range starts {
		n := 0
		for _, v := range hh {
			n += v
		}
		if n < 5 {
			continue
		}
		out.ByStart = append(out.ByStart, MediaMeshRelayStart{Hash: st, Name: name(st), Median: histMedian(hh), Pieces: n})
	}
	sort.Slice(out.ByStart, func(i, j int) bool {
		a, b := out.ByStart[i], out.ByStart[j]
		return a.Median > b.Median || (a.Median == b.Median && a.Pieces > b.Pieces)
	})
	if len(out.ByStart) > 5 {
		out.ByStart = out.ByStart[:5]
	}
	for wk, hh := range weeks {
		n := 0
		for _, v := range hh {
			n += v
		}
		out.Weeks = append(out.Weeks, MediaMeshRelayWeek{Week: wk, Median: histMedian(hh), Pieces: n})
	}
	sort.Slice(out.Weeks, func(i, j int) bool { return out.Weeks[i].Week < out.Weeks[j].Week })
	// a repeater's typical hour: the median over every hour with clip
	// traffic, an hour it sent nothing counting as 0
	sort.Strings(inWindow)
	for hop, r := range reps {
		vals := make([]float64, 0, len(inWindow))
		best, bestAt := 0.0, ""
		for _, k := range inWindow {
			v := r.shares[k]
			vals = append(vals, v)
			if v > best {
				best, bestAt = v, k
			}
		}
		sort.Float64s(vals)
		typ := 0.0
		if n := len(vals); n > 0 {
			typ = vals[n/2]
			if n%2 == 0 {
				typ = (vals[n/2-1] + vals[n/2]) / 2
			}
		}
		nm := name(hop)
		if nm == "" {
			nm = hop
		}
		out.Repeaters = append(out.Repeaters, MediaMeshRelayRepeat{Hash: hop, Name: nm, TypicalPct: typ, BusiestPct: best, BusiestAt: bestAt})
	}
	sort.Slice(out.Repeaters, func(i, j int) bool {
		a, b := out.Repeaters[i], out.Repeaters[j]
		return a.BusiestPct > b.BusiestPct || (a.BusiestPct == b.BusiestPct && a.Hash < b.Hash)
	})
	if len(out.Repeaters) > 12 {
		out.Repeaters = out.Repeaters[:12]
	}
	return out
}

func (s *Server) handleMediaMeshRelays(w http.ResponseWriter, r *http.Request) {
	days := 7
	if v, err := strconv.Atoi(r.URL.Query().Get("days")); err == nil && v >= 1 && v <= 31 {
		days = v
	}
	build := func() interface{} {
		now := time.Now().UTC()
		from := now.Add(-time.Duration(days) * 24 * time.Hour)
		hours := map[string]*mmRelayHour{}
		// the week-by-week line goes back as far as hours are kept
		keptFrom := now.Add(-mmClipKeepDays * 24 * time.Hour).Format(time.RFC3339)
		if st, _ := s.coveragePoints(); st != nil {
			if kept, err := keptMMRelayHours(st.db, keptFrom); err == nil {
				hours = kept
			} else {
				log.Printf("[mediamesh] reading kept relay hours: %v", err)
			}
		}
		name := func(string) string { return "" }
		if s.store != nil {
			for k, h := range s.store.mediaMeshRelayHours(keptFrom) {
				if o, ok := hours[k]; !ok || h.Pieces >= o.Pieces {
					hours[k] = h
				}
			}
			named := s.store.mediaMeshHopNamer(now)
			name = func(h string) string {
				if n, _, ok := named(h); ok {
					return n.Name
				}
				return ""
			}
		}
		return summarizeMMRelays(hours, from, now, name)
	}
	if s.store == nil {
		writeJSON(w, build())
		return
	}
	writeJSON(w, s.store.cachedMediaMesh("mediamesh-relays|"+strconv.Itoa(days), build))
}
