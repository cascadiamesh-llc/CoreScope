package main

import (
	"encoding/hex"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/gorilla/mux"
)

// The flight recorder of one clip: every piece of it every observer heard on
// radio2, when, and by which path, with the announcement and the clip's
// verdict (analyseMediaClips). The browser draws it as a waterfall, so a
// stalled piece or a hop that drops pieces shows at a glance.

// MediaMeshClipHeard is one observer hearing one piece.
type MediaMeshClipHeard struct {
	Observer string   `json:"observer"`
	Name     string   `json:"name,omitempty"`
	At       string   `json:"at"`
	Path     []string `json:"path"`
}

// MediaMeshClipPiece is one packet of the clip: a data piece (Index) or a
// parity piece (Block, J).
type MediaMeshClipPiece struct {
	Parity bool                 `json:"parity,omitempty"`
	Index  int                  `json:"index"`
	Block  int                  `json:"block,omitempty"`
	J      int                  `json:"j,omitempty"`
	Hash   string               `json:"hash,omitempty"`
	Bytes  int                  `json:"bytes"`
	Heard  []MediaMeshClipHeard `json:"heard"`
	wire   uint32               // the id on the wire
}

// MediaMeshClipHop names a hop of a path, when the analyzer knows it.
type MediaMeshClipHop struct {
	PublicKey string   `json:"public_key,omitempty"`
	Name      string   `json:"name,omitempty"`
	Lat       *float64 `json:"lat,omitempty"`
	Lon       *float64 `json:"lon,omitempty"`
	Ambiguous bool     `json:"ambiguous,omitempty"`
}

// MediaMeshClipLog is /api/analytics/mediamesh/clips/{sid}.
type MediaMeshClipLog struct {
	SID          string                      `json:"sid"`
	Clip         *MediaMeshClip              `json:"clip"`
	Announcement *MediaMeshClipAnnouncement  `json:"announcement"`
	Pieces       []MediaMeshClipPiece        `json:"pieces"`
	Hops         map[string]MediaMeshClipHop `json:"hops"`
}

// MediaMeshClipAnnouncement is the message that announced the clip.
type MediaMeshClipAnnouncement struct {
	At      string               `json:"at"`
	Text    string               `json:"text"`
	Channel string               `json:"channel,omitempty"`
	Heard   []MediaMeshClipHeard `json:"heard"`
}

// mediaClipLogDays: how far back a clip is looked for.
const mediaClipLogDays = 28

func (s *Server) handleMediaMeshClipLog(w http.ResponseWriter, r *http.Request) {
	raw := strings.ToLower(mux.Vars(r)["sid"])
	b, err := hex.DecodeString(raw)
	if err != nil || len(b) != 4 {
		http.Error(w, "sid: 8 hex digits", http.StatusBadRequest)
		return
	}
	sid := uint32(b[0])<<24 | uint32(b[1])<<16 | uint32(b[2])<<8 | uint32(b[3])
	if s.store == nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	since := time.Now().UTC().Add(-mediaClipLogDays * 24 * time.Hour).Format(time.RFC3339)
	res := s.store.cachedMediaMesh("mediamesh-cliplog|"+raw, func() interface{} { return s.store.mediaMeshClipLog(sid, since) })
	out, _ := res.(*MediaMeshClipLog)
	if out == nil || (out.Clip == nil && len(out.Pieces) == 0) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	writeJSON(w, out)
}

// mediaMeshClipLog gathers everything about clip sid since `since` (RFC
// 3339). A parity piece carries sid ^ 0xFEC0FEC0; either id finds the clip.
func (s *PacketStore) mediaMeshClipLog(sid uint32, since string) *MediaMeshClipLog {
	alt := sid ^ mediaClipFecXor
	out := &MediaMeshClipLog{SID: sidHex(sid), Pieces: []MediaMeshClipPiece{}, Hops: map[string]MediaMeshClipHop{}}
	var anns []mediaClipAnn
	var pieces []mediaClipPiece
	hopSet := map[string]bool{}
	heardOf := func(o *StoreObs, fallback string) MediaMeshClipHeard {
		at := o.Timestamp
		if at == "" {
			at = fallback
		}
		p := parsePathJSON(o.PathJSON)
		if p == nil {
			p = []string{}
		}
		for _, h := range p {
			hopSet[strings.ToLower(h)] = true
		}
		return MediaMeshClipHeard{Observer: o.ObserverID, Name: o.ObserverName, At: at, Path: p}
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
			text, _ := d["text"].(string)
			if text == "" {
				continue
			}
			a, ok := parseMediaClipAnnouncement(text)
			if !ok || (a.sid != sid && a.sid != alt) {
				continue
			}
			a.at = parseTimestamp(tx.FirstSeen)
			anns = append(anns, a)
			if out.Announcement == nil || tx.FirstSeen < out.Announcement.At {
				ann := &MediaMeshClipAnnouncement{At: tx.FirstSeen, Text: text, Heard: []MediaMeshClipHeard{}}
				ann.Channel, _ = d["channel"].(string)
				for _, o := range tx.Observations {
					if !o.isOwnTransmission() {
						ann.Heard = append(ann.Heard, heardOf(o, tx.FirstSeen))
					}
				}
				out.Announcement = ann
			}
			continue
		}
		if pt != mediaPayloadGrpData && pt != mediaPayloadRawCustom {
			continue
		}
		b := mediaClipPayload(pt, tx.ParsedDecoded())
		if b == nil {
			continue
		}
		psid, info, ok := parseMediaClipBytes(b)
		if !ok || (psid != sid && psid != alt) {
			continue
		}
		piece := MediaMeshClipPiece{Index: info, Hash: tx.Hash, Bytes: len(b), Heard: []MediaMeshClipHeard{}, wire: psid}
		for _, o := range tx.Observations {
			if _, ok := mediaMeshObs[o.ID]; !ok {
				continue // heard on the main radio: not how it travelled on MediaMesh
			}
			h := heardOf(o, tx.FirstSeen)
			piece.Heard = append(piece.Heard, h)
			at := parseTimestamp(h.At)
			pieces = append(pieces, mediaClipPiece{sid: psid, info: info, bytes: len(b), observer: o.ObserverID,
				obsName: o.ObserverName, path: h.Path, at: at})
		}
		if len(piece.Heard) > 0 {
			sort.Slice(piece.Heard, func(i, j int) bool { return piece.Heard[i].At < piece.Heard[j].At })
			out.Pieces = append(out.Pieces, piece)
		}
	}
	mediaMeshMu.RUnlock()
	s.mu.RUnlock()

	// The id asked for may be the parity pieces' one: the announced id is
	// the clip's own.
	if len(anns) > 0 && anns[0].sid != sid {
		sid = anns[0].sid
		out.SID = sidHex(sid)
	}
	// Only what was heard around the announcement: a session id can come
	// round again weeks later (analyseMediaClips's window).
	if out.Announcement != nil {
		at := parseTimestamp(out.Announcement.At)
		kept := out.Pieces[:0]
		for _, p := range out.Pieces {
			heard := p.Heard[:0]
			for _, h := range p.Heard {
				t := parseTimestamp(h.At)
				if !t.Before(at.Add(-10*time.Minute)) && !t.After(at.Add(6*time.Hour)) {
					heard = append(heard, h)
				}
			}
			if len(heard) > 0 {
				p.Heard = heard
				kept = append(kept, p)
			}
		}
		out.Pieces = kept
	}
	for i := range out.Pieces {
		p := &out.Pieces[i]
		if p.wire != sid {
			p.Parity, p.Block, p.J, p.Index = true, p.Index/8, p.Index%8, -1
		}
	}
	if clips := analyseMediaClips(anns, pieces); len(clips) > 0 {
		c := clips[0]
		out.Clip = &c
	}
	sort.Slice(out.Pieces, func(i, j int) bool {
		a, b := out.Pieces[i], out.Pieces[j]
		if a.Parity != b.Parity {
			return !a.Parity
		}
		if a.Parity {
			if a.Block != b.Block {
				return a.Block < b.Block
			}
			return a.J < b.J
		}
		if a.Index != b.Index {
			return a.Index < b.Index
		}
		return a.Heard[0].At < b.Heard[0].At
	})

	_, pm := s.getCachedNodesAndPM()
	for h := range hopSet {
		hop := MediaMeshClipHop{}
		if pm != nil {
			cands := pm.relayCandidates(h)
			if n := pm.resolve(h); n != nil {
				hop.PublicKey, hop.Name = n.PublicKey, n.Name
				if n.HasGPS {
					lat, lon := n.Lat, n.Lon
					hop.Lat, hop.Lon = &lat, &lon
				}
				hop.Ambiguous = len(cands) > 1
			}
		}
		out.Hops[h] = hop
	}
	return out
}

func sidHex(sid uint32) string {
	return strings.ToLower(hex.EncodeToString([]byte{byte(sid >> 24), byte(sid >> 16), byte(sid >> 8), byte(sid)}))
}
