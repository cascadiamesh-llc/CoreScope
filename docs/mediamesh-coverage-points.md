# MediaMesh coverage points

People who map MediaMesh coverage on a walk or a drive with **MeshCore Open TAK** (MediaMesh Settings › Map MediaMesh coverage) or a **Wadamesh TAK** standalone (Settings › MediaMesh › Map coverage) can send what they recorded to an analyzer. The analyzer's coverage card checks its estimate for people on the ground against those points, and shows them on the map.

## In the app and on a standalone

Switch on **Share coverage points** next to the coverage recorder. **Analyzer** is where they go: `https://analyzer.cascadiamesh.org` unless you change it to another CoreScope with this fork. Points go out while recording (and any left over later), at most 500 a batch, each batch signed by the radio's own key. **Remove my points from the analyzer** asks it to delete everything that radio sent.

## What is sent

`POST /api/mediamesh/coverage-points`, JSON:

```json
{
  "v": 1,
  "radio": "<the radio's 64-hex-digit public key>",
  "sent": 1795100000,
  "app": "MeshCore Open TAK 1.2.3",
  "radio2": { "bw_hz": 250000, "sf": 7 },
  "main_bw_hz": 62500,
  "points": [
    { "t": 1795099000, "lat": 47.6101, "lon": -122.3249, "acc": 6, "speed": 1.3,
      "reps": [ { "key": "1ea5e195", "snr": 4.25, "remote_snr": 2.5, "margin": 4.0 } ] }
  ]
}
```

`reps` is every MediaMesh repeater that answered there (empty: none did). `margin` is the recorder's estimate of radio2's margin over what it decodes, from the weaker direction's SNR on the main mesh (see MeshCore Open TAK's `documentation/media-mesh.md`, "Coverage map").

Header `X-MeshCore-Signature`: the radio's Ed25519 signature, in hex, of the text `corescope-coverage:` followed by the hex SHA-256 of the exact body. Companions sign with `CMD_SIGN_START` / `CMD_SIGN_DATA` / `CMD_SIGN_FINISH`; a standalone with its own identity.

The analyzer only takes radios it has heard (so send an advert first), at most 30 batches an hour per radio. A point already stored (same radio and time) is skipped. Answer: `{"accepted": n, "duplicates": n}`.

`DELETE /api/mediamesh/coverage-points` with `{"radio": "<key>", "sent": <unix now>}`, signed the same way with the prefix `corescope-coverage-delete:`, removes all of that radio's points.

## What is shown

`GET /api/mediamesh/coverage-points` gives 200 m cells, separately on foot and from a vehicle (faster than about 22 km/h): how many samples, how many with no MediaMesh repeater answering, and each repeater's median margin. The first and last 300 m of every trip (a radio's points with no gap over 30 minutes) are left out, so where someone starts and ends doesn't show. Nothing is given per radio.

It also gives the **Mapped by people** hexagons (`hexes`): 500 m across, flat-topped, on a grid in Web Mercator metres so they tile on the map (each 1° band of latitude sized for its middle). There is one wherever at least one MediaMesh repeater answered, with its pings, whether all were from a vehicle, each repeater's median margin and the best of them (`best`); places where nobody answered get none. `hexes_answered` counts those where radio2 would reach (`best` 0 dB or more), and `mapped_km2` is their area (0.2165 km² each; at 200 m they gave away too much of where people went, and one ping usually stands for a wider area than that). `trips` is how many trips the points came from.

The MediaMesh tab shows `mapped_km2` as **km² mapped by people**, and the coverage map has a **Mapped by people** layer (off until ticked, in every view) drawing the hexagons in green (5 dB or more to spare), amber (0 to 5) and red (answered, but radio2 would fall short).

## How the estimate uses them

For each spot and each MediaMesh repeater that answered there, the card compares the measured margin with the model's (before its 10 dB safety margin). A measured margin is a floor, not a measurement: it comes from the main mesh's SNR, and LoRa's SNR readings top out around +12 dB, so a repeater 100 m away reads no better than one at the edge of range. So mapping can only raise the estimate, never lower it. Repeaters that didn't answer aren't counted: the apps' pings don't reach or ask every repeater (repeaters the model put 30 dB and more above the floor have stayed silent beside ones that answered). With at least 15 spots where a repeater answered, the whole ground estimate is raised by how far the spots' floors sit above the model (the 90th percentile, so one odd spot can't lead it), weighed lightly: n spots count for n / (n + 40) of it, at most 10 dB. A repeater with 5 spots of its own may be raised a little more, pulled strongly towards the overall one (30 spots' worth). A car's loss can't be measured from floors, so **In a car** stays 8 dB. The correction replaces the one from links between repeaters for people on the ground, and shows in each terrain profile's budget.

## Config

`mediameshCoverage` in `config.json`: on unless `enabled` is `false`. `dbPath` (default `mediamesh-coverage.db` next to the analyzer database: the server has to be able to write there), `retentionDays` (default 365), `requireKnownRadio` (default `true`).

## Learning from mapping, and how sure the map is

All of this applies only while **Mapped by people** is ticked (off by
default): unticked, the map is the model alone. Ticked, the hexagons show,
the whole-estimate and per-repeater corrections above apply, and the
people-on-the-ground estimate is raised where people found more than it
says: each mapped cell's best measured margin (a floor; a vehicle's cells get
the car's loss back) above the estimate there, by at most 10 dB, spread to
the estimate's cells within 600 m, nearest counting most, and weighed
lightly: a spot's pings count w / (w + 6) of what they say (five pings, a
little under half). Cells where nobody answered, or where the estimate
already reaches, change nothing.

**How sure** colours what the estimate reaches by how it is known: dark
blue within 300 m of a mapped cell, light blue within 500 m of the line of a
link heard on radio2, grey the model alone. The line under the map gives the
share that is measured or checked, and where mapping corrected the estimate
most. Code: `learnFromField`, `applyLearned`, `confidenceCells` in
`public/mediamesh-coverage.js`.
