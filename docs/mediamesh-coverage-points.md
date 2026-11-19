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

## How the estimate uses them

For each cell and each MediaMesh repeater within 6 km, the card compares the measured margin with the model's (before its 10 dB safety margin). A repeater that didn't answer anywhere in a cell counts as below −6 dB there (it would have answered on the main mesh, 6 dB more sensitive at 62.5 kHz). With at least 15 cells where a repeater answered, the correction that fits the walks best moves the whole ground estimate, up to +10 or −25 dB; a repeater with 5 cells of its own gets its own correction too, pulled towards the overall one. Drives, with 10 or more cells, set what **In a car** takes off. The correction replaces the one from links between repeaters for people on the ground, and shows in each terrain profile's budget.

## Config

`mediameshCoverage` in `config.json`: on unless `enabled` is `false`. `dbPath` (default `mediamesh-coverage.db` next to the analyzer database: the server has to be able to write there), `retentionDays` (default 365), `requireKnownRadio` (default `true`).
