package main

// MediaMesh delivery receipts: whether a clip arrived, from the app that
// received it. Observers hear only the pieces that pass near them, so what
// they heard says little about delivery; the receiving app knows. With
// "Share delivery receipts" on, MeshCore Open TAK sends, for each photo,
// video and voice clip it received, the clip's session id (on the air in
// every piece already), its piece counts and whether it ended up whole.
// Never its content, who sent it, the channel or where the phone was.
//
// POST /api/mediamesh/receipts, signed by the receiving radio like coverage
// points (X-MeshCore-Signature over "corescope-receipt:" + the hex SHA-256 of
// the body), only from radios this analyzer has heard; DELETE removes a
// radio's receipts. They're kept in the coverage points file, as long as the
// points. The clips endpoint gives each clip its receipts as `delivery`.
// See docs/mediamesh-receipts.md.

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"sort"
	"strings"
	"time"
)

const (
	receiptsSignPrefix  = "corescope-receipt:"
	receiptsDeletePref  = "corescope-receipt-delete:"
	receiptsMaxPerBatch = 500
	receiptsMaxBody     = 128 << 10
	// a receipt belongs to a clip heard from 10 minutes before it to 12 hours
	// after (a session id can come round again)
	receiptBefore = 10 * time.Minute
	receiptAfter  = 12 * time.Hour
)

var errReceiptBatch = errors.New("bad receipts")

// mediaReceipt is what the receiving app says about one clip.
type mediaReceipt struct {
	SID     string `json:"sid"`  // 8 hex: the clip's session id
	Kind    string `json:"kind"` // photo | video | voice | unknown
	At      int64  `json:"at"`   // unix seconds: when it finished (whole or given up on)
	Total   int    `json:"total"`
	Got     int    `json:"got"`     // pieces received over the air
	Asked   int    `json:"asked"`   // pieces asked for again
	Rebuilt int    `json:"rebuilt"` // pieces rebuilt from parity
	Whole   bool   `json:"whole"`
}

type mediaReceiptsBatch struct {
	V        int            `json:"v"`
	Radio    string         `json:"radio"`
	Sent     int64          `json:"sent"`
	App      string         `json:"app,omitempty"`
	Receipts []mediaReceipt `json:"receipts"`
}

// checkReceiptsBatch normalizes b and leaves out receipts that don't make
// sense; an error when none are left.
func checkReceiptsBatch(b *mediaReceiptsBatch, now time.Time, keepDays int) error {
	k := strings.ToLower(strings.TrimSpace(b.Radio))
	if len(k) != 64 || !isHex(k) {
		return fmt.Errorf("%w: radio must be the radio's 64-hex-digit public key", errReceiptBatch)
	}
	b.Radio = k
	if len(b.Receipts) == 0 {
		return fmt.Errorf("%w: no receipts", errReceiptBatch)
	}
	if len(b.Receipts) > receiptsMaxPerBatch {
		return fmt.Errorf("%w: at most %d receipts a batch", errReceiptBatch, receiptsMaxPerBatch)
	}
	if b.App = strings.TrimSpace(b.App); len(b.App) > 64 {
		b.App = b.App[:64]
	}
	if keepDays <= 0 {
		keepDays = covPointsDefaultDays
	}
	oldest := now.Add(-time.Duration(keepDays) * 24 * time.Hour).Unix()
	newest := now.Add(24 * time.Hour).Unix()
	kept := b.Receipts[:0]
	for _, r := range b.Receipts {
		r.SID = strings.ToLower(strings.TrimSpace(r.SID))
		switch r.Kind {
		case "photo", "video", "voice":
		default:
			r.Kind = "unknown"
		}
		if len(r.SID) != 8 || !isHex(r.SID) || r.At < oldest || r.At > newest ||
			r.Total < 0 || r.Total > 4096 || r.Got < 0 || r.Asked < 0 || r.Rebuilt < 0 ||
			(r.Total > 0 && (r.Got > r.Total || r.Rebuilt > r.Total || r.Asked > r.Total)) {
			continue
		}
		kept = append(kept, r)
	}
	if len(kept) == 0 {
		return fmt.Errorf("%w: no usable receipts (8-hex session ids, times within the last %d days)", errReceiptBatch, keepDays)
	}
	b.Receipts = kept
	return nil
}

// addReceipts stores a checked batch: how many receipts were new (one per
// radio, clip and time; a repeat replaces it).
func (st *covPointsStore) addReceipts(b *mediaReceiptsBatch) (int, error) {
	tx, err := st.db.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	recv := st.now().Unix()
	n := 0
	for _, r := range b.Receipts {
		res, err := tx.Exec(`INSERT INTO receipts (radio, sid, at, kind, total, got, asked, rebuilt, whole, app, received)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (radio, sid, at) DO UPDATE SET kind = excluded.kind, total = excluded.total, got = excluded.got,
			asked = excluded.asked, rebuilt = excluded.rebuilt, whole = excluded.whole, app = excluded.app`,
			b.Radio, r.SID, r.At, r.Kind, r.Total, r.Got, r.Asked, r.Rebuilt, boolInt(r.Whole), b.App, recv)
		if err != nil {
			return 0, err
		}
		if k, _ := res.RowsAffected(); k > 0 {
			n++
		}
	}
	return n, tx.Commit()
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

func (st *covPointsStore) removeReceipts(radio string) (int64, error) {
	res, err := st.db.Exec(`DELETE FROM receipts WHERE radio = ?`, radio)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// storedReceipt is a receipt as kept: by which radio, and its clip.
type storedReceipt struct {
	radio string
	mediaReceipt
}

// receiptsSince: every receipt finished at or after since.
func (st *covPointsStore) receiptsSince(since time.Time) ([]storedReceipt, error) {
	rows, err := st.db.Query(`SELECT radio, sid, at, kind, total, got, asked, rebuilt, whole FROM receipts WHERE at >= ?`, since.Add(-receiptBefore).Unix())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []storedReceipt
	for rows.Next() {
		var r storedReceipt
		var whole int
		if err := rows.Scan(&r.radio, &r.SID, &r.At, &r.Kind, &r.Total, &r.Got, &r.Asked, &r.Rebuilt, &whole); err != nil {
			return nil, err
		}
		r.Whole = whole != 0
		out = append(out, r)
	}
	return out, rows.Err()
}

// MediaMeshDelivery is a clip's receipts: how many receiving apps reported
// it, how many had it whole, and of those how many after asking again for
// missing pieces or thanks to parity.
type MediaMeshDelivery struct {
	Recipients int `json:"recipients"`
	Whole      int `json:"whole"`
	Asked      int `json:"asked"`
	Rebuilt    int `json:"rebuilt"`
	// What the receiving apps say the clip is: its pieces (the largest
	// total any reported) and kind, when one said. For a clip sent
	// privately the analyzer knows neither otherwise.
	Total int    `json:"total,omitempty"`
	Kind  string `json:"kind,omitempty"`
	// For each receiving app that had it whole: how many seconds after the
	// clip was announced (or first heard) it finished, from its receipt.
	WholeAfterS []int `json:"wholeAfterS,omitempty"`
}

// attachDeliveries gives each clip its receipts (by session id, received
// between receiptBefore before the clip and receiptAfter after it; one per
// receiving radio, its latest).
func attachDeliveries(clips []MediaMeshClip, receipts []storedReceipt) {
	bySid := map[string][]storedReceipt{}
	for _, r := range receipts {
		bySid[r.SID] = append(bySid[r.SID], r)
	}
	for i := range clips {
		c := &clips[i]
		rs := bySid[c.SID]
		if len(rs) == 0 {
			continue
		}
		at := parseTimestamp(c.At)
		latest := map[string]storedReceipt{}
		for _, r := range rs {
			t := time.Unix(r.At, 0)
			if !at.IsZero() && (t.Before(at.Add(-receiptBefore)) || t.After(at.Add(receiptAfter))) {
				continue
			}
			if old, ok := latest[r.radio]; !ok || r.At > old.At {
				latest[r.radio] = r
			}
		}
		if len(latest) == 0 {
			continue
		}
		d := &MediaMeshDelivery{}
		for _, r := range latest {
			d.Recipients++
			d.Total = max(d.Total, r.Total)
			if r.Kind != "" && r.Kind != "unknown" {
				d.Kind = r.Kind
			}
			if r.Whole {
				d.Whole++
				if !at.IsZero() && r.At >= at.Unix() {
					d.WholeAfterS = append(d.WholeAfterS, int(r.At-at.Unix()))
				}
				if r.Asked > 0 {
					d.Asked++
				} else if r.Rebuilt > 0 {
					d.Rebuilt++
				}
			}
		}
		sort.Ints(d.WholeAfterS)
		c.Delivery = d
	}
}

// addDeliveries fills in the clips' receipts, if this analyzer keeps any.
func (s *Server) addDeliveries(out *MediaMeshClips) {
	c := s.cfg.mediaMeshCoverage()
	if c.Enabled != nil && !*c.Enabled {
		return
	}
	st, _ := s.coveragePoints()
	if st == nil {
		return
	}
	since := parseTimestamp(out.From)
	if since.IsZero() {
		return
	}
	rs, err := st.receiptsSince(since)
	if err != nil {
		log.Printf("[mediamesh] receipts: %v", err)
		return
	}
	attachDeliveries(out.Clips, rs)
	attachDeliveries(out.Unannounced, rs)
	for i := range out.Unannounced {
		judgeByReceipt(&out.Unannounced[i])
	}
}

// judgeByReceipt gives a clip sent privately what its receipts say it is:
// its kind, and its total, so what the far end heard can be judged like an
// announced clip's (Missing: the data pieces it didn't hear). Piece numbers
// are one byte on the air, so a clip of more than 256 pieces gets its total
// but no Missing.
func judgeByReceipt(c *MediaMeshClip) {
	d := c.Delivery
	if d == nil || d.Total <= 0 || len(c.HeardIdx) == 0 {
		return
	}
	if d.Kind != "" && (c.Kind == "" || c.Kind == "unknown") {
		c.Kind = d.Kind
	}
	c.Total, c.TotalFrom = d.Total, "receipt"
	c.Missing = nil
	if d.Total > 256 {
		return
	}
	heard := map[int]bool{}
	for _, i := range c.HeardIdx {
		heard[i] = true
	}
	for i := 0; i < d.Total; i++ {
		if !heard[i] {
			c.Missing = append(c.Missing, i)
		}
	}
}

func (s *Server) handleReceiptsPost(w http.ResponseWriter, r *http.Request) {
	st, err := s.coveragePoints()
	if st == nil {
		writeError(w, http.StatusServiceUnavailable, err.Error())
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, receiptsMaxBody))
	if err != nil {
		writeError(w, http.StatusRequestEntityTooLarge, "request body too large")
		return
	}
	var b mediaReceiptsBatch
	if err := json.Unmarshal(body, &b); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	c := s.cfg.mediaMeshCoverage()
	if err := checkReceiptsBatch(&b, time.Now(), c.RetentionDays); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if !verifyCovSignature(b.Radio, r.Header.Get("X-MeshCore-Signature"), covSignedMessage(receiptsSignPrefix, body)) {
		writeError(w, http.StatusUnauthorized, "the signature doesn't match this radio's key")
		return
	}
	if (c.RequireKnownRadio == nil || *c.RequireKnownRadio) && !s.radioKnown(b.Radio) {
		writeError(w, http.StatusForbidden, "this analyzer hasn't heard this radio yet: send an advert, then try again")
		return
	}
	if ok, wait := s.covPoints.limiter.take("r:" + b.Radio); !ok {
		w.Header().Set("Retry-After", fmt.Sprint(int(wait.Seconds())+1))
		writeError(w, http.StatusTooManyRequests, "too many uploads from this radio, try again later")
		return
	}
	n, err := st.addReceipts(&b)
	if err != nil {
		log.Printf("[mediamesh] receipts from %s: %v", b.Radio[:8], err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	writeJSON(w, map[string]int{"accepted": n, "duplicates": len(b.Receipts) - n})
}

func (s *Server) handleReceiptsDelete(w http.ResponseWriter, r *http.Request) {
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
	if !verifyCovSignature(radio, r.Header.Get("X-MeshCore-Signature"), covSignedMessage(receiptsDeletePref, body)) {
		writeError(w, http.StatusUnauthorized, "the signature doesn't match this radio's key")
		return
	}
	n, err := st.removeReceipts(radio)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	writeJSON(w, map[string]int64{"removed": n})
}
