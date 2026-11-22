# MediaMesh across Cascadia

`#/mediamesh-cascadia` (linked from the MediaMesh tab as **Beyond: Cascadia**) puts this analyzer's MediaMesh and the MediaMesh of other analyzers on one map, and shows the gaps between them.

## What it shows

- **Each region**: its MediaMesh repeaters that sent a position, how many links were heard, and the week's clips. A region whose analyzer can't be reached is listed as such.
- **Closing the gaps**: for each pair of regions, the two closest repeaters, how far apart they are, and roughly how many sites in between would join them. The rough count is `ceil(distance / hop) − 1`, where hop is this mesh's median link heard, held between 5 and 25 km (10 km when there is none). It is a straight line that ignores the terrain. MediaMeshLab and Grow the mesh are where to try real spots.

## Connecting analyzers

Each analyzer lists the others in `config.json`:

```json
"mediameshCoverage": {
  "peers": [
    { "name": "Portland", "url": "https://analyzer.example.org" }
  ]
}
```

The server fetches each peer's public `/api/analytics/mediamesh` (10 s timeout, cached ten minutes), so browsers never contact other sites. Only what a MediaMesh tab already shows publicly is used. Repeaters whose position is only guessed from their name are left out.

## API

`GET /api/mediamesh/peers` →

```json
{ "regions": [{ "name": "This analyzer", "self": true, "ok": true,
  "repeaters": [{ "name": "…", "lat": 47.6, "lon": -122.3 }],
  "links": 12, "media_clips_7d": 3, "link_km": 8.2 }] }
```
