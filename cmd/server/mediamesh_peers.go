package main

// Cascadia-wide view (public/mediamesh-cascadia.js): this analyzer's
// MediaMesh and that of the analyzers in config.json's
// mediameshCoverage.peers, side by side. For each: its MediaMesh repeaters
// with positions, how many links were heard, and the week's clips.
// Peers' /api/analytics/mediamesh is fetched by the server (cached ten
// minutes), so browsers needn't reach other sites.
//
// GET /api/mediamesh/peers → { "regions": [{ "name", "url", "self",
//   "ok", "repeaters": [{ "name", "lat", "lon" }], "links",
//   "media_clips_7d", "link_km" (median length of links heard) }] }

import (
	"encoding/json"
	"io"
	"math"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"
)

// MediaMeshPeer is one other analyzer: a name for it and its address.
type MediaMeshPeer struct {
	Name string `json:"name"`
	URL  string `json:"url"`
}

type peerRepeater struct {
	Name string  `json:"name"`
	Lat  float64 `json:"lat"`
	Lon  float64 `json:"lon"`
}

type peerRegion struct {
	Name      string         `json:"name"`
	URL       string         `json:"url,omitempty"`
	Self      bool           `json:"self,omitempty"`
	OK        bool           `json:"ok"`
	Repeaters []peerRepeater `json:"repeaters"`
	Links     int            `json:"links"`
	Clips7d   int            `json:"media_clips_7d"`
	LinkKm    float64        `json:"link_km,omitempty"`
}

var peerCache = struct {
	sync.Mutex
	m map[string]peerCacheEntry
}{m: map[string]peerCacheEntry{}}

type peerCacheEntry struct {
	at  time.Time
	reg peerRegion
}

var peerClient = &http.Client{Timeout: 10 * time.Second}

// regionFrom sums up an analyzer's /api/analytics/mediamesh.
func regionFrom(name string, mm *MediaMeshAnalytics) peerRegion {
	reg := peerRegion{Name: name, OK: true, Repeaters: []peerRepeater{}}
	if mm == nil {
		return reg
	}
	for _, r := range mm.Repeaters {
		reg.Clips7d += r.ClipsWeek
		if r.Lat == nil || r.Lon == nil || r.PositionFromName {
			continue
		}
		reg.Repeaters = append(reg.Repeaters, peerRepeater{Name: r.Name, Lat: *r.Lat, Lon: *r.Lon})
	}
	reg.Links = len(mm.Links)
	var kms []float64
	for _, l := range mm.Links {
		if l.FromLat != nil && l.FromLon != nil && l.ToLat != nil && l.ToLon != nil {
			kms = append(kms, haversineKm(*l.FromLat, *l.FromLon, *l.ToLat, *l.ToLon))
		}
	}
	if len(kms) > 0 {
		sort.Float64s(kms)
		reg.LinkKm = math.Round(kms[len(kms)/2]*10) / 10
	}
	return reg
}

// peerAddress: the peer's analytics address, or "" when its URL isn't a
// plain http(s) address.
func peerAddress(raw string) string {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
		return ""
	}
	return u.Scheme + "://" + u.Host + strings.TrimRight(u.Path, "/") + "/api/analytics/mediamesh"
}

func fetchPeer(p MediaMeshPeer) peerRegion {
	reg := peerRegion{Name: p.Name, URL: p.URL, Repeaters: []peerRepeater{}}
	addr := peerAddress(p.URL)
	if addr == "" {
		return reg
	}
	peerCache.Lock()
	e, ok := peerCache.m[addr]
	peerCache.Unlock()
	if ok && time.Since(e.at) < 10*time.Minute {
		return e.reg
	}
	resp, err := peerClient.Get(addr)
	if err == nil {
		body, rerr := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
		resp.Body.Close()
		var mm MediaMeshAnalytics
		if rerr == nil && resp.StatusCode == http.StatusOK && json.Unmarshal(body, &mm) == nil {
			reg = regionFrom(p.Name, &mm)
			reg.URL = p.URL
		}
	}
	peerCache.Lock()
	peerCache.m[addr] = peerCacheEntry{at: time.Now(), reg: reg}
	peerCache.Unlock()
	return reg
}

func (s *Server) handleMediaMeshPeers(w http.ResponseWriter, r *http.Request) {
	regions := []peerRegion{}
	if s.store != nil {
		self := regionFrom("This analyzer", s.store.GetMediaMeshAnalytics("", TimeWindow{}))
		self.Self = true
		regions = append(regions, self)
	}
	peers := s.cfg.mediaMeshCoverage().Peers
	out := make([]peerRegion, len(peers))
	var wg sync.WaitGroup
	for i, p := range peers {
		wg.Add(1)
		go func(i int, p MediaMeshPeer) {
			defer wg.Done()
			out[i] = fetchPeer(p)
		}(i, p)
	}
	wg.Wait()
	regions = append(regions, out...)
	w.Header().Set("Cache-Control", "public, max-age=300")
	writeJSON(w, map[string]interface{}{"regions": regions})
}
