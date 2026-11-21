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
