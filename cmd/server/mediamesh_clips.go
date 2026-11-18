package main

import (
	"encoding/hex"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Clips: did each announced photo, video and voice clip get through, and
// how fast. A clip is announced in a text message (VI1/VV1/VE3/VM1
// sid:mode:total:seconds, base 36) and sent as `total` numbered pieces,
// [0x56|0x57][sid:4][index][...], on raw data or in channel data (type
// 0x5643) the analyzer can read. Parity pieces follow on channel pushes:
// [0x56][sid ^ 0xFEC0FEC0][block*8 + j][lastLen][...]; any e pieces lost
// from a block of 20 come back from any e of its parity pieces.
//
// For each clip the "far end" is the observer that heard its pieces over the
// most hops (most pieces breaking a tie): what it heard says whether the
// clip got across. Only clips with an announcement count, since only those
// say how many pieces there are.
//
// Alongside, every photo, video and voice packet by the hour it was first
// heard, for the "when it's busy" heatmap (the browser bins them by local
// weekday and hour).

const (
	mediaClipFecXor   = 0xFEC0FEC0
	mediaClipFecBlock = 20
	mediaClipsMax     = 400
)

var mediaClipAnnRe = regexp.MustCompile(`(?i)(?:^|[\s:])(VI1|VV1|VE3|VM1):([0-9a-z]+):([0-9a-z]+):([0-9a-z]+):([0-9a-z]+)`)

// mediaClipAnn is a parsed announcement.
type mediaClipAnn struct {
	sid     uint32
	kind    string // photo | video | voice
	total   int
	seconds int
	at      time.Time
}

// parseMediaClipAnnouncement reads an announcement out of a message's text.
func parseMediaClipAnnouncement(text string) (mediaClipAnn, bool) {
	m := mediaClipAnnRe.FindStringSubmatch(strings.TrimSpace(text))
	if m == nil {
		return mediaClipAnn{}, false
	}
	sid, err1 := strconv.ParseUint(m[2], 36, 64)
	total, err2 := strconv.ParseInt(m[4], 36, 64)
	secs, err3 := strconv.ParseInt(m[5], 36, 64)
	if err1 != nil || err2 != nil || err3 != nil || sid > 0xFFFFFFFF || total < 1 || total > 4096 || secs < 0 {
		return mediaClipAnn{}, false
	}
	a := mediaClipAnn{sid: uint32(sid), total: int(total), seconds: int(secs)}
	switch strings.ToUpper(m[1]) {
	case "VI1":
		a.kind, a.seconds = "photo", 0
	case "VV1":
		a.kind = "video"
	default:
		a.kind = "voice"
	}
	return a, true
}

// mediaClipPiece is one clip packet as one observer heard it.
type mediaClipPiece struct {
	sid      uint32 // as on the wire (a parity piece carries sid ^ 0xFEC0FEC0)
	info     int    // data: index; parity: block*8 + j
	bytes    int
	observer string
	obsName  string
	path     []string
	at       time.Time
}

// parseMediaClipBytes reads the session id and the index (or parity info)
// byte of a photo, video or voice piece; ok is false for anything else.
func parseMediaClipBytes(b []byte) (sid uint32, info int, ok bool) {
	if len(b) < 6 || (b[0] != 0x56 && b[0] != 0x57 && b[0] != 0x54) {
		return 0, 0, false
	}
	sid = uint32(b[1])<<24 | uint32(b[2])<<16 | uint32(b[3])<<8 | uint32(b[4])
	return sid, int(b[5]), true
}

// MediaMeshClip is one announced clip, as its far end heard it.
type MediaMeshClip struct {
	SID       string   `json:"sid"`
	Kind      string   `json:"kind"`
	Total     int      `json:"total"`
	Seconds   int      `json:"seconds,omitempty"`
	At        string   `json:"at"` // announced
	Heard     int      `json:"heard"`
	Parity    int      `json:"parity"`
	Outcome   string   `json:"outcome"` // whole | parity | partial | none
	Missing   []int    `json:"missing,omitempty"`
	Rebuilt   []int    `json:"rebuilt,omitempty"`
	Observer  string   `json:"observer,omitempty"`
	ObsName   string   `json:"observerName,omitempty"`
	Path      []string `json:"path"`
	Hops      int      `json:"hops"`
	FirstAt   string   `json:"firstAt,omitempty"`
	LastAt    string   `json:"lastAt,omitempty"`
	DurationS float64  `json:"durationS"`
	Bytes     int      `json:"bytes"`
	Observers int      `json:"observers"`
}

// MediaMeshClipHour is the photo, video and voice traffic of one hour.
type MediaMeshClipHour struct {
	T       string `json:"t"` // the hour, UTC
	Packets int    `json:"packets"`
	Clips   int    `json:"clips"` // announced in this hour
	Partial int    `json:"partial"`
}

// MediaMeshClips is /api/analytics/mediamesh/clips.
type MediaMeshClips struct {
	From  string              `json:"from"`
	To    string              `json:"to"`
	Clips []MediaMeshClip     `json:"clips"`
	Hours []MediaMeshClipHour `json:"hours"`
}

// analyseMediaClips matches pieces to announcements and judges each clip at
// its far end. Clips newest first.
func analyseMediaClips(anns []mediaClipAnn, pieces []mediaClipPiece) []MediaMeshClip {
	bySid := map[uint32]int{}
	for i, a := range anns {
		if j, ok := bySid[a.sid]; !ok || a.at.Before(anns[j].at) {
			bySid[a.sid] = i
		}
	}
	type seen struct {
		name        string
		data        map[int]bool
		parity      map[int]int // block -> parity pieces
		maxHops     int
		path        []string
		first, last time.Time
		bytes       int
	}
	per := map[uint32]map[string]*seen{}
	for _, p := range pieces {
		sid, parity := p.sid, false
		if _, ok := bySid[sid]; !ok {
			if _, ok := bySid[sid^mediaClipFecXor]; !ok {
				continue
			}
			sid, parity = sid^mediaClipFecXor, true
		}
		a := anns[bySid[sid]]
		if p.at.Before(a.at.Add(-10*time.Minute)) || p.at.After(a.at.Add(6*time.Hour)) {
			continue // the same session id from another time
		}
		if per[sid] == nil {
			per[sid] = map[string]*seen{}
		}
		key := p.observer
		if key == "" {
			key = p.obsName
		}
		o := per[sid][key]
		if o == nil {
			o = &seen{name: p.obsName, data: map[int]bool{}, parity: map[int]int{}}
			per[sid][key] = o
		}
		if parity {
			o.parity[p.info/8]++
		} else if p.info < a.total {
			if !o.data[p.info] {
				o.bytes += p.bytes
			}
			o.data[p.info] = true
		}
		if o.path == nil || len(p.path) > o.maxHops {
			o.maxHops, o.path = len(p.path), p.path
		}
		if o.first.IsZero() || p.at.Before(o.first) {
			o.first = p.at
		}
		if p.at.After(o.last) {
			o.last = p.at
		}
	}
	out := make([]MediaMeshClip, 0, len(bySid))
	for sid, i := range bySid {
		a := anns[i]
		c := MediaMeshClip{SID: strings.ToLower(hex.EncodeToString([]byte{byte(sid >> 24), byte(sid >> 16), byte(sid >> 8), byte(sid)})),
			Kind: a.kind, Total: a.total, Seconds: a.seconds, At: a.at.UTC().Format(time.RFC3339), Path: []string{}, Outcome: "none"}
		obs := per[sid]
		c.Observers = len(obs)
		var far *seen
		farKey := ""
		for k, o := range obs {
			if len(o.data) == 0 {
				continue
			}
			if far == nil || o.maxHops > far.maxHops || (o.maxHops == far.maxHops && (len(o.data) > len(far.data) || (len(o.data) == len(far.data) && k < farKey))) {
				far, farKey = o, k
			}
		}
		if far != nil {
			c.Observer, c.ObsName, c.Hops = farKey, far.name, far.maxHops
			if far.path != nil {
				c.Path = far.path
			}
			c.Heard = len(far.data)
			for _, n := range far.parity {
				c.Parity += n
			}
			c.FirstAt, c.LastAt = far.first.UTC().Format(time.RFC3339), far.last.UTC().Format(time.RFC3339)
			c.DurationS = far.last.Sub(far.first).Seconds()
			c.Bytes = far.bytes
			missingBy := map[int][]int{}
			for idx := 0; idx < a.total; idx++ {
				if !far.data[idx] {
					missingBy[idx/mediaClipFecBlock] = append(missingBy[idx/mediaClipFecBlock], idx)
				}
			}
			if len(missingBy) == 0 {
				c.Outcome = "whole"
			} else {
				c.Outcome = "parity"
				for b, miss := range missingBy {
					if len(miss) <= far.parity[b] {
						c.Rebuilt = append(c.Rebuilt, miss...)
					} else {
						c.Outcome = "partial"
						c.Missing = append(c.Missing, miss...)
					}
				}
				sort.Ints(c.Missing)
				sort.Ints(c.Rebuilt)
			}
		}
		out = append(out, c)
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].At > out[j].At || (out[i].At == out[j].At && out[i].SID < out[j].SID)
	})
	return out
}

func (s *Server) handleMediaMeshClips(w http.ResponseWriter, r *http.Request) {
	days := 7
	if v, err := strconv.Atoi(r.URL.Query().Get("days")); err == nil && v >= 1 && v <= 28 {
		days = v
	}
	build := func() interface{} {
		now := time.Now().UTC()
		out := &MediaMeshClips{To: now.Format(time.RFC3339), From: now.Add(-time.Duration(days) * 24 * time.Hour).Format(time.RFC3339),
			Clips: []MediaMeshClip{}, Hours: []MediaMeshClipHour{}}
		if s.store != nil {
			s.store.mediaMeshClips(out.From, out)
		}
		return out
	}
	if s.store == nil {
		writeJSON(w, build())
		return
	}
	writeJSON(w, s.store.cachedMediaMesh("mediamesh-clips|"+strconv.Itoa(days), build))
}

// mediaMeshEndpointTTL: how long a clips or replay answer is reused. Each
// is a pass over every packet in memory, and the pages that ask (Insights,
// the recap, the night sky, the kiosk) refetch at most once a minute.
const mediaMeshEndpointTTL = 30 * time.Second

// cachedMediaMesh is build's result, reused for mediaMeshEndpointTTL
// through the shared analytics cache (rfCache).
func (s *PacketStore) cachedMediaMesh(key string, build func() interface{}) interface{} {
	s.cacheMu.Lock()
	if c, ok := s.rfCache[key]; ok && time.Now().Before(c.expiresAt) {
		s.cacheHits++
		s.cacheMu.Unlock()
		return c.data["result"]
	}
	s.cacheMisses++
	s.cacheMu.Unlock()
	res := build()
	s.cacheMu.Lock()
	s.rfCache[key] = &cachedResult{data: map[string]interface{}{"result": res}, expiresAt: time.Now().Add(mediaMeshEndpointTTL)}
	s.cacheMu.Unlock()
	return res
}

// mediaClipPayload is the clip bytes of a photo, video or voice packet's
// decoded payload: raw data, or channel data of type 0x5643 the analyzer
// could read. nil otherwise.
func mediaClipPayload(pt int, d map[string]interface{}) []byte {
	var h string
	switch pt {
	case mediaPayloadRawCustom:
		h, _ = d["raw"].(string)
	case mediaPayloadGrpData:
		if dt := intField(d["dataType"]); dt == nil || *dt != 0x5643 {
			return nil
		}
		h, _ = d["decryptedBlob"].(string)
	}
	if len(h) < 12 {
		return nil
	}
	b, err := hex.DecodeString(h)
	if err != nil {
		return nil
	}
	return b
}

// mediaMeshClips fills out with the clips announced and the hourly traffic
// since `since` (RFC 3339).
func (s *PacketStore) mediaMeshClips(since string, out *MediaMeshClips) {
	var anns []mediaClipAnn
	var pieces []mediaClipPiece
	hours := map[string]*MediaMeshClipHour{}
	hour := func(t time.Time) *MediaMeshClipHour {
		k := t.UTC().Truncate(time.Hour).Format(time.RFC3339)
		h := hours[k]
		if h == nil {
			h = &MediaMeshClipHour{T: k}
			hours[k] = h
		}
		return h
	}
	s.mu.RLock()
	mediaMeshMu.RLock()
	for _, tx := range s.packets {
		if tx == nil || tx.FirstSeen < since || tx.PayloadType == nil {
			continue
		}
		pt := *tx.PayloadType
		if pt == PayloadGRP_TXT {
			d := tx.ParsedDecoded()
			if text, _ := d["text"].(string); text != "" {
				if a, ok := parseMediaClipAnnouncement(text); ok {
					a.at = parseTimestamp(tx.FirstSeen)
					anns = append(anns, a)
				}
			}
			continue
		}
		if pt != mediaPayloadGrpData && pt != mediaPayloadRawCustom {
			continue
		}
		onMM := false
		for _, o := range tx.Observations {
			if _, ok := mediaMeshObs[o.ID]; ok {
				onMM = true
				break
			}
		}
		if !onMM {
			continue
		}
		hour(parseTimestamp(tx.FirstSeen)).Packets++
		b := mediaClipPayload(pt, tx.ParsedDecoded())
		if b == nil {
			continue
		}
		sid, info, ok := parseMediaClipBytes(b)
		if !ok {
			continue
		}
		for _, o := range tx.Observations {
			if _, ok := mediaMeshObs[o.ID]; !ok {
				continue // heard on the main radio: not how it travelled on MediaMesh
			}
			at := parseTimestamp(o.Timestamp)
			if at.IsZero() {
				at = parseTimestamp(tx.FirstSeen)
			}
			pieces = append(pieces, mediaClipPiece{sid: sid, info: info, bytes: len(b), observer: o.ObserverID,
				obsName: o.ObserverName, path: parsePathJSON(o.PathJSON), at: at})
		}
	}
	mediaMeshMu.RUnlock()
	s.mu.RUnlock()
	clips := analyseMediaClips(anns, pieces)
	for _, c := range clips {
		h := hour(parseTimestamp(c.At))
		h.Clips++
		if c.Outcome == "partial" {
			h.Partial++
		}
	}
	if len(clips) > mediaClipsMax {
		clips = clips[:mediaClipsMax]
	}
	out.Clips = clips
	for _, h := range hours {
		out.Hours = append(out.Hours, *h)
	}
	sort.Slice(out.Hours, func(i, j int) bool { return out.Hours[i].T < out.Hours[j].T })
}
