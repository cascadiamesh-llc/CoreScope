package main

import (
	"context"
	"testing"
)

// The MediaMesh marks (observation_mediamesh, observation_mainmesh) have no
// foreign key, so a merged duplicate's dropped observation must take its
// marks with it, and a moved one keep them (mediaMeshObservationDeletes).
func TestMigrateContentHashesMergeDropsMediaMeshMarks(t *testing.T) {
	store := openHashMigrateStore(t)
	surv := insertHashTx(t, store, hashMigrateRawA, ComputeContentHash(hashMigrateRawA), "2026-01-02T00:00:00Z", 500)
	dup := insertHashTx(t, store, hashMigrateRawB, "stalestalestale1", "2026-01-01T00:00:00Z", 900)
	insertHashObs(t, store, surv, 1, `["AA"]`)
	conflict := insertHashObs(t, store, dup, 1, `["AA"]`) // dropped: the survivor has it
	moved := insertHashObs(t, store, dup, 2, `[]`)
	for _, table := range []string{"observation_mediamesh", "observation_mainmesh"} {
		for _, o := range []int64{conflict, moved} {
			if _, err := store.db.Exec(`INSERT INTO `+table+` (observation_id) VALUES (?)`, o); err != nil {
				t.Fatalf("seed %s: %v", table, err)
			}
		}
	}

	if _, merged, err := store.MigrateContentHashes(context.Background(), 100); err != nil || merged != 1 {
		t.Fatalf("MigrateContentHashes: merged=%d err=%v, want 1 merged", merged, err)
	}
	for _, table := range []string{"observation_mediamesh", "observation_mainmesh"} {
		if n := countWhere(t, store, `SELECT COUNT(*) FROM `+table+` WHERE observation_id = ?`, conflict); n != 0 {
			t.Errorf("%s row of the dropped observation survived", table)
		}
		if n := countWhere(t, store, `SELECT COUNT(*) FROM `+table+` WHERE observation_id = ?`, moved); n != 1 {
			t.Errorf("%s row of a moved observation was deleted", table)
		}
	}
}

// Every statement deletes from its table by the observations of the
// transmissions selected, with the same placeholders as the rest of a batch.
func TestMediaMeshObservationDeletes(t *testing.T) {
	got := mediaMeshObservationDeletes("?")
	if len(got) != 2 {
		t.Fatalf("got %d statements, want 2", len(got))
	}
	for i, table := range []string{"observation_mediamesh", "observation_mainmesh"} {
		want := `DELETE FROM ` + table + ` WHERE observation_id IN (
		SELECT id FROM observations WHERE transmission_id IN (?))`
		if got[i] != want {
			t.Errorf("statement %d:\n%s\nwant\n%s", i, got[i], want)
		}
	}
	if len(pruneObservationMediaMeshBatches) != 2 {
		t.Errorf("prune runs %d MediaMesh deletes, want 2", len(pruneObservationMediaMeshBatches))
	}
}
