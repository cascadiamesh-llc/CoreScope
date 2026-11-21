package main

import (
	"bytes"
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"
)

func TestCheckReceiptsBatch(t *testing.T) {
	now := time.Unix(1795300000, 0)
	b := mediaReceiptsBatch{Radio: "AB" + string(bytes.Repeat([]byte("cd"), 31)), Receipts: []mediaReceipt{
		{SID: "1A2B3C4D", Kind: "photo", At: now.Unix() - 60, Total: 17, Got: 15, Asked: 2, Whole: true},
		{SID: "1a2b3c4d", Kind: "hologram", At: now.Unix() - 60, Total: 3, Got: 3, Whole: true}, // kind unknown
		{SID: "xyz", At: now.Unix()},                        // not a session id
		{SID: "00000001", At: now.Unix() - 400*86400},       // too old
		{SID: "00000002", At: now.Unix(), Total: 4, Got: 9}, // more pieces than it has
	}}
	if err := checkReceiptsBatch(&b, now, 0); err != nil {
		t.Fatal(err)
	}
	if len(b.Receipts) != 2 || b.Receipts[0].SID != "1a2b3c4d" || b.Receipts[1].Kind != "unknown" || b.Radio[:2] != "ab" {
		t.Fatalf("%+v", b)
	}
	bad := mediaReceiptsBatch{Radio: "zz", Receipts: b.Receipts}
	if checkReceiptsBatch(&bad, now, 0) == nil {
		t.Fatal("a radio that isn't a key")
	}
}

func TestAttachDeliveries(t *testing.T) {
	at := time.Date(2026, 11, 21, 10, 0, 0, 0, time.UTC)
	clips := []MediaMeshClip{
		{SID: "aaaa0001", At: at.Format(time.RFC3339)},
		{SID: "aaaa0002", At: at.Format(time.RFC3339)},
		{SID: "aaaa0003", At: at.Format(time.RFC3339)},
	}
	r := func(radio, sid string, after time.Duration, whole bool, asked, rebuilt int) storedReceipt {
		return storedReceipt{radio: radio, mediaReceipt: mediaReceipt{SID: sid, At: at.Add(after).Unix(), Whole: whole, Asked: asked, Rebuilt: rebuilt}}
	}
	attachDeliveries(clips, []storedReceipt{
		r("r1", "aaaa0001", time.Minute, true, 2, 0),
		r("r2", "aaaa0001", 2*time.Minute, true, 0, 1),
		r("r3", "aaaa0001", 3*time.Minute, false, 0, 0),
		r("r1", "aaaa0001", -time.Minute, false, 0, 0),  // an older receipt from r1: its latest counts
		r("r1", "aaaa0002", 2*24*time.Hour, true, 0, 0), // the same id days later: another clip
	})
	d := clips[0].Delivery
	if d == nil || *d != (MediaMeshDelivery{Recipients: 3, Whole: 2, Asked: 1, Rebuilt: 1}) {
		t.Fatalf("%+v", d)
	}
	if clips[1].Delivery != nil || clips[2].Delivery != nil {
		t.Fatal("receipts for other clips")
	}
}

func TestReceiptsUploadStoreAndRemove(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(nil)
	radio := hex.EncodeToString(pub)
	f := false
	srv := &Server{cfg: &Config{MediaMeshCoverage: &MediaMeshCoverageConfig{DBPath: filepath.Join(t.TempDir(), "cov.db"), RequireKnownRadio: &f}}}
	defer srv.closeCoveragePoints()
	send := func(method string, body []byte, prefix string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, "/api/mediamesh/receipts", bytes.NewReader(body))
		req.Header.Set("X-MeshCore-Signature", hex.EncodeToString(ed25519.Sign(priv, covSignedMessage(prefix, body))))
		w := httptest.NewRecorder()
		if method == http.MethodPost {
			srv.handleReceiptsPost(w, req)
		} else {
			srv.handleReceiptsDelete(w, req)
		}
		return w
	}
	now := time.Now()
	body, _ := json.Marshal(mediaReceiptsBatch{V: 1, Radio: radio, Sent: now.Unix(), App: "MeshCore Open TAK", Receipts: []mediaReceipt{
		{SID: "aaaa0001", Kind: "photo", At: now.Unix() - 100, Total: 17, Got: 16, Asked: 1, Whole: true},
		{SID: "aaaa0002", Kind: "voice", At: now.Unix() - 50, Total: 6, Got: 6, Whole: true},
	}})
	if w := send(http.MethodPost, body, covPointsSignPrefix); w.Code != http.StatusUnauthorized {
		t.Fatalf("signed as coverage points: %d", w.Code)
	}
	if w := send(http.MethodPost, body, receiptsSignPrefix); w.Code != 200 || !bytes.Contains(w.Body.Bytes(), []byte(`"accepted":2`)) {
		t.Fatalf("upload: %d %s", w.Code, w.Body.String())
	}
	st, _ := srv.coveragePoints()
	rs, err := st.receiptsSince(now.Add(-time.Hour))
	if err != nil || len(rs) != 2 || rs[0].radio != radio {
		t.Fatalf("%v %+v", err, rs)
	}
	out := &MediaMeshClips{From: now.Add(-time.Hour).UTC().Format(time.RFC3339), Clips: []MediaMeshClip{{SID: "aaaa0001", At: now.Add(-3 * time.Minute).UTC().Format(time.RFC3339)}}}
	srv.addDeliveries(out)
	if d := out.Clips[0].Delivery; d == nil || d.Recipients != 1 || d.Whole != 1 || d.Asked != 1 {
		t.Fatalf("delivery %+v", d)
	}
	del, _ := json.Marshal(covDeleteRequest{Radio: radio, Sent: now.Unix()})
	if w := send(http.MethodDelete, del, receiptsDeletePref); w.Code != 200 || !bytes.Contains(w.Body.Bytes(), []byte(`"removed":2`)) {
		t.Fatalf("delete: %d %s", w.Code, w.Body.String())
	}
}
