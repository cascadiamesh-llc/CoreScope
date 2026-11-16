package main

import (
	"net/http"
	"sort"
	"strings"
	"time"
)

// MediaMesh (radio2) analytics: how much traffic went over radio2, which
// repeaters run it, and which observers hear it. Built from the in-memory
// store and the MediaMesh marks loaded in mediamesh.go; nothing is stored.
//
// Scope follows the RF analytics: transmissions unique by hash, filtered by
// window (first seen) and, with a region, by the region's observers. A
// transmission counts as MediaMesh when one of its in-scope observations was
// carried on radio2.

// MediaMeshTypeCount is one payload type's total and radio2 share.
type MediaMeshTypeCount struct {
	Name      string `json:"name"`
	Count     int    `json:"count"`
	MediaMesh int    `json:"mediamesh"`
}

// MediaMeshHour is the number of radio2 transmissions first heard in an hour.
type MediaMeshHour struct {
	Hour  string `json:"hour"` // "2006-01-02T15"
	Count int    `json:"count"`
}

// MediaMeshObserver is an observer that heard radio2 traffic, or that runs
// MediaMesh itself (its own status says radio2 is on) and hasn't heard any
// yet: one out of range of the MediaMesh repeaters still belongs in the list.
type MediaMeshObserver struct {
	ID           string  `json:"id"`
	Name         string  `json:"name"`
	IATA         string  `json:"iata,omitempty"`
	MediaMeshObs int     `json:"mediamesh_observations"`
	TotalObs     int     `json:"total_observations"`
	SharePct     float64 `json:"share_pct"`
	LastHeard    string  `json:"last_heard"`
	// RunsMediaMesh: the observer's own status reports radio2 on.
	RunsMediaMesh bool `json:"runs_mediamesh,omitempty"`
	// Near: the closest town or neighbourhood to the observer's node
	// (places.go), when it has a position.
	Near string `json:"near,omitempty"`
}

// MediaMeshRepeater is a node that runs radio2, with its last report.
type MediaMeshRepeater struct {
	PublicKey string `json:"public_key"`
	Name      string `json:"name,omitempty"`
	Role      string `json:"role,omitempty"`
	Near      string `json:"near,omitempty"` // closest town or neighbourhood (places.go)
	// Position for the coverage estimate; absent when the node never sent one.
	Lat *float64 `json:"lat,omitempty"`
	Lon *float64 `json:"lon,omitempty"`
	MediaMeshNode
}

// MediaMeshLink is one node an observer received straight off the air on
// radio2, with the signal it arrived at: what the coverage estimate on the
// MediaMesh tab is compared against. The sender is worked out by
// directHeardNode (direct_heard.go), which names nobody rather than guess.
type MediaMeshLink struct {
	From     string   `json:"from"` // sender's public key
	FromName string   `json:"from_name,omitempty"`
	FromRole string   `json:"from_role,omitempty"`
	FromLat  *float64 `json:"from_lat,omitempty"`
	FromLon  *float64 `json:"from_lon,omitempty"`
	// Radio: the sender's radio2 setting, when it has reported one.
	Radio        string   `json:"radio,omitempty"`
	ObserverID   string   `json:"observer_id"`
	ObserverName string   `json:"observer_name,omitempty"`
	ToLat        *float64 `json:"to_lat,omitempty"` // the observer's own node
	ToLon        *float64 `json:"to_lon,omitempty"`
	Count        int      `json:"count"`
	AvgSNR       *float64 `json:"avg_snr,omitempty"`
	AvgRSSI      *float64 `json:"avg_rssi,omitempty"`
	LastHeard    string   `json:"last_heard"`
}

// mediaMeshMaxLinks caps the links list (busiest first).
const mediaMeshMaxLinks = 200

// mediaMeshLinkAgg accumulates one sender-observer pair.
type mediaMeshLinkAgg struct {
	from, observerID, observerName string
	count, snrN, rssiN             int
	snrSum, rssiSum                float64
	last                           string
}

// add folds one radio2 reception into the pair's totals.
func (a *mediaMeshLinkAgg) add(o *StoreObs) {
	a.count++
	if o.SNR != nil {
		a.snrSum += *o.SNR
		a.snrN++
	}
	if o.RSSI != nil {
		a.rssiSum += *o.RSSI
		a.rssiN++
	}
	if o.Timestamp > a.last {
		a.last = o.Timestamp
	}
}

// mediaMeshLinks turns the pairs into the API list: busiest first, with
// names, roles and positions from the node list where known.
func mediaMeshLinks(aggs map[string]*mediaMeshLinkAgg, nodes map[string]nodeInfo, now time.Time) []MediaMeshLink {
	out := make([]MediaMeshLink, 0, len(aggs))
	pos := func(pk string) (*float64, *float64) {
		n, ok := nodes[strings.ToLower(pk)]
		if !ok || (n.Lat == 0 && n.Lon == 0) {
			return nil, nil
		}
		lat, lon := n.Lat, n.Lon
		return &lat, &lon
	}
	for _, a := range aggs {
		l := MediaMeshLink{From: a.from, ObserverID: a.observerID, ObserverName: a.observerName,
			Count: a.count, LastHeard: a.last}
		if info, ok := nodes[a.from]; ok {
			l.FromName, l.FromRole = info.Name, info.Role
		}
		l.FromLat, l.FromLon = pos(a.from)
		l.ToLat, l.ToLon = pos(a.observerID)
		if n := nodeMediaMeshAt(a.from, now); n != nil {
			l.Radio = n.Radio
		}
		if a.snrN > 0 {
			v := a.snrSum / float64(a.snrN)
			l.AvgSNR = &v
		}
		if a.rssiN > 0 {
			v := a.rssiSum / float64(a.rssiN)
			l.AvgRSSI = &v
		}
		out = append(out, l)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Count != out[j].Count {
			return out[i].Count > out[j].Count
		}
		if out[i].From != out[j].From {
			return out[i].From < out[j].From
		}
		return out[i].ObserverID < out[j].ObserverID
	})
	if len(out) > mediaMeshMaxLinks {
		out = out[:mediaMeshMaxLinks]
	}
	return out
}

// MediaMeshAnalytics is the /api/analytics/mediamesh response.
type MediaMeshAnalytics struct {
	TotalTransmissions     int                  `json:"total_transmissions"`
	MediaMeshTransmissions int                  `json:"mediamesh_transmissions"`
	SharePct               float64              `json:"share_pct"`
	ByType                 []MediaMeshTypeCount `json:"by_type"`
	PerHour                []MediaMeshHour      `json:"per_hour"`
	Observers              []MediaMeshObserver  `json:"observers"`
	Repeaters              []MediaMeshRepeater  `json:"repeaters"`
	// UnknownRepeaters: MediaMesh repeaters known only by their path hash
	// (no advert heard yet), so no name or position.
	UnknownRepeaters []MediaMeshUnknown `json:"unknown_repeaters"`
	// Links: who was heard directly on radio2 by which observer, in scope.
	Links  []MediaMeshLink `json:"links"`
	Window string          `json:"window,omitempty"`
}

func (s *Server) handleAnalyticsMediaMesh(w http.ResponseWriter, r *http.Request) {
	region := r.URL.Query().Get("region")
	window := ParseTimeWindow(r)
	if s.store == nil {
		writeJSON(w, emptyMediaMeshAnalytics())
		return
	}
	writeJSON(w, s.store.GetMediaMeshAnalytics(region, window))
}

func emptyMediaMeshAnalytics() *MediaMeshAnalytics {
	return &MediaMeshAnalytics{
		ByType: []MediaMeshTypeCount{}, PerHour: []MediaMeshHour{},
		Observers: []MediaMeshObserver{}, Repeaters: []MediaMeshRepeater{},
		UnknownRepeaters: []MediaMeshUnknown{}, Links: []MediaMeshLink{},
	}
}

// GetMediaMeshAnalytics is computeMediaMeshAnalytics behind the shared
// short-TTL analytics cache (rfCache), like the relay-airtime share.
func (s *PacketStore) GetMediaMeshAnalytics(region string, window TimeWindow) *MediaMeshAnalytics {
	key := "mediamesh|" + region
	if !window.IsZero() {
		key += "|" + window.CacheKey()
	}
	s.cacheMu.Lock()
	if c, ok := s.rfCache[key]; ok && time.Now().Before(c.expiresAt) {
		s.cacheHits++
		s.cacheMu.Unlock()
		if v, ok := c.data["result"].(*MediaMeshAnalytics); ok {
			return v
		}
	} else {
		s.cacheMisses++
		s.cacheMu.Unlock()
	}
	res := s.computeMediaMeshAnalytics(region, window)
	s.cacheMu.Lock()
	s.rfCache[key] = &cachedResult{data: map[string]interface{}{"result": res}, expiresAt: time.Now().Add(s.rfCacheTTL)}
	s.cacheMu.Unlock()
	return res
}

func (s *PacketStore) computeMediaMeshAnalytics(region string, window TimeWindow) *MediaMeshAnalytics {
	var regionObs map[string]bool
	if region != "" {
		regionObs = s.resolveRegionObservers(region)
	}
	out := emptyMediaMeshAnalytics()
	if !window.IsZero() {
		out.Window = window.Label
	}

	type obsAgg struct {
		name, iata string
		mm, total  int
		last       string
	}
	types := map[string]*MediaMeshTypeCount{}
	hours := map[string]int{}
	observers := map[string]*obsAgg{}
	links := map[string]*mediaMeshLinkAgg{}
	_, pm := s.getCachedNodesAndPM()

	s.mu.RLock()
	mediaMeshMu.RLock()
	anyMM := len(mediaMeshObs) > 0
	seen := make(map[string]bool, len(s.packets))
	for _, tx := range s.packets {
		if tx == nil || !window.Includes(tx.FirstSeen) {
			continue
		}
		if tx.Hash != "" {
			if seen[tx.Hash] {
				continue
			}
			seen[tx.Hash] = true
		}
		inScope := regionObs == nil
		mm := false
		firstMM := ""
		for _, o := range tx.Observations {
			if regionObs != nil && !regionObs[o.ObserverID] {
				continue
			}
			inScope = true
			// The observer table is about what observers hear: an
			// observer's own transmission still makes the packet MediaMesh,
			// but is not something it heard.
			heard := !o.isOwnTransmission()
			var a *obsAgg
			if heard {
				a = observers[o.ObserverID]
				if a == nil {
					a = &obsAgg{name: o.ObserverName, iata: o.ObserverIATA}
					observers[o.ObserverID] = a
				}
				a.total++
			}
			if !anyMM {
				continue
			}
			if _, ok := mediaMeshObs[o.ID]; !ok {
				continue
			}
			mm = true
			if heard {
				a.mm++
				if o.Timestamp > a.last {
					a.last = o.Timestamp
				}
				// A row the observer heard on both radios carries one SNR
				// and RSSI, of whichever copy: not a radio2 measurement.
				if _, both := mediaMeshMainObs[o.ID]; !both && o.ObserverID != "" {
					if from := directHeardNode(tx, o, pm); from != "" && from != strings.ToLower(o.ObserverID) {
						key := from + "|" + o.ObserverID
						l := links[key]
						if l == nil {
							l = &mediaMeshLinkAgg{from: from, observerID: o.ObserverID, observerName: o.ObserverName}
							links[key] = l
						}
						l.add(o)
					}
				}
			}
			if firstMM == "" || (o.Timestamp != "" && o.Timestamp < firstMM) {
				firstMM = o.Timestamp
			}
		}
		if !inScope {
			continue
		}
		name := "UNK"
		if tx.PayloadType != nil {
			if n, ok := payloadTypeNames[*tx.PayloadType]; ok {
				name = n
			}
		}
		t := types[name]
		if t == nil {
			t = &MediaMeshTypeCount{Name: name}
			types[name] = t
		}
		t.Count++
		out.TotalTransmissions++
		if mm {
			t.MediaMesh++
			out.MediaMeshTransmissions++
			if firstMM == "" {
				firstMM = tx.FirstSeen
			}
			if len(firstMM) >= 13 {
				hours[firstMM[:13]]++
			}
		}
	}
	mediaMeshMu.RUnlock()
	s.mu.RUnlock()

	if out.TotalTransmissions > 0 {
		out.SharePct = float64(out.MediaMeshTransmissions) / float64(out.TotalTransmissions) * 100
	}
	for _, t := range types {
		out.ByType = append(out.ByType, *t)
	}
	sort.Slice(out.ByType, func(i, j int) bool {
		if out.ByType[i].Count != out.ByType[j].Count {
			return out.ByType[i].Count > out.ByType[j].Count
		}
		return out.ByType[i].Name < out.ByType[j].Name
	})
	for h, c := range hours {
		out.PerHour = append(out.PerHour, MediaMeshHour{Hour: strings.Replace(h, " ", "T", 1), Count: c})
	}
	sort.Slice(out.PerHour, func(i, j int) bool { return out.PerHour[i].Hour < out.PerHour[j].Hour })
	now := time.Now()
	nodes := s.mediaMeshNodeInfo()
	for id, a := range observers {
		runs := observerRunsMediaMesh(id, now)
		if a.mm == 0 && !runs {
			continue
		}
		o := MediaMeshObserver{ID: id, Name: a.name, IATA: a.iata, MediaMeshObs: a.mm, TotalObs: a.total,
			LastHeard: a.last, RunsMediaMesh: runs, Near: nodeNear(nodes, id)}
		if a.total > 0 {
			o.SharePct = float64(a.mm) / float64(a.total) * 100
		}
		out.Observers = append(out.Observers, o)
	}
	sort.Slice(out.Observers, func(i, j int) bool {
		if out.Observers[i].MediaMeshObs != out.Observers[j].MediaMeshObs {
			return out.Observers[i].MediaMeshObs > out.Observers[j].MediaMeshObs
		}
		return out.Observers[i].ID < out.Observers[j].ID
	})
	out.Repeaters = s.mediaMeshRepeaters(now, nodes)
	out.UnknownRepeaters = mediaMeshUnknownAt(now)
	out.Links = mediaMeshLinks(links, nodes, now)
	return out
}

// mediaMeshNodeInfo is the node list by lower-case public key.
func (s *PacketStore) mediaMeshNodeInfo() map[string]nodeInfo {
	names := map[string]nodeInfo{}
	nodes, _ := s.getCachedNodesAndPM()
	for _, n := range nodes {
		names[strings.ToLower(n.PublicKey)] = n
	}
	return names
}

// nodeNear is "Near" for a node, empty without a position.
func nodeNear(nodes map[string]nodeInfo, pubkey string) string {
	n, ok := nodes[strings.ToLower(pubkey)]
	if !ok || (n.Lat == 0 && n.Lon == 0) {
		return ""
	}
	return nearPlace(n.Lat, n.Lon)
}

// observerRunsMediaMesh reports whether an observer's own status says its
// radio2 is on (a current "status" mark, not off).
func observerRunsMediaMesh(id string, now time.Time) bool {
	n := nodeMediaMeshAt(strings.ToLower(id), now)
	return n != nil && n.Source == "status"
}

// mediaMeshRepeaters lists the nodes with a current MediaMesh mark (the same
// rule as the node API: not off, evidence under 7 days), newest first, with
// the node's name and role when known.
func (s *PacketStore) mediaMeshRepeaters(now time.Time, names map[string]nodeInfo) []MediaMeshRepeater {
	p := mediaMeshNodes.Load()
	out := []MediaMeshRepeater{}
	if p == nil || len(*p) == 0 {
		return out
	}
	for pk := range *p {
		n := nodeMediaMeshAt(pk, now)
		if n == nil {
			continue
		}
		rep := MediaMeshRepeater{PublicKey: pk, MediaMeshNode: *n}
		if info, ok := names[pk]; ok {
			rep.Name, rep.Role = info.Name, info.Role
		}
		rep.Near = nodeNear(names, pk)
		if info, ok := names[pk]; ok && !(info.Lat == 0 && info.Lon == 0) {
			lat, lon := info.Lat, info.Lon
			rep.Lat, rep.Lon = &lat, &lon
		}
		out = append(out, rep)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].LastSeen != out[j].LastSeen {
			return out[i].LastSeen > out[j].LastSeen
		}
		return out[i].PublicKey < out[j].PublicKey
	})
	return out
}
