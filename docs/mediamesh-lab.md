# MediaMeshLab (`#/mediamesh-lab`)

Change the mesh and see what happens. Nothing done here touches the real
mesh.

- **Take down** any MediaMesh repeater.
- **Add a repeater**: place it on the map at an antenna height; its links
  are worked out repeater to repeater over the terrain (`planLinks`), and
  its coverage for people on the ground, drawn in green.
- **Links**: the links heard this week always count; those only the model
  predicts can be counted or left out.

What it shows, as it is → as changed:

- whether the mesh is in one piece;
- how many routes between linked repeaters still connect, and the typical
  route's hops;
- the land and water still reached (the people-on-the-ground estimate,
  shared with the MediaMesh tab), plus what the added repeater reaches
  that nothing else does;
- how many repeaters' loss alone would split it.

**Replay:** the last 30 days' clips whose path the analyzer can name. Each
either arrives as it went, arrives another way (the shortest way round, from
the repeater it went in by to the one it was heard from last), or is lost
because one of those two is down or there is no way round. A hop the
analyzer can't name (a path hash matching no repeater, or more than one)
is shown as "can't tell".

Logic and tests: `public/mediamesh-lab.js`, `tests/unit/test-mediamesh-lab.js`.
