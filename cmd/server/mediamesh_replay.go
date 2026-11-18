package main

import (
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// "A day in 60 seconds": the photo, video and voice packets of the last
// hours, for the Live page's night-sky view to replay sped up. Each event
// carries what the Live page needs to draw it: the path an observer heard it
// by (hop prefixes, resolved in the browser as for live packets), and the
// few payload bytes that say which clip it belongs to. Clip announcements
// (VI1/VV1/VE3/VM1 text) the analyzer could read come alongside, so the
// replay can name photos, videos and voice the way the live feed does.

// MediaMeshReplayEvent is one photo, video or voice packet.
type MediaMeshReplayEvent struct {
	Hash     string   `json:"hash"`
	TS       string   `json:"ts"`
	Type     string   `json:"type"` // GRP_DATA | RAW_CUSTOM
	Path     []string `json:"path"`
	Observer string   `json:"observer,omitempty"`
	// The payload fields that identify the clip, trimmed.
	Raw           string `json:"raw,omitempty"`
	ChannelHash   *int   `json:"channelHash,omitempty"`
	DataType      *int   `json:"dataType,omitempty"`
	DecryptedBlob string `json:"decryptedBlob,omitempty"`
}

// MediaMeshAnnouncement is a readable clip announcement.
type MediaMeshAnnouncement struct {
	TS   string `json:"ts"`
	Text string `json:"text"`
}

// MediaMeshReplay is /api/analytics/mediamesh/replay.
type MediaMeshReplay struct {
	From          string                  `json:"from"`
	To            string                  `json:"to"`
	Events        []MediaMeshReplayEvent  `json:"events"`
	Announcements []MediaMeshAnnouncement `json:"announcements"`
	Truncated     bool                    `json:"truncated,omitempty"`
}

const mediaMeshReplayMax = 6000

var mediaMeshAnnouncementRe = regexp.MustCompile(`(?i)(^|[\s:])(VI1|VV1|VE3|VM1):[0-9a-z]+:[0-9a-z]+:[0-9a-z]+:[0-9a-z]+`)

func (s *Server) handleMediaMeshReplay(w http.ResponseWriter, r *http.Request) {
	hours := 24
	if v, err := strconv.Atoi(r.URL.Query().Get("hours")); err == nil && v >= 1 && v <= 72 {
		hours = v
	}
	now := time.Now().UTC()
	out := &MediaMeshReplay{To: now.Format(time.RFC3339), Events: []MediaMeshReplayEvent{}, Announcements: []MediaMeshAnnouncement{}}
	if s.store == nil {
		out.From = out.To
		writeJSON(w, out)
		return
	}
	since := now.Add(-time.Duration(hours) * time.Hour).Format(time.RFC3339)
	s.store.mediaMeshReplay(since, out)
	if out.From == "" {
		out.From = since
	}
	writeJSON(w, out)
}

// trimHex keeps the first n hex characters of a payload field.
func trimHex(v interface{}, n int) string {
	s, _ := v.(string)
	if len(s) > n {
		s = s[:n]
	}
	return strings.ToLower(s)
}

func intField(v interface{}) *int {
	if f, ok := v.(float64); ok {
		i := int(f)
		return &i
	}
	return nil
}

// mediaMeshReplay fills out with the packets first seen since `since` (RFC
// 3339), oldest first.
func (s *PacketStore) mediaMeshReplay(since string, out *MediaMeshReplay) {
	s.mu.RLock()
	mediaMeshMu.RLock()
	for _, tx := range s.packets {
		if tx == nil || tx.FirstSeen < since || tx.PayloadType == nil {
			continue
		}
		pt := *tx.PayloadType
		if pt == PayloadGRP_TXT {
			d := tx.ParsedDecoded()
			if text, _ := d["text"].(string); text != "" && mediaMeshAnnouncementRe.MatchString(text) {
				out.Announcements = append(out.Announcements, MediaMeshAnnouncement{TS: tx.FirstSeen, Text: text})
			}
			continue
		}
		if pt != mediaPayloadGrpData && pt != mediaPayloadRawCustom {
			continue
		}
		// the longest path any observer heard it by on radio2
		var best *StoreObs
		bestN := -1
		for _, o := range tx.Observations {
			if _, ok := mediaMeshObs[o.ID]; !ok {
				continue
			}
			if n := len(parsePathJSON(o.PathJSON)); n > bestN {
				best, bestN = o, n
			}
		}
		if best == nil {
			continue
		}
		name := "GRP_DATA"
		if pt == mediaPayloadRawCustom {
			name = "RAW_CUSTOM"
		}
		ev := MediaMeshReplayEvent{Hash: tx.Hash, TS: tx.FirstSeen, Type: name, Path: parsePathJSON(best.PathJSON), Observer: best.ObserverName}
		if ev.Path == nil {
			ev.Path = []string{}
		}
		d := tx.ParsedDecoded()
		ev.Raw = trimHex(d["raw"], 12)
		ev.ChannelHash = intField(d["channelHash"])
		ev.DataType = intField(d["dataType"])
		ev.DecryptedBlob = trimHex(d["decryptedBlob"], 12)
		out.Events = append(out.Events, ev)
	}
	mediaMeshMu.RUnlock()
	s.mu.RUnlock()
	sort.Slice(out.Events, func(i, j int) bool { return out.Events[i].TS < out.Events[j].TS })
	sort.Slice(out.Announcements, func(i, j int) bool { return out.Announcements[i].TS < out.Announcements[j].TS })
	if len(out.Events) > mediaMeshReplayMax {
		out.Events = out.Events[len(out.Events)-mediaMeshReplayMax:]
		out.Truncated = true
	}
	if len(out.Events) > 0 {
		out.From = out.Events[0].TS
	}
}
