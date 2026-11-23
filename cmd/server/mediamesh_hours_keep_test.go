package main

import (
	"database/sql"
	_ "github.com/mattn/go-sqlite3"
	"path/filepath"
	"testing"
	"time"
)

func openHoursDB(t *testing.T) *sql.DB {
	db, err := sql.Open("sqlite3", "file:"+filepath.Join(t.TempDir(), "h.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

func testMMTally(total, mm int, obs string, link string) *mmTally {
	t := newMMTally()
	t.Total, t.MM = total, mm
	t.Types["GRP_DATA"] = [2]int{total, mm}
	t.Hours["2026-11-22T10"] = mm
	t.Obs[obs] = &mmObsTally{Name: obs, MM: mm, Total: total, Last: "2026-11-22T10:30:00Z"}
	t.Links[link] = &mmLinkTally{From: "aa", Obs: obs, Count: mm, SNRSum: float64(mm) * 5, SNRN: mm}
	t.Hops[2] = mm
	return t
}

func TestHoursKeptFullestAndAddedUp(t *testing.T) {
	db := openHoursDB(t)
	now := time.Date(2026, 11, 23, 9, 0, 0, 0, time.UTC)
	if err := keepMMHours(db, map[string]*mmTally{"2026-11-22T10": testMMTally(100, 10, "o1", "aa|o1"), "2026-11-22T11": testMMTally(50, 5, "o1", "aa|o1")}); err != nil {
		t.Fatal(err)
	}
	// later the hour has lost packets from memory: kept as it was
	if err := keepMMHours(db, map[string]*mmTally{"2026-11-22T10": testMMTally(20, 1, "o2", "aa|o2")}); err != nil {
		t.Fatal(err)
	}
	got, err := keptMMHours(db, TimeWindow{}, "2026-11-23T05", now)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got["2026-11-22T10"].Total != 100 || got["2026-11-22T10"].Obs["o1"] == nil {
		t.Fatalf("%+v", got)
	}
	// before cuts off the hours memory still holds
	if g, _ := keptMMHours(db, TimeWindow{}, "2026-11-22T11", now); len(g) != 1 {
		t.Fatalf("before: %d", len(g))
	}
	// a 24h window
	if g, _ := keptMMHours(db, TimeWindow{Since: "2026-11-22T11:20:00Z"}, "", now); len(g) != 1 {
		t.Fatalf("since: %d", len(g))
	}
	sum := newMMTally()
	for _, x := range got {
		sum.add(x)
	}
	if sum.Total != 150 || sum.MM != 15 || sum.Types["GRP_DATA"] != [2]int{150, 15} || sum.Obs["o1"].MM != 15 || sum.Links["aa|o1"].Count != 15 || sum.Links["aa|o1"].SNRN != 15 || sum.Hops[2] != 15 || sum.Hours["2026-11-22T10"] != 15 {
		t.Fatalf("%+v", sum)
	}
	pruneMMHours(db, 0)
	if g, _ := keptMMHours(db, TimeWindow{Since: "2000-01-01T00:00:00Z"}, "", now); len(g) != 0 {
		t.Fatalf("prune: %d", len(g))
	}
}

func TestHourHelpers(t *testing.T) {
	if mmHourOf("2026-11-22T10:59:59Z") != "2026-11-22T10" || mmHourAfter("2026-11-22T10:00:01Z") != "2026-11-22T11" || mmHourOf("") != "" {
		t.Fatal(mmHourOf("2026-11-22T10:59:59Z"), mmHourAfter("2026-11-22T10:00:01Z"))
	}
}
