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

**Wind tunnel:** the same announced clips sent again 200 times each, through
the mesh as changed and with a radio2 preset (250 kHz SF7 now, SF8, 125 kHz,
62.5 kHz), a repair setting (Fast MediaMesh with a tenth, nothing or a
quarter up front, or plain resends) and a number of asks for what's
missing. Tiles compare now with changed: share arriving whole, typical time
to whole, radio2 airtime for the clips, and clips with no way through.

A rough model, best for comparing:

- a piece crosses a hop with one chance, the upper quartile over the clips
  of (pieces heard / pieces)^(1/hops) at their far-end observer;
- a preset's extra margin (about 2.5 dB a spreading factor, 3 dB a halving
  of bandwidth) moves that chance along a logistic curve (0.3 per dB);
- repair pieces each make up for any one lost piece; plain resends ask for
  the missing pieces themselves; an ask costs a second a hop;
- airtime is LoRa time on air (explicit header, CRC, 4/5) per piece, once
  for the sender and once per repeater on the way;
- both sides use the same seeded dice, so a difference is the change's.

Logic and tests: `public/mediamesh-lab.js`, `public/mediamesh-windtunnel.js`,
`tests/unit/test-mediamesh-lab.js`, `tests/unit/test-mediamesh-windtunnel.js`.
