package main

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"testing"
)

// mediaMeshOwnDBFiles: the MediaMesh fork's files that write its own
// database, mediamesh-coverage.db (the coverage-points store opened in
// mediamesh_coverage_points.go), never the analyzer DB. The #1856 check
// (TestServerSourceHasNoAnalyzerWrites) skips their write SQL, as it skips
// users.db, which internal/users writes; TestMediaMeshOwnDBFilesStayOff
// keeps them off the analyzer connection.
var mediaMeshOwnDBFiles = map[string]bool{
	"mediamesh_clip_keep.go":       true,
	"mediamesh_coverage_points.go": true,
	"mediamesh_days.go":            true,
	"mediamesh_hours_keep.go":      true,
	"mediamesh_link_history.go":    true,
	"mediamesh_receipts.go":        true,
}

// Each listed file exists and never names the analyzer connection (conn,
// the *sql.DB under the server's DB, through which every analyzer query
// goes): its queries go through a *sql.DB it is handed, which callers take
// from the coverage-points store (st.db). Reading s.db.path, to put
// mediamesh-coverage.db beside the analyzer DB, is not a query.
func TestMediaMeshOwnDBFilesStayOff(t *testing.T) {
	fset := token.NewFileSet()
	for name := range mediaMeshOwnDBFiles {
		src, err := os.ReadFile(name)
		if err != nil {
			t.Errorf("%s: %v (remove it from mediaMeshOwnDBFiles if it is gone)", name, err)
			continue
		}
		f, err := parser.ParseFile(fset, name, src, 0)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		ast.Inspect(f, func(n ast.Node) bool {
			if v, ok := n.(*ast.Ident); ok && v.Name == "conn" {
				t.Errorf("%s:%d: names the analyzer connection (conn)", name, fset.Position(v.Pos()).Line)
			}
			return true
		})
	}
}
