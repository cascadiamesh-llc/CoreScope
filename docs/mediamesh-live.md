# Live packets on the MediaMesh map

The coverage map on the MediaMesh tab shows photos, video and voice crossing the mesh as they are heard on radio2. It borrows the Night sky's effects (Live → Night sky), drawn over the real map. Untick **Live packets** in the map's legend to turn it off. The choice is remembered in this browser.

## What you see

- **Comets.** Each photo, video or voice packet flies hop by hop along the repeaters it took, then on to the observer that heard it. Colour shows the kind: green for photos, white (slate on the light theme) for video, blue for voice, grey-blue when the kind isn't known yet. Its route lights up behind it. Every repeater it passes flashes a ring and a twinkle.
- **Names light up.** While two or more repeaters are busy with MediaMesh, sending, relaying or hearing, their names fade in on glowing tags in the kind's colour. A tag flares each time a packet reaches its repeater, and fades out once that repeater has been quiet for six seconds. Tags never cover each other or the panel.
- **Embers.** Other radio2 traffic glows faintly where it was heard.
- **Arrivals.** Once a clip's last piece has passed, its destination shows how it went:
  - a burst when every piece was heard;
  - a burst and a gold shimmer when parity pieces made up for missing ones.
  
  A clip heard only in part just fades. Observers hear only part of a path, so that says nothing about whether it arrived. Only clips whose announcement gives their piece count are judged.
- **Moments.** A banner over the map marks:
  - the first photo, video and voice of the day;
  - a new longest route today;
  - a whole clip across five or more hops.
- **The panel.** It shows how many media packets were heard in the last 10 minutes and the latest five transfers, with their routes and how they went.
- **The last 24 hours in a minute.** This replays the day's photos, video and voice from `/api/analytics/mediamesh/replay`.

The map is never moved or zoomed for you. With reduced motion turned on, routes appear still and fade, with no comets or bursts.

## How packets are placed

Packets come over the page's shared WebSocket. A packet counts when an observer heard it on radio2. Clip parsing is the Live page's own (`window._liveMediaMesh`), so the two pages agree on what is a photo, a video or a voice clip.

How each hop is placed:
- by the server's resolved key;
- otherwise by its prefix among the MediaMesh repeaters, taking the one nearest the hop before when several match;
- the observer comes last, placed at its own repeater or at the position it reports on the Observers page.

Hops that can't be placed are left out. Repeaters without a position aren't drawn.

The code is in `public/mediamesh-live.js` and its tests are in `tests/unit/test-mediamesh-live.js`.
