package main

import (
	_ "embed"
	"math"
	"net/http"
	"strconv"
	"strings"
	"sync"
)

// Where people live, for coverage counted in people rather than km²: the
// 2020 Census centres of population by block group for Washington (a block
// group is 600 to 3,000 people), each with the place nearPlace gives it
// ("Capitol Hill, Seattle", "Bellevue, WA"). Built in; nothing is looked up
// online. Also names arbitrary points, for the coverage card's address
// check and suggested repeater spots.

//go:embed population_wa_2020.csv
var populationCSV string

// PopulationPoint is one block group: [lat, lon, people, place].
type PopulationPoint [4]interface{}

type popPoint struct {
	lat, lon float64
	people   int
	place    string
}

var (
	popOnce   sync.Once
	popPoints []popPoint
)

func populationPoints() []popPoint {
	popOnce.Do(func() {
		for _, line := range strings.Split(populationCSV, "\n") {
			line = strings.TrimSpace(line)
			if line == "" || strings.HasPrefix(line, "#") {
				continue
			}
			f := strings.Split(line, ",")
			if len(f) != 4 {
				continue
			}
			n, err1 := strconv.Atoi(f[1])
			lat, err2 := strconv.ParseFloat(f[2], 64)
			lon, err3 := strconv.ParseFloat(f[3], 64)
			if err1 != nil || err2 != nil || err3 != nil || n <= 0 {
				continue
			}
			popPoints = append(popPoints, popPoint{lat: lat, lon: lon, people: n, place: nearPlace(lat, lon)})
		}
	})
	return popPoints
}

// PopulationResponse is /api/places/population.
type PopulationResponse struct {
	Source string            `json:"source"`
	Points []PopulationPoint `json:"points"`
}

func boxParam(r *http.Request, key string, def float64) float64 {
	if v, err := strconv.ParseFloat(r.URL.Query().Get(key), 64); err == nil && !math.IsNaN(v) && !math.IsInf(v, 0) {
		return v
	}
	return def
}

// handlePopulation lists the block groups inside south/west/north/east
// (all of Washington when left out).
func (s *Server) handlePopulation(w http.ResponseWriter, r *http.Request) {
	south, north := boxParam(r, "south", -90), boxParam(r, "north", 90)
	west, east := boxParam(r, "west", -180), boxParam(r, "east", 180)
	out := PopulationResponse{Source: "US Census Bureau, 2020 Census centers of population by block group (Washington)", Points: []PopulationPoint{}}
	for _, p := range populationPoints() {
		if p.lat < south || p.lat > north || p.lon < west || p.lon > east {
			continue
		}
		out.Points = append(out.Points, PopulationPoint{math.Round(p.lat*1e5) / 1e5, math.Round(p.lon*1e5) / 1e5, p.people, p.place})
	}
	writeJSON(w, out)
}

// NearResponse is /api/places/near: a name per ?at=lat,lon, "" for none.
type NearResponse struct {
	Places []string `json:"places"`
}

const nearMaxPoints = 20

func (s *Server) handleNear(w http.ResponseWriter, r *http.Request) {
	out := NearResponse{Places: []string{}}
	for i, at := range r.URL.Query()["at"] {
		if i >= nearMaxPoints {
			break
		}
		name := ""
		if p := strings.Split(at, ","); len(p) == 2 {
			lat, err1 := strconv.ParseFloat(strings.TrimSpace(p[0]), 64)
			lon, err2 := strconv.ParseFloat(strings.TrimSpace(p[1]), 64)
			if err1 == nil && err2 == nil && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180 {
				name = nearPlace(lat, lon)
			}
		}
		out.Places = append(out.Places, name)
	}
	writeJSON(w, out)
}
