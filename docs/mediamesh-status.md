# Is MediaMesh up? (`#/mediamesh-status`)

A public page for outages: open it when the power goes out, or bookmark it
for ARES, CERT and neighbours. It refreshes every minute.

- **Gone quiet:** a MediaMesh repeater the analyzer hasn't heard on the
  main mesh for four times its usual gap between packets (from how many it
  relayed in the last 24 hours), at least 30 minutes and at most 6 hours.
  A repeater with no record on the analyzer is left out.
- **One piece:** whether the repeaters that are up are still joined by the
  links heard this week (backbone hops and links observers heard straight
  off the air), or split into pieces media can't cross.
- **Single points of failure:** repeaters whose loss alone would split the
  mesh now (the articulation points of that graph).
- **Still reached:** the people-on-the-ground coverage estimate (the same
  one, and the same session cache, as the MediaMesh tab's map), counted for
  the repeaters that are up, against all of them. Water counts.
- **Places:** each repeater's neighbourhood (the first part of its Near),
  at its spot: two or more repeaters that are up reach it, one, or none;
  cut off, the nearest repeater that still works.

The MediaMesh tab links to it from its introduction. Logic and tests:
`public/mediamesh-status.js`, `tests/unit/test-mediamesh-status.js`.
