# Grow the mesh (`#/mediamesh-grow`)

The five moves that would do the most, one after another: each is counted
against the mesh as it would be with the moves before it, so the list never
suggests covering the same streets twice, and no two moves are within 3 km.

**Candidates**

- Main-mesh repeaters already up that could turn radio2 on: heard in the
  last 3 days, not on MediaMesh, near the mesh (within 8 km of its edge),
  at least 1 km from a MediaMesh repeater; the 30 busiest. "Ask the owner"
  opens the node's page.
- High ground with no repeater yet (`candidateSpots`, as Best spots on the
  coverage card), named by the nearest place. "Try it in MediaMeshLab"
  opens the lab with a repeater there.

Each is worked out with a 10 m mast and the quick estimate (200 m cells,
20 km out) and its links repeater to repeater over the terrain.

**Goals**

- People reached (2020 Census block groups) not reached today.
- Covered twice: ground reached by one repeater today that it would reach
  too, so it stays covered if one goes down.
- Water: water nothing reaches today (ferries, water taxis).
- No single point of failure: moves that link repeaters on both sides of a
  repeater whose loss alone would split the mesh, then people.

The tiles add up all five: people, land and water, and the single points of
failure left. Logic and tests: `public/mediamesh-grow.js`,
`tests/unit/test-mediamesh-grow.js`.
