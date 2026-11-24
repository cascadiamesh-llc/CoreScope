# The MediaMesh bar

Every MediaMesh page starts with the same row (`public/mediamesh-nav.js`): Overview (the
MediaMesh tab), Is it up?, MediaMeshLab, Time machine, Grow the mesh, Forecast and Night sky
(the Live page's full-screen view, `#/live?nightsky=1`),
with the page you're on lit. Overview is the way back to the tab from any tool. Nothing is
nested. On a phone the row wraps to two lines, shown as Lab and Grow for the two longest
names (screen readers still hear the full names). The line on the MediaMesh tab ("In an
outage: … · Next: … Forecast") stays under the bar.

A new MediaMesh page goes in `PAGES` and calls `MediaMeshNav.html('<its id>')` at the top
of its page; `tests/unit/test-mediamesh-nav.js` checks every page has it.
