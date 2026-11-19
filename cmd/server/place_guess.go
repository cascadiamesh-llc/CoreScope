package main

import (
	"math"
	"strings"
	"unicode"
)

// Where a repeater that never sent its position probably is, from a place
// named in its own name: "Rainier Vista East" sits in Rainier Vista,
// "UpperFremont" in Fremont. The neighbourhoods of places.go first, then a
// few Seattle names the City's atlas doesn't use, then towns near the rest of
// the network. Only a whole word (or run of words) counts, the longest wins,
// and a compass word in the name nudges it that way. The guess is marked as
// one wherever it is shown.

// extraPlaces: Seattle-area names people use that the neighbourhood atlas
// doesn't, at their usual centre.
var extraPlaces = []struct {
	name, city string
	lat, lon   float64
}{
	{"Rainier Vista", "Seattle", 47.5688, -122.2920},
	{"Hillman City", "Seattle", 47.5465, -122.2825},
	{"Othello", "Seattle", 47.5376, -122.2810},
	{"Lake City", "Seattle", 47.7190, -122.2950},
	{"Northgate", "Seattle", 47.7066, -122.3255},
	{"Magnolia", "Seattle", 47.6505, -122.3995},
	{"Queen Anne", "Seattle", 47.6370, -122.3570},
	{"Beacon Hill", "Seattle", 47.5670, -122.3110},
	{"West Seattle", "Seattle", 47.5710, -122.3860},
	{"Delridge", "Seattle", 47.5500, -122.3600},
	{"Uptown", "Seattle", 47.6230, -122.3560},
	{"Rainier Valley", "Seattle", 47.5500, -122.2850},
	{"Lake Union", "Seattle", 47.6390, -122.3340},
	{"Northlake", "Seattle", 47.6500, -122.3300},
	{"Upper Fremont", "Seattle", 47.6560, -122.3480},
}

// placeGuessTownKm: towns further than this from the rest of the network
// don't count (there is a Rainier, WA, 80 km south of Seattle).
const placeGuessTownKm = 60.0

// nameTokens splits a name into lower-case words: on anything not a letter
// or digit, and where a lower-case letter meets an upper-case one
// ("UpperFremont" -> upper, fremont).
func nameTokens(s string) []string {
	var out []string
	var b strings.Builder
	var prev rune
	flush := func() {
		if b.Len() > 0 {
			out = append(out, b.String())
			b.Reset()
		}
	}
	for _, r := range s {
		switch {
		case unicode.IsLetter(r) || unicode.IsDigit(r):
			if unicode.IsUpper(r) && unicode.IsLower(prev) {
				flush()
			}
			b.WriteRune(unicode.ToLower(r))
		default:
			flush()
		}
		prev = r
	}
	flush()
	return out
}

// tokensAt says whether want appears as consecutive words in have, and where.
func tokensAt(have, want []string) int {
	for i := 0; i+len(want) <= len(have); i++ {
		ok := true
		for j := range want {
			if have[i+j] != want[j] {
				ok = false
				break
			}
		}
		if ok {
			return i
		}
	}
	return -1
}

// guessGeneric: single words too common in repeater names to be a place on
// their own.
var guessGeneric = map[string]bool{"repeater": true, "rptr": true, "node": true, "mesh": true, "park": true, "hill": true, "lake": true,
	"beach": true, "point": true, "view": true, "city": true, "north": true, "south": true, "east": true, "west": true, "upper": true,
	"lower": true, "solar": true, "test": true, "base": true, "tower": true, "ridge": true, "valley": true, "heights": true, "station": true}

// guessPlace is where a repeater named name probably is: lat, lon and the
// place's label ("Fremont, Seattle"); ok false when its name names no place.
// near: the middle of the rest of the network, for towns (NaN: no towns).
func guessPlace(name string, nearLat, nearLon float64) (float64, float64, string, bool) {
	toks := nameTokens(name)
	if len(toks) == 0 {
		return 0, 0, "", false
	}
	type cand struct {
		lat, lon float64
		label    string
		words    []string
		rank     int // hoods 2, extra names 2, towns 1
	}
	var best *cand
	bestAt := -1
	consider := func(c cand) {
		if len(c.words) == 0 || (len(c.words) == 1 && (len(c.words[0]) < 5 || guessGeneric[c.words[0]])) {
			return
		}
		at := tokensAt(toks, c.words)
		if at < 0 {
			return
		}
		if best == nil || len(c.words) > len(best.words) || (len(c.words) == len(best.words) && c.rank > best.rank) {
			cc := c
			best, bestAt = &cc, at
		}
	}
	hoodBoundsOnce.Do(hoodBounds)
	for i := range hoodList {
		h := &hoodList[i]
		if len(h.rings) == 0 {
			continue
		}
		lat, lon := ringCentre(h.rings[0])
		consider(cand{lat, lon, h.name + ", " + h.city, nameTokens(h.name), 2})
	}
	for _, p := range extraPlaces {
		consider(cand{p.lat, p.lon, p.name + ", " + p.city, nameTokens(p.name), 2})
	}
	if !math.IsNaN(nearLat) && !math.IsNaN(nearLon) {
		for i := range placeList {
			p := &placeList[i]
			if math.Abs(p.lat-nearLat) > placeGuessTownKm/111 || haversineKm(nearLat, nearLon, p.lat, p.lon) > placeGuessTownKm {
				continue
			}
			consider(cand{p.lat, p.lon, p.name + ", " + p.region, nameTokens(p.name), 1})
		}
	}
	if best == nil {
		return 0, 0, "", false
	}
	// "Rainier Vista East": a little way east of its middle
	lat, lon := best.lat, best.lon
	const nudgeKm = 0.6
	kmLon := 111.32 * math.Cos(lat*math.Pi/180)
	for i, t := range toks {
		if i >= bestAt && i < bestAt+len(best.words) {
			continue
		}
		switch t {
		case "north", "upper":
			lat += nudgeKm / 111.32
		case "south", "lower":
			lat -= nudgeKm / 111.32
		case "east":
			lon += nudgeKm / kmLon
		case "west":
			lon -= nudgeKm / kmLon
		}
	}
	return lat, lon, best.label, true
}

// ringCentre is the middle of a ring of lat, lon pairs (the mean of its
// corners: plenty for a neighbourhood).
func ringCentre(r []float64) (float64, float64) {
	n := len(r) / 2
	if n == 0 {
		return 0, 0
	}
	var la, lo float64
	for i := 0; i < n; i++ {
		la += r[2*i]
		lo += r[2*i+1]
	}
	return la / float64(n), lo / float64(n)
}
