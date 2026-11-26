# How clips cross radio2

The MediaMesh part of the Analytics tab has six cards beside **Did it arrive?**, **What the
observers heard** and **How fast clips cross the mesh**, and every clip in **Recent clips**
can be replayed on a map. All of it comes from what the observers already hear and from
delivery receipts ([mediamesh-receipts.md](mediamesh-receipts.md)); nothing changes on the
repeaters.

| Card | Where | From |
|---|---|---|
| What the observers heard, against what arrived | after What the observers heard | `/api/analytics/mediamesh/clips` (receipts) |
| How long until a clip is whole | after How fast clips cross the mesh | `/api/analytics/mediamesh/clips` (receipts) |
| How many repeaters relay each piece | **How clips cross radio2** section | `/api/analytics/mediamesh/relays` |
| Airtime per repeater | **How clips cross radio2** section | `/api/analytics/mediamesh/relays` |
| Where pieces are lost, hop by hop | **How clips cross radio2** section | `/api/analytics/mediamesh/clips` (`heardByHop`) |
| Which pieces go missing | **How clips cross radio2** section | `/api/analytics/mediamesh/clips` (`missing`, `rebuilt`) |

The code is `public/mediamesh-journey.js` (the cards) and `public/mediamesh-replay.js` (the
replay); `public/mediamesh-insights.js` places them.

## What the observers heard, against what arrived

One dot per delivery with a receipt: across, how much of the clip the observer furthest
along heard (`heard / total`); top row, the receiving app had it whole; bottom row, in part.
Clips sent privately count once a receipt gives their total. Two tiles: deliveries whose
clip the observers heard under half of that still arrived whole, and deliveries of clips
heard whole by an observer that didn't arrive whole.

## How long until a clip is whole

Each receipt of a whole clip says when it finished; the clips endpoint gives each clip's
`delivery.wholeAfterS`, the seconds from the clip being announced (or first heard) to each
recipient's receipt. The card draws the share of clips whole against time, for photos,
voice or video, or by hops (1–2, 3–4, 5+), and marks when half and nine in ten were whole.
Fewer than 5 is called too few to go on.

## How many repeaters relay each piece

Every photo, video and voice piece heard on radio2 counts the repeaters named in any of its
MediaMesh observations' paths: each relayed it. The card shows pieces by relays (1–5, 6–10,
…, 31+), the median, the airtime all a piece's relays take together on average (LoRa time on
air at radio2's 250 kHz SF7 CR 4/5, per relay), the starting repeaters whose pieces get the
most relays, and, with **Week by week**, the median for each week kept (weeks with fewer
than 20 pieces faded). A piece heard only straight from its sender isn't counted.

## Airtime per repeater

For each repeater (2-byte path hashes and longer; a 1-byte hash names no repeater for sure),
the share of each hour it spent sending clip pieces: typical (the median over every hour
with clip traffic, an hour it sent nothing counting as 0) and its busiest hour, against a
line at 60%, past which there's little time left to listen.

## Where pieces are lost, hop by hop

Each announced clip carries `heardByHop`: how many of its data pieces some observer heard at
least 1, 2, … hops out (up to 8). For each hop the card averages, over the clips that got
that far, the share of their pieces heard that far, and marks the biggest step down. Hops
fewer than 3 clips reached are faded. Routes (first repeater → the observer furthest along)
with at least 2 clips can be picked.

## Which pieces go missing

Over announced clips the far end judged, how often each piece number went unheard there
(missing, or rebuilt from parity or repair pieces), in buckets 0, 1, … 5, 6–9, … 30+. The
first three pieces against the rest: 1.5× or more reads as bunched at the start (repeaters
still on the main mesh when a clip begins), less as spread evenly (collisions). Filters:
every clip, photos, voice, and clips sent in a busy hour (the busiest quarter of hours by
packets). Needs 5 clips.

## Replay a clip's path

The map button beside each route in **Recent clips** opens the replay under the clip's row:
every piece the observers heard runs along the path it took, on the map, with play and
pause, 1×/4×/16×, a slider to scrub, a tick for every piece heard, what's been heard so far,
when the far end could rebuild the clip, and a list of what was just heard. Quiet stretches
(over 6 s with nothing heard) are skipped while playing. Hops without a known place are
drawn straight across.

A path holds only the first byte or two of each repeater's key, which many main-mesh
repeaters share. A piece on radio2 only went through repeaters that run MediaMesh, so each hop
is named and placed from those alone (`mediaMeshHopNamer`, also used for the airtime per
repeater card); a hop that matches none of them stays its hash. Kept logs are named again
when they're read.

It's drawn from the clip's flight recorder, `/api/analytics/mediamesh/clips/{sid}`. A clip on
a private channel has no session id; its key is `p`, its channel's one-byte hash (`xx` when
unknown) and the unix second its first piece was heard, in hex (`privateChannel[].sid`), and
its flight recorder is its burst of packets, numbered in the order heard
(`private: true`). The button is greyed when a clip has nothing kept to replay
(`replay: false`).

## Kept for a week

Memory holds hours of packets. Every 5 minutes the server keeps, beside the coverage points:

- the flight recorder of every clip heard in the last 90 minutes (`mm_cliplogs`, 8 days),
  only ever written over by a fuller one; the flight recorder endpoint answers from it when
  memory has less;
- each hour's relays tally (`mm_relay_hours`, 35 days), only ever written over by a fuller
  one; `/api/analytics/mediamesh/relays` is the kept hours with the hours in memory laid over
  them.

## `/api/analytics/mediamesh/relays`

`?days=7` (1–31). Answers `{from, to, pieces, bins [{label, pieces}], medianRelays,
airPerPieceS, byStart [{hash, name, median, pieces}] (at most 5, at least 5 pieces each),
weeks [{week (the Monday), median, pieces}] (35 days), repeaters [{hash, name, typicalPct,
busiestPct, busiestAt}] (at most 12, busiest first), busyLinePct, preset}`.
