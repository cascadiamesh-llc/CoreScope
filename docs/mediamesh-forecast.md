# Forecast (`#/mediamesh-forecast`)

How MediaMesh's links should do over the next days, from the weather ahead
and how each link heard on radio2 has done in weather like it.

**Link history.** Each link heard on radio2 (a node an observer heard
straight off the air) is kept as an hourly average SNR in `link_hours`,
beside the coverage points, for 120 days: written from the packets the
analyzer holds every 6 hours and whenever the history is asked for (at most
every 30 minutes). `GET /api/mediamesh/link-history?days=` gives it.

**Weather.** `GET /api/mediamesh/weather?lat=&lon=` passes on Open-Meteo's
hourly weather for the middle of the mesh, the last 30 days and the next 4,
cached for an hour: temperature at 2 m and at 850 hPa (about 1.5 km up),
rain and wind. The inversion is 850 hPa minus 2 m: the warmer the air above
the ground, the more stable it is, and over water radio carries further.

**The fit.** Per link, its hourly SNR against the inversion, rain and wind
(least squares, gently held toward no effect so a link heard in one kind of
weather isn't over-read), once it has 24 hours heard. The forecast for a day
is the fit at that day's weather against the link's usual; a day's figure is
the middle of the links'. Tonight is from 6 PM. Until links have history,
the days show the weather and "Learning".

Logic and tests: `public/mediamesh-forecast.js`,
`tests/unit/test-mediamesh-forecast.js`; server: `cmd/server/mediamesh_link_history.go`.
