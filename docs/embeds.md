# MediaMesh on other websites

Three parts of the analyzer can go on another page (cascadiamesh.org, a club
site, a forum) as iframes. The MediaMesh tab has the code to copy under
**Put MediaMesh on your website**.

| Embed | Address | Shows |
|---|---|---|
| Night sky | `/?embed=sky` | The Live page's night sky: photos, video and voice crossing MediaMesh as it happens, full frame, in the CascadiaMesh colours. |
| Coverage map | `/?embed=coverage` | The MediaMesh coverage card alone: the map, "Where you are", "Can I join from here?" and the measured points. |
| Live badge | `/embed/badge.html` | Repeaters, the week's MediaMesh packets and the observers listening, a 24-hour sparkline and Live/Quiet. Refreshes every minute. |

```html
<iframe src="https://analyzer.cascadiamesh.org/?embed=sky" width="100%" height="520"
  style="border:0;border-radius:12px" allow="fullscreen" loading="lazy" title="MediaMesh live night sky"></iframe>
<iframe src="https://analyzer.cascadiamesh.org/?embed=coverage" width="100%" height="1000"
  style="border:0" loading="lazy" title="MediaMesh coverage map"></iframe>
<iframe src="https://analyzer.cascadiamesh.org/embed/badge.html" width="360" height="132"
  style="border:0" loading="lazy" title="MediaMesh live"></iframe>
```

Add `&theme=light` or `&theme=dark` (`?theme=` on the badge) to match the
page around it; without it each follows the viewer's system setting. The
night sky is always the dark navy.

In an embed the analyzer's own navigation is hidden, and an **Open the
analyzer ↗** link (the whole badge, for the badge) opens it in a new tab.
`public/mediamesh-embed.js` does this; it runs before the router, so the
first page drawn is the embed's.

## Framing

The analyzer sends no `X-Frame-Options` or `frame-ancestors`, so any site can
frame it. A reverse proxy in front of it that adds either header will stop
the embeds; allow the sites that should show them, for example
`Content-Security-Policy: frame-ancestors 'self' https://cascadiamesh.org https://*.cascadiamesh.org`.
