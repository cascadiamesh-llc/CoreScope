# MediaMesh coverage: the mesh view

The coverage map on the MediaMesh tab has a **The mesh** view next to
**People on the ground** and **Repeater to repeater**. It takes the
people-on-the-ground estimate (terrain, each antenna at its height, the
field correction) and colours each place by which repeaters reach it and how
sure we are those repeaters are linked to each other.

## Which repeaters are in the mesh

Links come from two places in `/api/analytics/mediamesh`:

- `backbone`: hops photos, video and voice took this week (`packets`);
- `links`: nodes an observer heard straight off the air on radio2 (`count`).

Packets on the same pair of repeaters are added up. A pair heard **5 or
more times** is a solid link; the biggest group joined by solid links is the
mesh. Weaker evidence can join more repeaters to it, each switchable:

- a pair heard **1 to 4 times**;
- a pair never heard that **the model says reach each other**: the
  repeater-to-repeater path over the terrain, each end at its antenna height,
  with something to spare (`predictedLinks`).

Repeaters joined only by weaker evidence are drawn and listed in violet.
Repeaters with no link heard or predicted are grey.

## What's drawn and counted

Each cell is one of: reached by two or more repeaters in the mesh (stays
covered if one goes down), by one, only by repeaters with weaker evidence,
or only by repeaters outside the mesh. Water is drawn and counted here:
water taxis and ferries are on it.

"Best placed in the mesh" lists every repeater with the land and water it
reaches, what only it reaches among repeaters in the mesh (what the mesh would
lose without it), and how many repeaters it has been heard linking with. In a
mesh, overlap is how repeaters link up, so the leaderboard's Best placed
ranks repeaters in the mesh by the land and water they reach, with their links.

## Antenna heights

Every repeater is taken as 10 m above the ground unless its owner has given
the height (`KNOWN_HEIGHTS` in `public/mediamesh-coverage.js`, in feet above
the street, by the start of the public key). The heights are used for the
coverage, the predicted links, and the check of the model against links heard.
