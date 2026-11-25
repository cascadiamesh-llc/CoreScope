package main

// Clips on private channels. Their pieces are channel data the analyzer
// can't read: no session id, no kind, no piece numbers. What's left is that
// they come in a burst (mediaMeshBurstsLocked), on which channel (its
// one-byte hash) and who heard them over how many hops. So each burst is
// counted as one clip: when, how many pieces, how far. Never what kind or
// for whom.

import (
	"fmt"
	"sort"
	"time"
)

// privateClipGap: pieces on one channel this far apart or more are two
// clips. Longer than a burst's own 60 s, so a clip's repair round after a
// pause still counts with it.
const privateClipGap = 2 * time.Minute

// privatePiece is one unreadable burst packet heard on MediaMesh.
type privatePiece struct {
	channel int
	at      time.Time
	obs     []privateObs
}

type privateObs struct {
	observer, name string
	path           []string
}

// privateChannelClips groups the pieces by channel into clips, newest first.
// SID is "p" + the channel hash + the clip's first second (hex), so the same
// burst keeps its key each time it's worked out.
func privateChannelClips(ps []privatePiece) []MediaMeshClip {
	byCh := map[int][]privatePiece{}
	for _, p := range ps {
		byCh[p.channel] = append(byCh[p.channel], p)
	}
	out := []MediaMeshClip{}
	for ch, xs := range byCh {
		sort.Slice(xs, func(i, j int) bool { return xs[i].at.Before(xs[j].at) })
		for s := 0; s < len(xs); {
			e := s + 1
			for e < len(xs) && xs[e].at.Sub(xs[e-1].at) < privateClipGap {
				e++
			}
			if e-s >= mediaBurstMin {
				out = append(out, privateChannelClip(ch, xs[s:e]))
			}
			s = e
		}
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].At > out[j].At || (out[i].At == out[j].At && out[i].SID < out[j].SID)
	})
	return out
}

func privateChannelClip(ch int, xs []privatePiece) MediaMeshClip {
	first, last := xs[0].at, xs[len(xs)-1].at
	chHex := "xx"
	if ch >= 0 {
		chHex = fmt.Sprintf("%02x", ch&0xff)
	}
	c := MediaMeshClip{SID: fmt.Sprintf("p%s%x", chHex, first.Unix()), Kind: "unknown", Outcome: "private", Channel: chHex,
		At: first.UTC().Format(time.RFC3339), FirstAt: first.UTC().Format(time.RFC3339), LastAt: last.UTC().Format(time.RFC3339),
		DurationS: last.Sub(first).Seconds(), Heard: len(xs), Path: []string{}}
	seen := map[string]bool{}
	far := -1
	for _, p := range xs {
		for _, o := range p.obs {
			k := o.observer
			if k == "" {
				k = o.name
			}
			seen[k] = true
			if len(o.path) > far || (len(o.path) == far && k < c.Observer) {
				far = len(o.path)
				c.Observer, c.ObsName, c.Hops = k, o.name, len(o.path)
				c.Path = o.path
			}
		}
	}
	if c.Path == nil {
		c.Path = []string{}
	}
	c.Observers = len(seen)
	return c
}

// samePrivateClip: two accounts of one burst (the same channel, overlapping
// in time). A burst worked out again once its first pieces have left memory
// starts later, so it gets another key; this finds it.
func samePrivateClip(a, b MediaMeshClip) bool {
	if a.Channel != b.Channel {
		return false
	}
	a0, a1 := parseTimestamp(a.FirstAt), parseTimestamp(a.LastAt)
	b0, b1 := parseTimestamp(b.FirstAt), parseTimestamp(b.LastAt)
	return !a0.After(b1.Add(privateClipGap)) && !b0.After(a1.Add(privateClipGap))
}

// dedupePrivateClips keeps the best account of each burst (most pieces),
// newest first.
func dedupePrivateClips(cs []MediaMeshClip) []MediaMeshClip {
	sorted := append([]MediaMeshClip(nil), cs...)
	sort.SliceStable(sorted, func(i, j int) bool { return clipBetter(sorted[i], sorted[j]) })
	out := []MediaMeshClip{}
	for _, c := range sorted {
		dup := false
		for _, o := range out {
			if samePrivateClip(c, o) {
				dup = true
				break
			}
		}
		if !dup {
			out = append(out, c)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		return clipAt(out[i]) > clipAt(out[j]) || (clipAt(out[i]) == clipAt(out[j]) && out[i].SID < out[j].SID)
	})
	if len(out) > mediaClipsMax {
		out = out[:mediaClipsMax]
	}
	return out
}
