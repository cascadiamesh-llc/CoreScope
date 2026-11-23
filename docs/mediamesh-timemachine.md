# Time machine

`#/mediamesh-timemachine` shows MediaMesh on any day since it began, two
days (A and B) side by side, with maps that move together. Linked from the
MediaMesh tab's intro. `?a=YYYY-MM-DD&b=YYYY-MM-DD` opens two days; the
address follows the sliders, so a comparison can be shared.

For each day: the MediaMesh repeaters (new since A in green and gone since
A in red, on B's map), the week's backbone links, the land and water
reached (the people-on-the-ground estimate, worked out once from where the
repeaters stand now and masked to those there that day) and the day's photo
and voice packets. A line above shows repeaters a day. Play steps B forward
from A to today.

## Where the days come from

The server keeps a row a day in `mm_days`, in the coverage-points
database (`cmd/server/mediamesh_days.go`): the placed repeaters (not those
placed from their name, not hidden or blacklisted nodes), the radio2 links
and backbone, and the day's MediaMesh transmissions and photo and voice
packets, from the last 24 hours' analytics. It is written over at most
every 30 minutes when the page asks and every 6 hours with the coverage
points, so each day keeps how it ended.

`GET /api/mediamesh/history` → `{ "days": [{ "day", "repeaters": [{ "k",
"n", "lat", "lon" }], "links", "backbone", "transmissions",
"media_packets" }] }`, oldest first.

Days in the browser are one of:

- **kept**: the analyzer's own row;
- **carried**: a day it missed after it began keeping them, shown as the
  last day kept before;
- **rebuilt**: before the first row, the repeaters first seen by then,
  where they are now; no links or packet counts.

Logic and tests: `public/mediamesh-timemachine.js`,
`tests/unit/test-mediamesh-timemachine.js`,
`cmd/server/mediamesh_days_test.go`.
