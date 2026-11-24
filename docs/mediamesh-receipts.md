# MediaMesh delivery receipts

Observers only hear the pieces of a clip that pass near them, so what they heard says little about
whether a photo, video or voice clip arrived. The receiving app knows. With **Share delivery
receipts** on in MeshCore Open TAK (MediaMesh Settings, under Share coverage points), the app tells
the analyzer, for each clip it received:

| Field | |
|---|---|
| `sid` | the clip's session id, 8 hex digits (already on the air in every piece) |
| `kind` | `photo`, `video`, `voice` or `unknown` |
| `at` | when it finished, unix seconds (whole, or given up on) |
| `total`, `got` | the clip's pieces, and how many came over the air |
| `asked` | pieces the app asked for again |
| `rebuilt` | pieces rebuilt from parity |
| `whole` | whether the app ended up with the whole clip |

Never the clip's content, who sent it, the channel or where the phone was.

## Sending

`POST /api/mediamesh/receipts`, up to 500 a batch:

```json
{"v":1,"radio":"<64 hex public key>","sent":1795300000,"app":"MeshCore Open TAK 1.0",
 "receipts":[{"sid":"1a2b3c4d","kind":"photo","at":1795299940,"total":17,"got":16,"asked":1,"rebuilt":0,"whole":true}]}
```

Signed by the receiving radio as coverage points are: `X-MeshCore-Signature` is the radio's
signature (hex) of `corescope-receipt:` plus the hex SHA-256 of the exact body. Only radios the
analyzer has heard (unless `mediameshCoverage.requireKnownRadio` is `false`), at most 30 uploads an
hour a radio. A repeat of the same radio, clip and time replaces it. Answers
`{"accepted":n,"duplicates":n}`.

`DELETE /api/mediamesh/receipts` with `{"radio":…,"sent":<now>}`, signed with the prefix
`corescope-receipt-delete:`, removes every receipt that radio sent.

Receipts live in the coverage points file (`mediameshCoverage.dbPath`) and are kept as long as the
points (`retentionDays`, default 365).

## Showing

`/api/analytics/mediamesh/clips` gives each clip (announced or sent privately) its receipts as
`delivery`: `{recipients, whole, asked, rebuilt}`, counting each receiving radio once (its latest
receipt for that clip), from receipts finished between 10 minutes before the clip was first heard
and 12 hours after. The MediaMesh tab's **Did it arrive?** shows how many deliveries arrived whole
and how, a **Recipient** column in its clip list, and the flight recorder adds what the receiving
apps reported. Nothing is shown per radio.

## How fast clips cross

The MediaMesh tab's **How fast clips cross the mesh** card shows speeds in bit/s: across a few
hops they run to a few hundred. A clip is timed from the first piece its far end heard until it
had enough to make the whole clip; **while sending** leaves out pauses of over 15 s.

Some clips are left out of the figures, and marked in the clip list:

- **Waited on the far end:** paused for at least 5 minutes and for over three-quarters of its
  time, as when a phone comes back later and asks for the rest. It's left out of the end-to-end
  median, since that time is the wait, not the mesh. Repair rounds on a long route pause for far
  less and stay in.
- **Too uncertain to time:** faster while sending than radio2 can carry (about 6,400 bit/s, zero
  hop on the US MediaMesh preset), over in under 3 s, or sent privately with fewer than 5 pieces
  heard, so its size rests on a few pieces' numbers. It's left out of every figure.

The bars by hops are medians while sending. A bar resting on fewer than 3 clips is faded, and the
bars are scaled to those with enough clips. The fastest route goes by speed while sending too.
The code is in `public/mediamesh-insights.js` and its tests in
`tests/unit/test-mediamesh-insights.js`.

## Kept past memory

The clips, the hourly photo and voice traffic and how fast clips crossed are worked out from the
packets in memory, which holds only as many packets as fit (`packetStore.maxMemoryMB`); with every
packet heard by dozens of observers that can be hours, not the week asked for. So every 5 minutes,
and whenever the clips are asked for, the clips worked out are kept in the coverage points file
(`mm_clips`, `mm_clip_hours`, 35 days; `cmd/server/mediamesh_clip_keep.go`), and the answer is
what was kept for the period with what's in memory laid over it. A clip is only written over by a
better account of it (whole before partial, then more pieces heard), since one worked out again
after its first pieces have left memory looks worse than it was; an hour keeps the most packets
and clips it was seen with. Clips from before this was deployed, already gone from memory, can't
be brought back.

The rest of the MediaMesh tab that comes from packets in memory (the transmission counts and
radio2 share, packet types, transmissions by hour, the observer table, the radio2 links and the
photo and voice hop counts) is kept the same way, hour by hour: each hour's tally goes into
`mm_hours` every 5 minutes, written over only by a fuller one, and an answer for the whole
network (not one region) adds the kept hours that have lost packets from memory to the hours
still in it, back a week when no window is asked for (`cmd/server/mediamesh_hours_keep.go`). The
repeaters and the backbone already come from the ingestor's tables.
