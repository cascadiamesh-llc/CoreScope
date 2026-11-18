package main

import (
	"strings"
	"testing"
)

func TestPopulationPoints(t *testing.T) {
	pts := populationPoints()
	total, seattle := 0, 0
	for _, p := range pts {
		total += p.people
		if strings.HasSuffix(p.place, ", Seattle") {
			seattle += p.people
		}
	}
	// Washington 2020: 7,705,281 people; Seattle 737,015
	if total < 7600000 || total > 7800000 {
		t.Errorf("Washington: %d people", total)
	}
	if seattle < 650000 || seattle > 800000 {
		t.Errorf("Seattle: %d people", seattle)
	}
}

func TestPopulationAndNearEndpoints(t *testing.T) {
	_, router := setupTestServer(t)
	var pop PopulationResponse
	getJSON(t, router, "/api/places/population?south=47.59&north=47.63&west=-122.34&east=-122.30", &pop)
	if len(pop.Points) == 0 || pop.Source == "" {
		t.Fatalf("population = %+v", pop)
	}
	for _, p := range pop.Points {
		lat, _ := p[0].(float64)
		if lat < 47.59 || lat > 47.63 {
			t.Errorf("outside the box: %v", p)
		}
	}
	var near NearResponse
	getJSON(t, router, "/api/places/near?at=47.6099,-122.3249&at=bad&at=91,0", &near)
	if len(near.Places) != 3 || !strings.HasSuffix(near.Places[0], "Seattle") || near.Places[1] != "" || near.Places[2] != "" {
		t.Errorf("near = %+v", near)
	}
}
