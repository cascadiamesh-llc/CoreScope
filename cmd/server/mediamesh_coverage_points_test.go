package main

import (
	"bytes"
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"
)

func covTestBatch(radio string, t0 int64) covPointsBatch {
	b := covPointsBatch{V: 1, Radio: radio, Sent: t0, App: "test", Radio2: covRadio2{BwHz: 250000, SF: 7}, MainBwHz: 62500}
	// a walk east along a street, 100 m a sample, one repeater answering
	for i := 0; i < 20; i++ {
		p := covPoint{T: t0 + int64(i)*60, Lat: 47.6100, Lon: -122.3400 + float64(i)*0.00133, Speed: 1.4}
		if i%4 != 3 {
			p.Reps = []covPointRep{{Key: "1ea5e195", SNR: 4, RemoteSNR: 2.5, Margin: 4 - float64(i)/4}}
		}
		b.Points = append(b.Points, p)
	}
	return b
}

func TestCheckCovBatch(t *testing.T) {
	now := time.Unix(1795000000, 0)
	key := hex.EncodeToString(make([]byte, 32))
	b := covTestBatch(key, now.Unix()-3600)
	b.Points[0].Reps[0].Key = "1EA5E195"
	b.Points = append(b.Points,
		covPoint{T: now.Unix() + 3*86400, Lat: 47.6, Lon: -122.3},   // in the future
		covPoint{T: now.Unix() - 400*86400, Lat: 47.6, Lon: -122.3}, // too old
		covPoint{T: now.Unix() - 60, Lat: 0, Lon: 0},                // no fix
		covPoint{T: now.Unix() - 30, Lat: 47.6, Lon: -122.3, Speed: 900, Reps: []covPointRep{{Key: "zz", Margin: 1}, {Key: "abcdef0123", Margin: 300}, {Key: "abcdef0123", Margin: 3}}},
	)
	if err := checkCovBatch(&b, now, 0); err != nil {
		t.Fatal(err)
	}
	if len(b.Points) != 21 {
		t.Fatalf("kept %d points, want 21", len(b.Points))
	}
	last := b.Points[20]
	if last.Speed != 0 || len(last.Reps) != 1 || last.Reps[0].Key != "abcdef01" {
		t.Fatalf("not tidied: %+v", last)
	}
	if b.Points[0].Reps[0].Key != "1ea5e195" {
		t.Fatal("repeater key not lower-cased")
	}
	for _, bad := range []covPointsBatch{
		{Radio: "abc", Radio2: covRadio2{BwHz: 250000, SF: 7}, Points: b.Points},
		{Radio: key, Radio2: covRadio2{BwHz: 250000, SF: 7}},
		{Radio: key, Radio2: covRadio2{}, Points: b.Points},
		{Radio: key, Radio2: covRadio2{BwHz: 250000, SF: 7}, Points: make([]covPoint, covPointsMaxPerBatch+1)},
	} {
		bb := bad
		if err := checkCovBatch(&bb, now, 0); err == nil {
			t.Fatalf("accepted a bad batch: radio %q, %d points", bad.Radio, len(bad.Points))
		}
	}
}

func TestCovCellsTrimsTripEnds(t *testing.T) {
	var pts []storedPoint
	b := covTestBatch("aa", 1795000000)
	for _, p := range b.Points {
		pts = append(pts, storedPoint{radio: "aa", covPoint: p})
	}
	// the same radio again two hours later, standing still (one trip, all trimmed)
	for i := 0; i < 5; i++ {
		pts = append(pts, storedPoint{radio: "aa", covPoint: covPoint{T: 1795000000 + 7200 + int64(i)*60, Lat: 47.62, Lon: -122.31, Reps: nil}})
	}
	c := covCells(pts)
	// a 20-sample walk 100 m apart: the first and last four are within 300 m
	// of an end; the five standing still are all within 300 m of theirs
	if c.Points != 12 || c.Trimmed != 13 || c.Radios != 1 {
		t.Fatalf("points %d trimmed %d radios %d", c.Points, c.Trimmed, c.Radios)
	}
	n, none, reps := 0, 0, 0
	for _, cell := range c.Cells {
		n += cell.N
		none += cell.None
		if cell.Car {
			t.Fatal("a walk counted as in a vehicle")
		}
		for _, r := range cell.Reps {
			if r.Key != "1ea5e195" {
				t.Fatalf("repeater %q", r.Key)
			}
			reps += r.N
		}
	}
	if n != 12 || none+reps != 12 || none == 0 {
		t.Fatalf("n %d none %d answered %d", n, none, reps)
	}
	lat, lon := snapCell(47.6100, -122.3400)
	if haversineKm(lat, lon, 47.61, -122.34)*1000 > covPointsCellM {
		t.Fatal("cell middle too far from the point")
	}
}

func TestCoveragePointsUploadAndRemove(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(nil)
	radio := hex.EncodeToString(pub)
	f := false
	srv := &Server{cfg: &Config{MediaMeshCoverage: &MediaMeshCoverageConfig{DBPath: filepath.Join(t.TempDir(), "cov.db"), RequireKnownRadio: &f}}}
	defer srv.closeCoveragePoints()
	send := func(method string, body []byte, prefix string, signWith ed25519.PrivateKey) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, "/api/mediamesh/coverage-points", bytes.NewReader(body))
		req.Header.Set("X-MeshCore-Signature", hex.EncodeToString(ed25519.Sign(signWith, covSignedMessage(prefix, body))))
		w := httptest.NewRecorder()
		switch method {
		case http.MethodPost:
			srv.handleCoveragePointsPost(w, req)
		case http.MethodDelete:
			srv.handleCoveragePointsDelete(w, req)
		}
		return w
	}
	body, _ := json.Marshal(covTestBatch(radio, time.Now().Unix()-3600))
	if w := send(http.MethodPost, body, covPointsSignPrefix, priv); w.Code != 200 || !bytes.Contains(w.Body.Bytes(), []byte(`"accepted":20`)) {
		t.Fatalf("upload: %d %s", w.Code, w.Body.String())
	}
	if w := send(http.MethodPost, body, covPointsSignPrefix, priv); w.Code != 200 || !bytes.Contains(w.Body.Bytes(), []byte(`"duplicates":20`)) {
		t.Fatalf("again: %d %s", w.Code, w.Body.String())
	}
	_, other, _ := ed25519.GenerateKey(nil)
	if w := send(http.MethodPost, body, covPointsSignPrefix, other); w.Code != http.StatusUnauthorized {
		t.Fatalf("another key's signature: %d", w.Code)
	}
	if w := send(http.MethodPost, append(body, ' '), covPointsSignPrefix, priv); w.Code != 200 {
		t.Fatalf("signed body with a trailing space: %d %s", w.Code, w.Body.String())
	}
	g := httptest.NewRecorder()
	srv.handleCoveragePointsGet(g, httptest.NewRequest("GET", "/api/mediamesh/coverage-points", nil))
	var cells covCellsResponse
	if err := json.Unmarshal(g.Body.Bytes(), &cells); err != nil || cells.Points != 12 || len(cells.Cells) == 0 {
		t.Fatalf("cells: %v %s", err, g.Body.String())
	}
	if bytes.Contains(g.Body.Bytes(), []byte(radio)) {
		t.Fatal("the public answer names the radio")
	}
	del, _ := json.Marshal(covDeleteRequest{Radio: radio, Sent: time.Now().Unix()})
	if w := send(http.MethodDelete, del, covPointsSignPrefix, priv); w.Code != http.StatusUnauthorized {
		t.Fatalf("a delete signed as an upload: %d", w.Code)
	}
	if w := send(http.MethodDelete, del, covPointsDeletePref, priv); w.Code != 200 || !bytes.Contains(w.Body.Bytes(), []byte(`"removed":20`)) {
		t.Fatalf("delete: %d %s", w.Code, w.Body.String())
	}
	off := false
	srv2 := &Server{cfg: &Config{MediaMeshCoverage: &MediaMeshCoverageConfig{Enabled: &off}}}
	w := httptest.NewRecorder()
	srv2.handleCoveragePointsPost(w, httptest.NewRequest("POST", "/api/mediamesh/coverage-points", bytes.NewReader(body)))
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("switched off: %d", w.Code)
	}
}

func TestCovHexes(t *testing.T) {
	// every point lands in the hexagon whose middle is nearest it, and
	// neighbouring middles are covPointsHexM apart
	for _, p := range [][2]float64{{47.6101, -122.3249}, {47.0001, -122.9999}, {45.5152, -122.6784}, {-33.87, 151.21}} {
		_, cLat, cLon, r := hexOf(p[0], p[1])
		if d := haversineKm(p[0], p[1], cLat, cLon) * 1000; d > covPointsHexM/math.Sqrt(3)*1.01 {
			t.Fatalf("%v: %.0f m from its hexagon's middle", p, d)
		}
		if r <= 0 {
			t.Fatal("no radius")
		}
	}
	k1, a1, o1, _ := hexOf(47.6101, -122.3249)
	k2, a2, o2, _ := hexOf(47.6101+0.0005, -122.3249+0.0001)
	if k1 == k2 {
		k2, a2, o2, _ = hexOf(47.6101+0.0019, -122.3249)
	}
	if d := haversineKm(a1, o1, a2, o2) * 1000; k1 == k2 || math.Abs(d-covPointsHexM) > 3 {
		t.Fatalf("neighbours %s %s %.1f m apart", k1, k2, d)
	}

	// a walk with repeaters answering, then a stretch where none did, and a
	// short margin: hexagons only where one answered; the area only where
	// radio2 would reach
	var pts []storedPoint
	for i := 0; i < 30; i++ {
		var reps []covPointRep
		switch {
		case i < 15:
			reps = []covPointRep{{Key: "1ea5e195", SNR: 4, RemoteSNR: 3, Margin: 6}, {Key: "5d01cacf", SNR: -2, RemoteSNR: -3, Margin: 1}}
		case i < 20:
			reps = []covPointRep{{Key: "5d01cacf", SNR: -8, RemoteSNR: -9, Margin: -3}}
		}
		pts = append(pts, storedPoint{radio: "aa", covPoint: covPoint{T: 1795000000 + int64(i)*60, Lat: 47.60 + float64(i)*0.0009, Lon: -122.32, Reps: reps}})
	}
	c := covCells(pts)
	if c.Trips != 1 || c.HexM != covPointsHexM || len(c.Hexes) == 0 {
		t.Fatalf("trips %d hex_m %v hexes %d", c.Trips, c.HexM, len(c.Hexes))
	}
	short, n := 0, 0
	for _, h := range c.Hexes {
		n += h.N
		if len(h.Reps) == 0 {
			t.Fatal("a hexagon where nobody answered")
		}
		if h.Best < 0 {
			short++
		} else if h.Reps[0].Key != "1ea5e195" || h.Best != h.Reps[0].Margin {
			t.Fatalf("best %v reps %+v", h.Best, h.Reps)
		}
		if h.Car {
			t.Fatal("a walk counted as in a vehicle")
		}
	}
	if short == 0 || c.HexesAnswered != len(c.Hexes)-short {
		t.Fatalf("answered %d of %d, %d short", c.HexesAnswered, len(c.Hexes), short)
	}
	if want := math.Round(float64(c.HexesAnswered)*hexAreaM2()/1e6*100) / 100; c.MappedKm2 != want || want <= 0 {
		t.Fatalf("mapped %v km², want %v", c.MappedKm2, want)
	}
	if n > c.Points {
		t.Fatalf("%d pings in hexagons of %d kept", n, c.Points)
	}
}
