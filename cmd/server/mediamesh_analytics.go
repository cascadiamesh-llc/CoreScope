package main

import (
	"math"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/gorilla/mux"
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
	// FirstSeen: when it first relayed or heard a MediaMesh photo or voice
	// packet (or was first marked); RelayedWeek: photo and voice packets it
	// relayed in the last week. From the ingestor's mediamesh_node_stats.
	FirstSeen   string `json:"first_seen,omitempty"`
	RelayedWeek int    `json:"media_relayed_7d"`
	// ClipsWeek: whole clips among them (photos, videos, voice clips), of
	// which ClipsEstimatedWeek were estimated from bursts of packets whose
	// contents the analyzer can't read.
	ClipsWeek          int `json:"media_clips_7d"`
	ClipsEstimatedWeek int `json:"media_clips_estimated_7d"`
	// PositionFromName: it never sent a position; Lat/Lon is the middle of
	// the place its name names (Near), a guess.
	PositionFromName bool `json:"position_from_name,omitempty"`
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

// The payload types that carry MediaMesh photos and voice.
const (
	mediaPayloadGrpData   = 6
	mediaPayloadRawCustom = 15
)

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
		// a position guessed from a name is no good for measuring a link
		if !ok || (n.Lat == 0 && n.Lon == 0) || n.GuessedPlace != "" {
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

// MediaMeshMediaStats sums up the photo and voice packets: how many, and how
// many hops they travelled (the longest MediaMesh path any observer saw
// each one arrive by).
type MediaMeshMediaStats struct {
	Packets    int     `json:"packets"`
	MedianHops float64 `json:"median_hops"`
	MaxHops    int     `json:"max_hops"`
}

// mediaMeshMediaStatsOf turns per-packet hop counts into the summary.
func mediaMeshMediaStatsOf(hops []int) MediaMeshMediaStats {
	out := MediaMeshMediaStats{Packets: len(hops)}
	if len(hops) == 0 {
		return out
	}
	sort.Ints(hops)
	out.MaxHops = hops[len(hops)-1]
	if m := len(hops) / 2; len(hops)%2 == 1 {
		out.MedianHops = float64(hops[m])
	} else {
		out.MedianHops = float64(hops[m-1]+hops[m]) / 2
	}
	return out
}

// MediaMeshBackboneEdge is one hop photos, video or voice took this week.
type MediaMeshBackboneEdge struct {
	A       string  `json:"a"`
	B       string  `json:"b"`
	AName   string  `json:"a_name,omitempty"`
	BName   string  `json:"b_name,omitempty"`
	ALat    float64 `json:"a_lat"`
	ALon    float64 `json:"a_lon"`
	BLat    float64 `json:"b_lat"`
	BLon    float64 `json:"b_lon"`
	Packets int     `json:"packets"`
}

// mediaMeshMaxBackbone caps the backbone list (busiest first).
const mediaMeshMaxBackbone = 400

// mediaMeshBackbone turns the stored edges into the API list: both ends
// with a position, names from the node list, keep(pk) false drops an edge.
func mediaMeshBackbone(nodes map[string]nodeInfo, keep func(string) bool) []MediaMeshBackboneEdge {
	out := []MediaMeshBackboneEdge{}
	p := mediaMeshEdges.Load()
	if p == nil {
		return out
	}
	for _, e := range *p {
		if keep != nil && (!keep(e.A) || !keep(e.B)) {
			continue
		}
		a, okA := nodes[e.A]
		b, okB := nodes[e.B]
		if !okA || !okB || (a.Lat == 0 && a.Lon == 0) || (b.Lat == 0 && b.Lon == 0) {
			continue
		}
		out = append(out, MediaMeshBackboneEdge{A: e.A, B: e.B, AName: a.Name, BName: b.Name,
			ALat: a.Lat, ALon: a.Lon, BLat: b.Lat, BLon: b.Lon, Packets: e.Packets})
		if len(out) >= mediaMeshMaxBackbone {
			break
		}
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
	// Media: the photo and voice packets (GRP_DATA, RAW_CUSTOM) in scope.
	Media MediaMeshMediaStats `json:"media"`
	// Backbone: who passed photos, video and voice to whom this week, busiest
	// first, both ends placed (not scoped to the region or window).
	Backbone []MediaMeshBackboneEdge `json:"backbone"`
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
	res := s.store.GetMediaMeshAnalytics(region, window)
	// The backbone names nodes by key: leave out blacklisted and hidden ones
	// (a copy, the cached result stays whole).
	if len(res.Backbone) > 0 {
		cp := *res
		cp.Backbone = make([]MediaMeshBackboneEdge, 0, len(res.Backbone))
		for _, e := range res.Backbone {
			if s.mediaMeshNodeShown(e.A) && s.mediaMeshNodeShown(e.B) {
				cp.Backbone = append(cp.Backbone, e)
			}
		}
		res = &cp
	}
	writeJSON(w, res)
}

// mediaMeshNodeShown: not blacklisted and not hidden by name prefix.
func (s *Server) mediaMeshNodeShown(pk string) bool {
	if s.cfg != nil && s.cfg.IsBlacklisted(pk) {
		return false
	}
	return !s.isPubkeyHidden(pk)
}

// MediaMeshNodeReport is /api/nodes/{pubkey}/mediamesh: one node's part in
// MediaMesh, for its page.
type MediaMeshNodeReport struct {
	PublicKey string `json:"public_key"`
	// Repeater: its MediaMesh mark, nil when it isn't a MediaMesh repeater.
	Repeater *MediaMeshRepeater `json:"repeater,omitempty"`
	// Rank among the repeaters by photos, video and voice relayed this week
	// (1 = most), 0 when it relayed none; out of RankOf.
	Rank   int `json:"rank"`
	RankOf int `json:"rank_of"`
	// Daily: packets relayed per day, the last 14 days, oldest first.
	Daily []MediaMeshDay `json:"daily"`
	// Backbone: its hops this week, busiest first.
	Backbone []MediaMeshBackboneEdge `json:"backbone"`
}

// MediaMeshDay is one day's relay count.
type MediaMeshDay struct {
	Day     string `json:"day"`
	Packets int    `json:"packets"`
}

func (s *Server) handleNodeMediaMesh(w http.ResponseWriter, r *http.Request) {
	pk := strings.ToLower(mux.Vars(r)["pubkey"])
	if !s.mediaMeshNodeShown(pk) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	out := MediaMeshNodeReport{PublicKey: pk, Daily: []MediaMeshDay{}, Backbone: []MediaMeshBackboneEdge{}}
	if s.store == nil {
		writeJSON(w, out)
		return
	}
	now := time.Now()
	nodes := s.store.mediaMeshNodeInfo()
	reps := s.store.mediaMeshRepeaters(now, nodes)
	for i := range reps {
		if reps[i].RelayedWeek > 0 {
			out.RankOf++
		}
	}
	sort.SliceStable(reps, func(i, j int) bool { return reps[i].RelayedWeek > reps[j].RelayedWeek })
	for i := range reps {
		if reps[i].PublicKey == pk {
			rep := reps[i]
			out.Repeater = &rep
			if rep.RelayedWeek > 0 {
				out.Rank = 1
				for j := 0; j < i; j++ {
					if reps[j].RelayedWeek > rep.RelayedWeek {
						out.Rank++
					}
				}
			}
			break
		}
	}
	out.Daily = mediaMeshDailyOf(pk, now)
	for _, e := range mediaMeshBackbone(nodes, s.mediaMeshNodeShown) {
		if e.A == pk || e.B == pk {
			out.Backbone = append(out.Backbone, e)
		}
	}
	writeJSON(w, out)
}

// mediaMeshDailyOf is a node's relay count for each of the last 14 UTC days,
// oldest first, zero on days without any.
func mediaMeshDailyOf(pk string, now time.Time) []MediaMeshDay {
	var days map[string]int
	if p := mediaMeshDaily.Load(); p != nil {
		days = (*p)[strings.ToLower(pk)]
	}
	out := make([]MediaMeshDay, 0, 14)
	for i := 13; i >= 0; i-- {
		d := now.UTC().AddDate(0, 0, -i).Format("2006-01-02")
		out = append(out, MediaMeshDay{Day: d, Packets: days[d]})
	}
	return out
}

func emptyMediaMeshAnalytics() *MediaMeshAnalytics {
	return &MediaMeshAnalytics{
		ByType: []MediaMeshTypeCount{}, PerHour: []MediaMeshHour{},
		Observers: []MediaMeshObserver{}, Repeaters: []MediaMeshRepeater{},
		UnknownRepeaters: []MediaMeshUnknown{}, Links: []MediaMeshLink{}, Backbone: []MediaMeshBackboneEdge{},
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
	tallies, oldest := s.mediaMeshTallies(regionObs, window)
	// Hours whose packets have left memory, from those kept on disk
	// (mediamesh_hours_keep.go); the whole network only.
	if region == "" {
		if f := mmKeptHours.Load(); f != nil && oldest != "" {
			for h, t := range (*f)(window, mmHourAfter(oldest)) {
				if _, ok := tallies[h]; !ok || t.Total > tallies[h].Total {
					tallies[h] = t
				}
			}
		}
	}
	sum := newMMTally()
	for _, t := range tallies {
		sum.add(t)
	}
	s.mediaMeshFromTally(out, sum)
	return out
}

// mmTally is the part of the MediaMesh analytics worked out from packets in
// memory, for one hour's packets (by when they were first heard), so hours
// can be kept on disk and added up.
type mmTally struct {
	Total int                     `json:"t"`
	MM    int                     `json:"m"`
	Types map[string][2]int       `json:"ty"` // name → [count, on radio2]
	Hours map[string]int          `json:"h"`  // radio2 transmissions by hour first heard on radio2
	Obs   map[string]*mmObsTally  `json:"o"`
	Links map[string]*mmLinkTally `json:"l"`
	Hops  map[int]int             `json:"hp"` // photo and voice packets by hops
}

type mmObsTally struct {
	Name  string `json:"n,omitempty"`
	IATA  string `json:"i,omitempty"`
	MM    int    `json:"m"`
	Total int    `json:"t"`
	Last  string `json:"l,omitempty"`
}

type mmLinkTally struct {
	From    string  `json:"f"`
	Obs     string  `json:"o"`
	ObsName string  `json:"on,omitempty"`
	Count   int     `json:"c"`
	SNRSum  float64 `json:"ss,omitempty"`
	SNRN    int     `json:"sn,omitempty"`
	RSSISum float64 `json:"rs,omitempty"`
	RSSIN   int     `json:"rn,omitempty"`
	Last    string  `json:"l,omitempty"`
}

func newMMTally() *mmTally {
	return &mmTally{Types: map[string][2]int{}, Hours: map[string]int{}, Obs: map[string]*mmObsTally{},
		Links: map[string]*mmLinkTally{}, Hops: map[int]int{}}
}

// add folds b into t.
func (t *mmTally) add(b *mmTally) {
	t.Total += b.Total
	t.MM += b.MM
	for k, v := range b.Types {
		c := t.Types[k]
		t.Types[k] = [2]int{c[0] + v[0], c[1] + v[1]}
	}
	for k, v := range b.Hours {
		t.Hours[k] += v
	}
	for k, v := range b.Obs {
		o := t.Obs[k]
		if o == nil {
			o = &mmObsTally{Name: v.Name, IATA: v.IATA}
			t.Obs[k] = o
		}
		o.MM += v.MM
		o.Total += v.Total
		if v.Last > o.Last {
			o.Last = v.Last
		}
		if o.Name == "" {
			o.Name, o.IATA = v.Name, v.IATA
		}
	}
	for k, v := range b.Links {
		l := t.Links[k]
		if l == nil {
			l = &mmLinkTally{From: v.From, Obs: v.Obs, ObsName: v.ObsName}
			t.Links[k] = l
		}
		l.Count += v.Count
		l.SNRSum += v.SNRSum
		l.SNRN += v.SNRN
		l.RSSISum += v.RSSISum
		l.RSSIN += v.RSSIN
		if v.Last > l.Last {
			l.Last = v.Last
		}
	}
	for k, v := range b.Hops {
		t.Hops[k] += v
	}
}

// mmHourOf is the UTC hour ("2006-01-02T15") of a timestamp, "" if none.
func mmHourOf(ts string) string {
	t := parseTimestamp(ts)
	if t.IsZero() {
		return ""
	}
	return t.UTC().Format("2006-01-02T15")
}

// mmHourAfter: the first hour wholly after ts (the oldest packet in memory):
// hours before it have lost packets from memory.
func mmHourAfter(ts string) string {
	t := parseTimestamp(ts)
	if t.IsZero() {
		return ""
	}
	return t.UTC().Truncate(time.Hour).Add(time.Hour).Format("2006-01-02T15")
}

// mediaMeshTallies passes once over the packets in memory in the window:
// a tally for each hour, and the oldest packet's first-heard time.
func (s *PacketStore) mediaMeshTallies(regionObs map[string]bool, window TimeWindow) (map[string]*mmTally, string) {
	tallies := map[string]*mmTally{}
	oldest := ""
	_, pm := s.getCachedNodesAndPM()

	s.mu.RLock()
	mediaMeshMu.RLock()
	anyMM := len(mediaMeshObs) > 0
	seen := make(map[string]bool, len(s.packets))
	bursts := s.mediaMeshBurstsLocked("")
	for _, tx := range s.packets {
		if tx == nil {
			continue
		}
		if tx.FirstSeen != "" && (oldest == "" || tx.FirstSeen < oldest) {
			oldest = tx.FirstSeen
		}
		if !window.Includes(tx.FirstSeen) {
			continue
		}
		if tx.Hash != "" {
			if seen[tx.Hash] {
				continue
			}
			seen[tx.Hash] = true
		}
		hk := mmHourOf(tx.FirstSeen)
		tl := tallies[hk]
		if tl == nil {
			tl = newMMTally()
			tallies[hk] = tl
		}
		inScope := regionObs == nil
		mm := false
		firstMM := ""
		mmHops := -1
		for _, o := range tx.Observations {
			if regionObs != nil && !regionObs[o.ObserverID] {
				continue
			}
			inScope = true
			// The observer table is about what observers hear: an
			// observer's own transmission still makes the packet MediaMesh,
			// but is not something it heard.
			heard := !o.isOwnTransmission()
			var a *mmObsTally
			if heard {
				a = tl.Obs[o.ObserverID]
				if a == nil {
					a = &mmObsTally{Name: o.ObserverName, IATA: o.ObserverIATA}
					tl.Obs[o.ObserverID] = a
				}
				a.Total++
			}
			if !anyMM {
				continue
			}
			if _, ok := mediaMeshObs[o.ID]; !ok {
				continue
			}
			mm = true
			if n := len(parsePathJSON(o.PathJSON)); n > mmHops {
				mmHops = n
			}
			if heard {
				a.MM++
				if o.Timestamp > a.Last {
					a.Last = o.Timestamp
				}
				// A row the observer heard on both radios carries one SNR
				// and RSSI, of whichever copy: not a radio2 measurement.
				if _, both := mediaMeshMainObs[o.ID]; !both && o.ObserverID != "" {
					if from := directHeardNode(tx, o, pm); from != "" && from != strings.ToLower(o.ObserverID) {
						key := from + "|" + o.ObserverID
						l := tl.Links[key]
						if l == nil {
							l = &mmLinkTally{From: from, Obs: o.ObserverID, ObsName: o.ObserverName}
							tl.Links[key] = l
						}
						l.Count++
						if o.SNR != nil {
							l.SNRSum += *o.SNR
							l.SNRN++
						}
						if o.RSSI != nil {
							l.RSSISum += *o.RSSI
							l.RSSIN++
						}
						if o.Timestamp > l.Last {
							l.Last = o.Timestamp
						}
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
		c := tl.Types[name]
		c[0]++
		tl.Total++
		if mm {
			c[1]++
			tl.MM++
			if firstMM == "" {
				firstMM = tx.FirstSeen
			}
			if len(firstMM) >= 13 {
				tl.Hours[firstMM[:13]]++
			}
			if mediaMeshIsMedia(tx, bursts) && mmHops >= 0 {
				tl.Hops[mmHops]++
			}
		}
		tl.Types[name] = c
	}
	mediaMeshMu.RUnlock()
	s.mu.RUnlock()
	return tallies, oldest
}

// mediaMeshFromTally fills out's counts, types, hours, observers, links and
// media stats from the tally, and its repeaters and backbone.
func (s *PacketStore) mediaMeshFromTally(out *MediaMeshAnalytics, t *mmTally) {
	out.TotalTransmissions = t.Total
	out.MediaMeshTransmissions = t.MM
	if out.TotalTransmissions > 0 {
		out.SharePct = float64(out.MediaMeshTransmissions) / float64(out.TotalTransmissions) * 100
	}
	for name, c := range t.Types {
		out.ByType = append(out.ByType, MediaMeshTypeCount{Name: name, Count: c[0], MediaMesh: c[1]})
	}
	sort.Slice(out.ByType, func(i, j int) bool {
		if out.ByType[i].Count != out.ByType[j].Count {
			return out.ByType[i].Count > out.ByType[j].Count
		}
		return out.ByType[i].Name < out.ByType[j].Name
	})
	for h, c := range t.Hours {
		out.PerHour = append(out.PerHour, MediaMeshHour{Hour: strings.Replace(h, " ", "T", 1), Count: c})
	}
	sort.Slice(out.PerHour, func(i, j int) bool { return out.PerHour[i].Hour < out.PerHour[j].Hour })
	now := time.Now()
	nodes := s.mediaMeshNodeInfo()
	for id, a := range t.Obs {
		runs := observerRunsMediaMesh(id, now)
		if a.MM == 0 && !runs {
			continue
		}
		o := MediaMeshObserver{ID: id, Name: a.Name, IATA: a.IATA, MediaMeshObs: a.MM, TotalObs: a.Total,
			LastHeard: a.Last, RunsMediaMesh: runs, Near: nodeNear(nodes, id)}
		if a.Total > 0 {
			o.SharePct = float64(a.MM) / float64(a.Total) * 100
		}
		out.Observers = append(out.Observers, o)
	}
	sort.Slice(out.Observers, func(i, j int) bool {
		if out.Observers[i].MediaMeshObs != out.Observers[j].MediaMeshObs {
			return out.Observers[i].MediaMeshObs > out.Observers[j].MediaMeshObs
		}
		return out.Observers[i].ID < out.Observers[j].ID
	})
	links := make(map[string]*mediaMeshLinkAgg, len(t.Links))
	for k, l := range t.Links {
		links[k] = &mediaMeshLinkAgg{from: l.From, observerID: l.Obs, observerName: l.ObsName, count: l.Count,
			snrN: l.SNRN, rssiN: l.RSSIN, snrSum: l.SNRSum, rssiSum: l.RSSISum, last: l.Last}
	}
	var hops []int
	for h, n := range t.Hops {
		for i := 0; i < n; i++ {
			hops = append(hops, h)
		}
	}
	out.Repeaters = s.mediaMeshRepeaters(now, nodes)
	out.UnknownRepeaters = withNeighbourNames(mediaMeshUnknownAt(now), nodes)
	out.Links = mediaMeshLinks(links, nodes, now)
	out.Media = mediaMeshMediaStatsOf(hops)
	out.Backbone = mediaMeshBackbone(nodes, nil)
}

// mediaMeshNodeInfo is the node list by lower-case public key.
func (s *PacketStore) mediaMeshNodeInfo() map[string]nodeInfo {
	names := map[string]nodeInfo{}
	nodes, _ := s.getCachedNodesAndPM()
	for _, n := range nodes {
		names[strings.ToLower(n.PublicKey)] = n
	}
	// MediaMesh repeaters that never sent a position: where their name says
	// (Rainier Vista East, UpperFremont), near the middle of the others
	p := mediaMeshNodes.Load()
	if p == nil {
		return names
	}
	var sLat, sLon float64
	placed := 0
	for pk := range *p {
		if n, ok := names[pk]; ok && !(n.Lat == 0 && n.Lon == 0) {
			sLat += n.Lat
			sLon += n.Lon
			placed++
		}
	}
	cLat, cLon := math.NaN(), math.NaN()
	if placed > 0 {
		cLat, cLon = sLat/float64(placed), sLon/float64(placed)
	}
	for pk := range *p {
		n, ok := names[pk]
		if !ok || !(n.Lat == 0 && n.Lon == 0) || n.Name == "" {
			continue
		}
		if lat, lon, label, ok := guessPlace(n.Name, cLat, cLon); ok {
			n.Lat, n.Lon, n.GuessedPlace = lat, lon, label
			names[pk] = n
		}
	}
	return names
}

// nodeNear is "Near" for a node, empty without a position.
func nodeNear(nodes map[string]nodeInfo, pubkey string) string {
	n, ok := nodes[strings.ToLower(pubkey)]
	if !ok || (n.Lat == 0 && n.Lon == 0) {
		return ""
	}
	if n.GuessedPlace != "" {
		return n.GuessedPlace
	}
	return nearPlaceNamed(n.Lat, n.Lon, n.Name)
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
		st := mediaMeshNodeStatOf(pk)
		rep.FirstSeen, rep.RelayedWeek = st.FirstSeen, st.Relayed7d
		rep.ClipsWeek, rep.ClipsEstimatedWeek = st.Clips7d, st.ClipsEstimated7d
		if info, ok := names[pk]; ok && !(info.Lat == 0 && info.Lon == 0) {
			lat, lon := info.Lat, info.Lon
			rep.Lat, rep.Lon = &lat, &lon
			rep.PositionFromName = info.GuessedPlace != ""
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
