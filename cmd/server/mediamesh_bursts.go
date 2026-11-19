package main

import "sort"

// Which photo, video or voice packets are media: channel data (GRP_DATA) of
// Open TAK's media type when the analyzer can read it; channel data it
// can't read only in a burst, at least mediaBurstMin packets on its channel
// within mediaBurstGapS seconds. A clip is many pieces at once; a lone packet
// every few minutes is something else, such as MeshCore Open TAK's team
// positions. Raw clip packets (RAW_CUSTOM) are media. The ingestor makes the
// same call for its stats (cmd/ingestor mediaBursts).

const (
	mediaBurstGapS     = 60
	mediaBurstMin      = 3
	mediaChannelDataTy = 0x5643
)

// mediaUnreadableChannel is the channel of channel data the analyzer could
// not read, and whether tx is such a packet.
func mediaUnreadableChannel(tx *StoreTx) (int, bool) {
	if tx == nil || tx.PayloadType == nil || *tx.PayloadType != mediaPayloadGrpData {
		return 0, false
	}
	d := tx.ParsedDecoded()
	if intField(d["dataType"]) != nil {
		return 0, false
	}
	ch := -1
	if c := intField(d["channelHash"]); c != nil {
		ch = *c
	}
	return ch, true
}

// mediaMeshBurstsLocked is the unreadable channel data on radio2 since
// `since` (RFC 3339, "" for all) that sits in a burst. The caller holds
// s.mu and mediaMeshMu for reading.
func (s *PacketStore) mediaMeshBurstsLocked(since string) map[*StoreTx]bool {
	type item struct {
		tx *StoreTx
		ts int64
	}
	byCh := map[int][]item{}
	for _, tx := range s.packets {
		if tx == nil || tx.FirstSeen < since {
			continue
		}
		ch, ok := mediaUnreadableChannel(tx)
		if !ok || !txMediaMeshLocked(tx) {
			continue
		}
		byCh[ch] = append(byCh[ch], item{tx, parseTimestamp(tx.FirstSeen).Unix()})
	}
	out := map[*StoreTx]bool{}
	for _, xs := range byCh {
		sort.Slice(xs, func(i, j int) bool { return xs[i].ts < xs[j].ts })
		r := 0
		for l := range xs {
			if r < l {
				r = l
			}
			for r+1 < len(xs) && xs[r+1].ts-xs[l].ts <= mediaBurstGapS {
				r++
			}
			if r-l+1 >= mediaBurstMin {
				for k := l; k <= r; k++ {
					out[xs[k].tx] = true
				}
			}
		}
	}
	return out
}

// mediaMeshIsMedia says whether a photo, video or voice packet type carries
// media (see the top of this file). bursts: mediaMeshBurstsLocked.
func mediaMeshIsMedia(tx *StoreTx, bursts map[*StoreTx]bool) bool {
	if tx == nil || tx.PayloadType == nil {
		return false
	}
	switch *tx.PayloadType {
	case mediaPayloadRawCustom:
		return true
	case mediaPayloadGrpData:
		if _, unreadable := mediaUnreadableChannel(tx); unreadable {
			return bursts[tx]
		}
		dt := intField(tx.ParsedDecoded()["dataType"])
		return dt != nil && *dt == mediaChannelDataTy
	}
	return false
}
