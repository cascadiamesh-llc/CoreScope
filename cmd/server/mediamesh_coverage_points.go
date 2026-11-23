package main

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/meshcore-analyzer/sigvalidate"
)

// MediaMesh coverage points: where people walking or driving with
// MeshCore Open TAK or a Wadamesh TAK standalone found the MediaMesh
// repeaters (their "Map MediaMesh coverage" recorder), sent here when they
// switch on sharing. The coverage card checks its estimate against them.
//
// A batch is signed with the radio's own key, over
// "corescope-coverage:" + the hex SHA-256 of the body, and only radios this
// analyzer has heard are taken, so a stranger can't fill the map with made-up
// points. The points are kept in their own SQLite file next to the analyzer's
// database (the analyzer's own is read-only to the server). Nothing here is
// shown point by point or by radio: the public answer is 200 m cells, with
// the first and last 300 m of every trip left out, so nobody's home or
// workplace shows.

const (
	covPointsMaxBody     = 512 << 10
	covPointsMaxPerBatch = 500
	covPointsCellM       = 200.0
	covPointsHexM        = 500.0 // the "Mapped by people" hexagons, flat side to flat side: big enough that one says little about where anyone was
	covPointsTripGap     = 30 * time.Minute
	covPointsTrimM       = 300.0
	covPointsCarMS       = 6.0 // faster than this (m/s, about 22 km/h): in a vehicle
	covPointsSignPrefix  = "corescope-coverage:"
	covPointsDeletePref  = "corescope-coverage-delete:"
	covPointsDefaultDays = 365
	covPointsCacheTTL    = time.Minute
)

// MediaMeshCoverageConfig is config.json's "mediameshCoverage". On unless
// enabled is false.
type MediaMeshCoverageConfig struct {
	Enabled           *bool  `json:"enabled,omitempty"`
	DBPath            string `json:"dbPath,omitempty"`
	RetentionDays     int    `json:"retentionDays,omitempty"`
	RequireKnownRadio *bool  `json:"requireKnownRadio,omitempty"`
	// Peers: other analyzers running MediaMesh, for the Cascadia-wide view
	// (mediamesh_peers.go).
	Peers []MediaMeshPeer `json:"peers,omitempty"`
}

func (c *Config) mediaMeshCoverage() MediaMeshCoverageConfig {
	if c == nil || c.MediaMeshCoverage == nil {
		return MediaMeshCoverageConfig{}
	}
	return *c.MediaMeshCoverage
}

// covPointRep is one MediaMesh repeater that answered at a point.
type covPointRep struct {
	Key       string  `json:"key"`        // first 8 hex digits of its key
	SNR       float64 `json:"snr"`        // ours of its reply, dB
	RemoteSNR float64 `json:"remote_snr"` // its of our ask, dB
	Margin    float64 `json:"margin"`     // radio2's estimated margin over what it decodes, dB
	// RSSI of its reply as the recording radio heard it, dBm (a discovery
	// answer; apps from before don't send it). SNR readings top out around
	// +12 dB; RSSI keeps rising, so near a repeater it tells strong from fair.
	RSSI *float64 `json:"rssi,omitempty"`
	// Via: "trace" when it answered being asked by name, not the discovery.
	Via string `json:"via,omitempty"`
}

type covPoint struct {
	T     int64         `json:"t"` // unix seconds
	Lat   float64       `json:"lat"`
	Lon   float64       `json:"lon"`
	Acc   float64       `json:"acc,omitempty"`   // GPS accuracy, m
	Speed float64       `json:"speed,omitempty"` // m/s
	Reps  []covPointRep `json:"reps"`
	// Silent: MediaMesh repeaters asked by name (a one-hop trace) that
	// didn't answer, first 8 hex digits each.
	Silent []string `json:"silent,omitempty"`
}

type covRadio2 struct {
	BwHz int `json:"bw_hz"`
	SF   int `json:"sf"`
}

// covPointsBatch is the upload's body.
type covPointsBatch struct {
	V        int        `json:"v"`
	Radio    string     `json:"radio"` // the radio's full public key, 64 hex
	Sent     int64      `json:"sent"`
	App      string     `json:"app,omitempty"`
	Radio2   covRadio2  `json:"radio2"`
	MainBwHz int        `json:"main_bw_hz"`
	Points   []covPoint `json:"points"`
}

// covPointsStore holds the points.
type covPointsStore struct {
	db  *sql.DB
	now func() time.Time

	mu       sync.Mutex
	cached   *covCellsResponse
	cachedAt time.Time
}

func openCovPointsStore(path string) (*covPointsStore, error) {
	// Its own file, never the analyzer's database (which the server only
	// reads, readonly_invariant_test.go); the default rollback journal is
	// plenty for a few uploads an hour.
	db, err := sql.Open("sqlite3", "file:"+path+"?_busy_timeout=5000")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS points (
		radio TEXT NOT NULL, t INTEGER NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL,
		acc REAL, speed REAL, reps TEXT NOT NULL, r2_bw INTEGER, r2_sf INTEGER, main_bw INTEGER,
		app TEXT, received INTEGER NOT NULL, PRIMARY KEY (radio, t))`); err != nil {
		db.Close()
		return nil, err
	}
	// added later: repeaters asked by name that didn't answer (JSON list)
	db.Exec(`ALTER TABLE points ADD COLUMN silent TEXT`)
	// delivery receipts (mediamesh_receipts.go)
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS receipts (
		radio TEXT NOT NULL, sid TEXT NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL,
		total INTEGER NOT NULL, got INTEGER NOT NULL, asked INTEGER NOT NULL, rebuilt INTEGER NOT NULL,
		whole INTEGER NOT NULL, app TEXT, received INTEGER NOT NULL, PRIMARY KEY (radio, sid, at))`); err != nil {
		db.Close()
		return nil, err
	}
	return &covPointsStore{db: db, now: time.Now}, nil
}

func (st *covPointsStore) close() {
	if st != nil && st.db != nil {
		st.db.Close()
	}
}

// add stores a checked batch: how many points were new.
func (st *covPointsStore) add(b *covPointsBatch) (int, error) {
	tx, err := st.db.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	stmt, err := tx.Prepare(`INSERT OR IGNORE INTO points (radio, t, lat, lon, acc, speed, reps, r2_bw, r2_sf, main_bw, app, received, silent)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
	if err != nil {
		return 0, err
	}
	defer stmt.Close()
	n := 0
	now := st.now().Unix()
	for _, p := range b.Points {
		reps, _ := json.Marshal(p.Reps)
		var silent interface{}
		if len(p.Silent) > 0 {
			sb, _ := json.Marshal(p.Silent)
			silent = string(sb)
		}
		res, err := stmt.Exec(b.Radio, p.T, p.Lat, p.Lon, p.Acc, p.Speed, string(reps), b.Radio2.BwHz, b.Radio2.SF, b.MainBwHz, b.App, now, silent)
		if err != nil {
			return 0, err
		}
		if k, _ := res.RowsAffected(); k > 0 {
			n++
		}
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	st.invalidate()
	return n, nil
}

func (st *covPointsStore) removeRadio(radio string) (int64, error) {
	res, err := st.db.Exec(`DELETE FROM points WHERE radio = ?`, radio)
	if err != nil {
		return 0, err
	}
	st.invalidate()
	return res.RowsAffected()
}

func (st *covPointsStore) prune(days int) {
	if days <= 0 {
		return
	}
	cut := st.now().Add(-time.Duration(days) * 24 * time.Hour).Unix()
	if res, err := st.db.Exec(`DELETE FROM points WHERE t < ?`, cut); err == nil {
		if k, _ := res.RowsAffected(); k > 0 {
			st.invalidate()
		}
	}
	st.db.Exec(`DELETE FROM receipts WHERE at < ?`, cut)
}

func (st *covPointsStore) invalidate() {
	st.mu.Lock()
	st.cached = nil
	st.mu.Unlock()
}

// storedPoint is a point as read back, with its radio and the radio2
// setting its batch said (0: not said).
type storedPoint struct {
	radio      string
	r2bw, r2sf int
	covPoint
}

func (st *covPointsStore) all() ([]storedPoint, error) {
	rows, err := st.db.Query(`SELECT radio, t, lat, lon, COALESCE(speed, 0), reps, COALESCE(r2_bw, 0), COALESCE(r2_sf, 0), COALESCE(silent, '') FROM points ORDER BY radio, t`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []storedPoint
	for rows.Next() {
		var p storedPoint
		var reps, silent string
		if err := rows.Scan(&p.radio, &p.T, &p.Lat, &p.Lon, &p.Speed, &reps, &p.r2bw, &p.r2sf, &silent); err != nil {
			return nil, err
		}
		_ = json.Unmarshal([]byte(reps), &p.Reps)
		if silent != "" {
			_ = json.Unmarshal([]byte(silent), &p.Silent)
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// covRSSIMargin: radio2's margin over what it decodes, from the RSSI of a
// reply on the main mesh: the RSSI less radio2's sensitivity (thermal noise
// in its bandwidth, a 6.5 dB noise figure, the SNR its spreading factor
// needs; as public/mediamesh-coverage.js sensitivityDbm). 250 kHz SF7 when
// the batch didn't say.
func covRSSIMargin(rssi float64, bwHz, sf int) float64 {
	if bwHz <= 0 {
		bwHz = 250000
	}
	floors := map[int]float64{5: -2.5, 6: -5, 7: -7.5, 8: -10, 9: -12.5, 10: -15, 11: -17.5, 12: -20}
	floor, ok := floors[sf]
	if !ok {
		floor = -7.5
	}
	sens := -174 + 10*math.Log10(float64(bwHz)) + 6.5 + floor
	return rssi - sens
}

// cells: the public answer, worked out at most once a minute.
func (st *covPointsStore) cells() (*covCellsResponse, error) {
	st.mu.Lock()
	if st.cached != nil && st.now().Sub(st.cachedAt) < covPointsCacheTTL {
		c := st.cached
		st.mu.Unlock()
		return c, nil
	}
	st.mu.Unlock()
	pts, err := st.all()
	if err != nil {
		return nil, err
	}
	c := covCells(pts)
	st.mu.Lock()
	st.cached, st.cachedAt = c, st.now()
	st.mu.Unlock()
	return c, nil
}

// ---- Checking a batch ---------------------------------------------------------

var errCovBatch = errors.New("bad batch")

// checkCovBatch checks and tidies a batch in place: the radio's key, sane
// times and places, at most covPointsMaxPerBatch points, repeater keys as 8
// lower-case hex digits. now: the server's clock.
func checkCovBatch(b *covPointsBatch, now time.Time, keepDays int) error {
	k := strings.ToLower(strings.TrimSpace(b.Radio))
	if len(k) != 64 {
		return fmt.Errorf("%w: radio must be the radio's 64-hex-digit public key", errCovBatch)
	}
	if _, err := hex.DecodeString(k); err != nil {
		return fmt.Errorf("%w: radio must be hex", errCovBatch)
	}
	b.Radio = k
	if len(b.Points) == 0 {
		return fmt.Errorf("%w: no points", errCovBatch)
	}
	if len(b.Points) > covPointsMaxPerBatch {
		return fmt.Errorf("%w: at most %d points a batch", errCovBatch, covPointsMaxPerBatch)
	}
	if b.Radio2.BwHz < 7800 || b.Radio2.BwHz > 1625000 || b.Radio2.SF < 5 || b.Radio2.SF > 12 {
		return fmt.Errorf("%w: radio2 needs bw_hz and sf", errCovBatch)
	}
	if b.App = strings.TrimSpace(b.App); len(b.App) > 64 {
		b.App = b.App[:64]
	}
	if keepDays <= 0 {
		keepDays = covPointsDefaultDays
	}
	oldest := now.Add(-time.Duration(keepDays) * 24 * time.Hour).Unix()
	newest := now.Add(24 * time.Hour).Unix()
	kept := b.Points[:0]
	for _, p := range b.Points {
		if p.T < oldest || p.T > newest || !(p.Lat >= -90 && p.Lat <= 90) || !(p.Lon >= -180 && p.Lon <= 180) || (p.Lat == 0 && p.Lon == 0) {
			continue
		}
		if p.Acc < 0 || p.Acc > 1e4 || math.IsNaN(p.Acc) {
			p.Acc = 0
		}
		if p.Speed < 0 || p.Speed > 100 || math.IsNaN(p.Speed) {
			p.Speed = 0
		}
		reps := make([]covPointRep, 0, len(p.Reps))
		answered := map[string]bool{}
		for _, r := range p.Reps {
			key := strings.ToLower(strings.TrimSpace(r.Key))
			if len(key) > 8 {
				key = key[:8]
			}
			if len(key) != 8 || !isHex(key) || !finiteDb(r.SNR) || !finiteDb(r.RemoteSNR) || !finiteDb(r.Margin) {
				continue
			}
			r.Key = key
			if r.RSSI != nil && !(*r.RSSI >= -150 && *r.RSSI < 0) {
				r.RSSI = nil
			}
			if r.Via != "trace" {
				r.Via = ""
			}
			answered[key] = true
			reps = append(reps, r)
			if len(reps) == 12 {
				break
			}
		}
		p.Reps = reps
		silent := make([]string, 0, len(p.Silent))
		for _, k := range p.Silent {
			k = strings.ToLower(strings.TrimSpace(k))
			if len(k) > 8 {
				k = k[:8]
			}
			if len(k) != 8 || !isHex(k) || answered[k] {
				continue
			}
			answered[k] = true
			silent = append(silent, k)
			if len(silent) == 12 {
				break
			}
		}
		p.Silent = silent
		kept = append(kept, p)
	}
	if len(kept) == 0 {
		return fmt.Errorf("%w: no usable points (times within the last %d days, real positions)", errCovBatch, keepDays)
	}
	b.Points = kept
	return nil
}

func isHex(s string) bool {
	_, err := hex.DecodeString(s)
	return err == nil
}

func finiteDb(v float64) bool { return !math.IsNaN(v) && v > -100 && v < 100 }

// covSignedMessage is what the radio signs for a body.
func covSignedMessage(prefix string, body []byte) []byte {
	sum := sha256.Sum256(body)
	return []byte(prefix + hex.EncodeToString(sum[:]))
}

func verifyCovSignature(radioHex, sigHex string, msg []byte) bool {
	pub, err := hex.DecodeString(radioHex)
	if err != nil {
		return false
	}
	sig, err := hex.DecodeString(strings.TrimSpace(sigHex))
	if err != nil || len(sig) != 64 {
		return false
	}
	ok, err := sigvalidate.VerifyMessage(pub, sig, msg)
	return err == nil && ok
}

// ---- The public cells -----------------------------------------------------------

// covCellRep: one repeater as measured in one cell.
type covCellRep struct {
	Key    string  `json:"key"`
	N      int     `json:"n"`      // samples it answered in
	Margin float64 `json:"margin"` // median estimated radio2 margin, dB
	// RSSIMargin: the median margin from its replies' RSSI (covRSSIMargin),
	// where the apps sent RSSI.
	RSSIMargin *float64 `json:"rssi_margin,omitempty"`
}

// covCellSilent: a repeater asked by name in a cell that didn't answer.
type covCellSilent struct {
	Key string `json:"key"`
	N   int    `json:"n"` // samples it was asked in and stayed silent
}

type covCell struct {
	Lat  float64      `json:"lat"`
	Lon  float64      `json:"lon"`
	Car  bool         `json:"car"` // measured from a vehicle
	N    int          `json:"n"`   // samples
	None int          `json:"none"`
	Reps []covCellRep `json:"reps"`
	// Silent: repeaters asked by name there that didn't answer.
	Silent []covCellSilent `json:"silent,omitempty"`
}

// covHex: one "Mapped by people" hexagon, where at least one MediaMesh
// repeater answered. Lat/Lon is its middle; R its corner radius in Web
// Mercator metres (EPSG:3857, as Leaflet draws), so the map can draw it
// exactly: a flat-topped hexagon, corners at R from the middle every 60°.
type covHex struct {
	Lat  float64      `json:"lat"`
	Lon  float64      `json:"lon"`
	R    float64      `json:"r"`
	N    int          `json:"n"`    // pings in it
	Car  bool         `json:"car"`  // all of them from a vehicle
	Best float64      `json:"best"` // the best repeater's median margin, dB
	Reps []covCellRep `json:"reps"`
}

type covCellsResponse struct {
	CellM   float64   `json:"cell_m"`
	Points  int       `json:"points"`
	Radios  int       `json:"radios"`
	Trips   int       `json:"trips"`
	Trimmed int       `json:"trimmed"` // left out at the ends of trips
	Updated string    `json:"updated,omitempty"`
	Cells   []covCell `json:"cells"`
	// Mapped by people: the hexagons where a repeater answered, and the area
	// of those where radio2 would reach (best margin 0 dB or more).
	HexM          float64  `json:"hex_m"`
	Hexes         []covHex `json:"hexes"`
	HexesAnswered int      `json:"hexes_answered"`
	MappedKm2     float64  `json:"mapped_km2"`
}

// covCells groups points into covPointsCellM cells, after leaving out the
// first and last covPointsTrimM of each trip (a radio's points with no gap
// over covPointsTripGap). pts must be sorted by radio, then time.
func covCells(pts []storedPoint) *covCellsResponse {
	out := &covCellsResponse{CellM: covPointsCellM, Cells: []covCell{}, HexM: covPointsHexM, Hexes: []covHex{}}
	type acc struct {
		lat, lon float64
		car      bool
		n, none  int
		margins  map[string][]float64
		rssi     map[string][]float64
		silent   map[string]int
	}
	cells := map[string]*acc{}
	type hacc struct {
		lat, lon, r float64
		n           int
		car         bool
		margins     map[string][]float64
	}
	hexes := map[string]*hacc{}
	radios := map[string]bool{}
	var newest int64
	keep, trips := trimTrips(pts)
	out.Trips = trips
	for i, p := range pts {
		if !keep[i] {
			out.Trimmed++
			continue
		}
		out.Points++
		radios[p.radio] = true
		if p.T > newest {
			newest = p.T
		}
		lat, lon := snapCell(p.Lat, p.Lon)
		car := p.Speed > covPointsCarMS
		key := fmt.Sprintf("%.5f,%.5f,%t", lat, lon, car)
		c := cells[key]
		if c == nil {
			c = &acc{lat: lat, lon: lon, car: car, margins: map[string][]float64{}, rssi: map[string][]float64{}, silent: map[string]int{}}
			cells[key] = c
		}
		c.n++
		if len(p.Reps) == 0 {
			c.none++
		}
		seen := map[string]bool{}
		for _, r := range p.Reps {
			if seen[r.Key] {
				continue
			}
			seen[r.Key] = true
			c.margins[r.Key] = append(c.margins[r.Key], r.Margin)
			if r.RSSI != nil {
				c.rssi[r.Key] = append(c.rssi[r.Key], covRSSIMargin(*r.RSSI, p.r2bw, p.r2sf))
			}
		}
		for _, k := range p.Silent {
			if !seen[k] {
				seen[k] = true
				c.silent[k]++
			}
		}
		if len(p.Reps) > 0 {
			hk, hLat, hLon, hR := hexOf(p.Lat, p.Lon)
			h := hexes[hk]
			if h == nil {
				h = &hacc{lat: hLat, lon: hLon, r: hR, car: true, margins: map[string][]float64{}}
				hexes[hk] = h
			}
			h.n++
			h.car = h.car && car
			hs := map[string]bool{}
			for _, r := range p.Reps {
				if !hs[r.Key] {
					hs[r.Key] = true
					h.margins[r.Key] = append(h.margins[r.Key], r.Margin)
				}
			}
		}
	}
	for _, h := range hexes {
		hx := covHex{Lat: h.lat, Lon: h.lon, R: math.Round(h.r*10) / 10, N: h.n, Car: h.car, Best: math.Inf(-1), Reps: []covCellRep{}}
		for k, ms := range h.margins {
			m := math.Round(medianF(ms)*10) / 10
			hx.Reps = append(hx.Reps, covCellRep{Key: k, N: len(ms), Margin: m})
			if m > hx.Best {
				hx.Best = m
			}
		}
		sort.Slice(hx.Reps, func(i, j int) bool {
			if hx.Reps[i].Margin != hx.Reps[j].Margin {
				return hx.Reps[i].Margin > hx.Reps[j].Margin
			}
			return hx.Reps[i].Key < hx.Reps[j].Key
		})
		if hx.Best >= 0 {
			out.HexesAnswered++
		}
		out.Hexes = append(out.Hexes, hx)
	}
	out.MappedKm2 = math.Round(float64(out.HexesAnswered)*hexAreaM2()/1e6*100) / 100
	sort.Slice(out.Hexes, func(i, j int) bool {
		a, b := out.Hexes[i], out.Hexes[j]
		if a.Lat != b.Lat {
			return a.Lat > b.Lat
		}
		return a.Lon < b.Lon
	})
	out.Radios = len(radios)
	if newest > 0 {
		out.Updated = time.Unix(newest, 0).UTC().Format(time.RFC3339)
	}
	for _, c := range cells {
		cc := covCell{Lat: c.lat, Lon: c.lon, Car: c.car, N: c.n, None: c.none, Reps: []covCellRep{}}
		for k, ms := range c.margins {
			cr := covCellRep{Key: k, N: len(ms), Margin: math.Round(medianF(ms)*10) / 10}
			if rs := c.rssi[k]; len(rs) > 0 {
				v := math.Round(medianF(rs)*10) / 10
				cr.RSSIMargin = &v
			}
			cc.Reps = append(cc.Reps, cr)
		}
		sort.Slice(cc.Reps, func(i, j int) bool { return cc.Reps[i].Margin > cc.Reps[j].Margin })
		for k, n := range c.silent {
			cc.Silent = append(cc.Silent, covCellSilent{Key: k, N: n})
		}
		sort.Slice(cc.Silent, func(i, j int) bool { return cc.Silent[i].Key < cc.Silent[j].Key })
		out.Cells = append(out.Cells, cc)
	}
	sort.Slice(out.Cells, func(i, j int) bool {
		a, b := out.Cells[i], out.Cells[j]
		if a.Lat != b.Lat {
			return a.Lat > b.Lat
		}
		if a.Lon != b.Lon {
			return a.Lon < b.Lon
		}
		return !a.Car && b.Car
	})
	return out
}

// trimTrips marks the points kept: all but those within covPointsTrimM of
// where each trip started or ended. Also says how many trips there were.
func trimTrips(pts []storedPoint) ([]bool, int) {
	keep := make([]bool, len(pts))
	trips := 0
	for s := 0; s < len(pts); {
		trips++
		e := s + 1
		for e < len(pts) && pts[e].radio == pts[s].radio && time.Duration(pts[e].T-pts[e-1].T)*time.Second <= covPointsTripGap {
			e++
		}
		first, last := pts[s], pts[e-1]
		for i := s; i < e; i++ {
			p := pts[i]
			keep[i] = haversineKm(p.Lat, p.Lon, first.Lat, first.Lon)*1000 > covPointsTrimM &&
				haversineKm(p.Lat, p.Lon, last.Lat, last.Lon)*1000 > covPointsTrimM
		}
		s = e
	}
	return keep, trips
}

// The hexagons: flat-topped, covPointsHexM across, on a grid in Web Mercator
// metres (as Leaflet draws, so they tile on the map). Mercator stretches by
// 1/cos(latitude), so each 1° band of latitude has its own size, set for the
// band's middle: within a band they tile exactly, and are within half a
// percent of covPointsHexM across.
const webMercR = 6378137.0

func hexAreaM2() float64 { return math.Sqrt(3) / 2 * covPointsHexM * covPointsHexM }

// hexOf is the hexagon a point falls in: its key, middle and corner radius
// (Mercator metres).
func hexOf(lat, lon float64) (string, float64, float64, float64) {
	band := math.Floor(lat)
	r := covPointsHexM / math.Sqrt(3) / math.Cos((band+0.5)*math.Pi/180)
	x := webMercR * lon * math.Pi / 180
	y := webMercR * math.Log(math.Tan(math.Pi/4+lat*math.Pi/360))
	// axial coordinates of a flat-topped grid, rounded through cube ones
	q := (2.0 / 3 * x) / r
	rr := (-1.0/3*x + math.Sqrt(3)/3*y) / r
	cx, cz := math.Round(q), math.Round(rr)
	cy := math.Round(-q - rr)
	dx, dz, dy := math.Abs(cx-q), math.Abs(cz-rr), math.Abs(cy+q+rr)
	if dx > dy && dx > dz {
		cx = -cy - cz
	} else if dy <= dz {
		cz = -cx - cy
	}
	mx := r * 1.5 * cx
	my := r * math.Sqrt(3) * (cz + cx/2)
	cLon := mx / webMercR * 180 / math.Pi
	cLat := (2*math.Atan(math.Exp(my/webMercR)) - math.Pi/2) * 180 / math.Pi
	return fmt.Sprintf("%d:%d:%d", int(band), int(cx), int(cz)), math.Round(cLat*1e6) / 1e6, math.Round(cLon*1e6) / 1e6, r
}

// snapCell is the middle of the covPointsCellM cell a point falls in.
func snapCell(lat, lon float64) (float64, float64) {
	dLat := covPointsCellM / 111320.0
	row := math.Floor(lat / dLat)
	cLat := (row + 0.5) * dLat
	dLon := covPointsCellM / (111320.0 * math.Cos(cLat*math.Pi/180))
	col := math.Floor(lon / dLon)
	return math.Round(cLat*1e5) / 1e5, math.Round((col+0.5)*dLon*1e5) / 1e5
}

func medianF(xs []float64) float64 {
	v := append([]float64(nil), xs...)
	sort.Float64s(v)
	n := len(v)
	if n == 0 {
		return 0
	}
	if n%2 == 1 {
		return v[n/2]
	}
	return (v[n/2-1] + v[n/2]) / 2
}

// ---- Handlers --------------------------------------------------------------------

type covPointsService struct {
	once    sync.Once
	st      *covPointsStore
	err     error
	limiter *rateLimiter
	stop    chan struct{}
}

// coveragePoints opens the store on first use; nil (and the reason) when
// switched off or the file can't be opened.
func (s *Server) coveragePoints() (*covPointsStore, error) {
	c := s.cfg.mediaMeshCoverage()
	if c.Enabled != nil && !*c.Enabled {
		return nil, errors.New("coverage points are switched off on this analyzer")
	}
	s.covPoints.once.Do(func() {
		path := strings.TrimSpace(c.DBPath)
		if path == "" {
			if s.db == nil || s.db.path == "" {
				s.covPoints.err = errors.New("no place to keep coverage points")
				return
			}
			path = filepath.Join(filepath.Dir(s.db.path), "mediamesh-coverage.db")
		}
		st, err := openCovPointsStore(path)
		if err != nil {
			log.Printf("[mediamesh] coverage points: can't open %s: %v", path, err)
			s.covPoints.err = errors.New("coverage points can't be stored on this analyzer")
			return
		}
		log.Printf("[mediamesh] coverage points kept in %s", path)
		s.covPoints.st = st
		s.covPoints.limiter = newRateLimiter(30, time.Hour)
		s.covPoints.stop = make(chan struct{})
		days := c.RetentionDays
		if days <= 0 {
			days = covPointsDefaultDays
		}
		st.prune(days)
		go func() {
			t := time.NewTicker(6 * time.Hour)
			defer t.Stop()
			for {
				select {
				case <-t.C:
					st.prune(days)
					s.recordLinkHistory(st, true)
					s.recordMMDayNow(st, true)
				case <-s.covPoints.stop:
					return
				}
			}
		}()
	})
	return s.covPoints.st, s.covPoints.err
}

func (s *Server) closeCoveragePoints() {
	if s.covPoints.st != nil {
		close(s.covPoints.stop)
		s.covPoints.st.close()
	}
}

// radioKnown: the analyzer has heard this radio (its full key).
func (s *Server) radioKnown(pk string) bool {
	if s.store == nil {
		return false
	}
	nodes, _ := s.store.getCachedNodesAndPM()
	for i := range nodes {
		if strings.EqualFold(nodes[i].PublicKey, pk) {
			return true
		}
	}
	return false
}

// handleCoveragePointsPost: POST /api/mediamesh/coverage-points.
func (s *Server) handleCoveragePointsPost(w http.ResponseWriter, r *http.Request) {
	st, err := s.coveragePoints()
	if st == nil {
		writeError(w, http.StatusServiceUnavailable, err.Error())
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, covPointsMaxBody))
	if err != nil {
		writeError(w, http.StatusRequestEntityTooLarge, "request body too large")
		return
	}
	var b covPointsBatch
	if err := json.Unmarshal(body, &b); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	c := s.cfg.mediaMeshCoverage()
	if err := checkCovBatch(&b, time.Now(), c.RetentionDays); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if !verifyCovSignature(b.Radio, r.Header.Get("X-MeshCore-Signature"), covSignedMessage(covPointsSignPrefix, body)) {
		writeError(w, http.StatusUnauthorized, "the signature doesn't match this radio's key")
		return
	}
	if (c.RequireKnownRadio == nil || *c.RequireKnownRadio) && !s.radioKnown(b.Radio) {
		writeError(w, http.StatusForbidden, "this analyzer hasn't heard this radio yet: send an advert, then try again")
		return
	}
	if ok, wait := s.covPoints.limiter.take(b.Radio); !ok {
		w.Header().Set("Retry-After", fmt.Sprint(int(wait.Seconds())+1))
		writeError(w, http.StatusTooManyRequests, "too many uploads from this radio, try again later")
		return
	}
	n, err := st.add(&b)
	if err != nil {
		log.Printf("[mediamesh] coverage points from %s: %v", b.Radio[:8], err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	writeJSON(w, map[string]int{"accepted": n, "duplicates": len(b.Points) - n})
}

// covDeleteRequest: a radio asking for all its points to go.
type covDeleteRequest struct {
	Radio string `json:"radio"`
	Sent  int64  `json:"sent"`
}

// handleCoveragePointsDelete: DELETE /api/mediamesh/coverage-points, signed
// like an upload (prefix covPointsDeletePref), sent within 10 minutes.
func (s *Server) handleCoveragePointsDelete(w http.ResponseWriter, r *http.Request) {
	st, err := s.coveragePoints()
	if st == nil {
		writeError(w, http.StatusServiceUnavailable, err.Error())
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 4<<10))
	if err != nil {
		writeError(w, http.StatusRequestEntityTooLarge, "request body too large")
		return
	}
	var q covDeleteRequest
	if json.Unmarshal(body, &q) != nil || len(q.Radio) != 64 || !isHex(q.Radio) {
		writeError(w, http.StatusBadRequest, "radio must be the radio's 64-hex-digit public key")
		return
	}
	if d := time.Since(time.Unix(q.Sent, 0)); d > 10*time.Minute || d < -10*time.Minute {
		writeError(w, http.StatusBadRequest, "sent must be the time now (check the clock)")
		return
	}
	radio := strings.ToLower(q.Radio)
	if !verifyCovSignature(radio, r.Header.Get("X-MeshCore-Signature"), covSignedMessage(covPointsDeletePref, body)) {
		writeError(w, http.StatusUnauthorized, "the signature doesn't match this radio's key")
		return
	}
	n, err := st.removeRadio(radio)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	writeJSON(w, map[string]int64{"removed": n})
}

// handleCoveragePointsGet: GET /api/mediamesh/coverage-points.
func (s *Server) handleCoveragePointsGet(w http.ResponseWriter, r *http.Request) {
	st, _ := s.coveragePoints()
	if st == nil {
		writeJSON(w, &covCellsResponse{CellM: covPointsCellM, Cells: []covCell{}})
		return
	}
	c, err := st.cells()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	writeJSON(w, c)
}
