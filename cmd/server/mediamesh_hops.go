package main

// Naming a hop in a MediaMesh path. A path holds only the first byte or
// two of each repeater's key, and many repeaters on the main mesh share
// those (FUCK ICE, Delridge, West Linn…). A piece heard on radio2 only
// went through repeaters that run MediaMesh, so a hop is named from those
// alone; one that matches none of them stays its hash.

import (
	"sort"
	"strings"
	"time"
)

// mediaMeshHopNamer: for a hop hash, the MediaMesh repeater it is (the one
// with a position when several share the hash, then ambiguous), or ok false.
type mediaMeshHopNamer func(hop string) (n nodeInfo, ambiguous, ok bool)

func (s *PacketStore) mediaMeshHopNamer(now time.Time) mediaMeshHopNamer {
	return mediaMeshHopNamerOf(s.mediaMeshNodeInfo(), now)
}

func mediaMeshHopNamerOf(names map[string]nodeInfo, now time.Time) mediaMeshHopNamer {
	var reps []nodeInfo
	if p := mediaMeshNodes.Load(); p != nil {
		for pk := range *p {
			if nodeMediaMeshAt(pk, now) == nil {
				continue
			}
			n, ok := names[pk]
			if !ok {
				n = nodeInfo{PublicKey: pk}
			}
			n.PublicKey = strings.ToLower(pk)
			n.HasGPS = n.HasGPS || !(n.Lat == 0 && n.Lon == 0)
			reps = append(reps, n)
		}
	}
	sort.Slice(reps, func(i, j int) bool { return reps[i].PublicKey < reps[j].PublicKey })
	return func(hop string) (nodeInfo, bool, bool) {
		h := strings.ToLower(strings.TrimSpace(hop))
		if h == "" {
			return nodeInfo{}, false, false
		}
		var hits []nodeInfo
		for _, r := range reps {
			if strings.HasPrefix(r.PublicKey, h) {
				hits = append(hits, r)
			}
		}
		if len(hits) == 0 {
			return nodeInfo{}, false, false
		}
		for _, r := range hits {
			if r.HasGPS {
				return r, len(hits) > 1, true
			}
		}
		return hits[0], len(hits) > 1, true
	}
}
