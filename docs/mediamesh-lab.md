# MediaMeshLab (`#/mediamesh-lab`)

Change the mesh and see what happens. Nothing done here touches the real
mesh.

- **Add a repeater** (first): add as many as you like. Place one on the
  map, or find repeaters already up by name: the search covers every
  repeater the analyzer knows that isn't on MediaMesh yet, and each one
  picked joins at its own position, under its name, to show what bringing
  it onto MediaMesh would do. Repeaters that haven't sent a position are
  listed but can't be picked. Each added repeater has its own antenna
  height (its owner's where the analyzer has it, `KNOWN_HEIGHTS`; 10 m
  otherwise) and an X to remove it. Their links are worked out repeater to repeater over the
  terrain (`planLinks`), to the MediaMesh repeaters at their own heights
  and to each other, and each one's coverage for people on the ground is
  drawn in green; the land they add is counted once however many of them
  reach it (`plansGainKm2`). `#/mediamesh-lab?add={public key}` opens with
  that repeater added, `?lat=…&lon=…` with one placed there.
- **On MediaMesh**: each MediaMesh repeater with its height (the owner's
  where known, else 10 m) to change, and the X by its name to take it down.
  Those taken down move above the list, crossed out, with Bring back.
- **Antenna and power**, for any repeater, added or on MediaMesh: its
  button (or a click on it on the map) opens them under it, and again
  closes them; one is open at a time, all closed to start. The antenna's
  type (omni, collinear, yagi, panel, sector: picking one sets its typical
  gain), its gain, which way one that points is pointed (degrees from
  north), the cable and connector loss, and the power (10 dBm to 37 dBm, 5 W), with
  what goes into the air (EIRP). A MediaMesh repeater starts at the model's
  guess (22 dBm, 2 dBi, 1 dB, the analyzer can't read the real ones), shows
  **Changed** once changed, and has **Back to the model's guess**.
  Power, gain and cable move the repeater's coverage by as many dB; a
  pointed antenna loses off its beam (-3 dB at the beam's edges, down to
  -20 dB behind: `patternDb`). A new height works its coverage out again
  over the terrain. An added repeater's links count both ends' antennas and
  power (`planLinks`); the links the model predicts between MediaMesh
  repeaters stay as worked out at the start.
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
