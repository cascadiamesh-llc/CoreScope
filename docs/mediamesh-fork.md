# CascadiaMesh fork: CoreScope with MediaMesh

This fork is upstream [CoreScope](https://github.com/Kpa-clawbot/CoreScope) plus
CascadiaMesh's MediaMesh support (radio2 traffic on the map, Live, Nodes and
Analytics). It follows every upstream release automatically, and it runs at
<https://analyzer.cascadiamesh.org>.

```
upstream release vX.Y.Z ──(every 6 h)──▶ merged into master ──▶ tests ──▶ image vX.Y.Z-mediamesh
                                                                            │
MediaMesh change pushed to master ─────────────────────────────▶ tests ──▶ image vX.Y.Z-mediamesh.2
                                                                            │
                                        analyzer.cascadiamesh.org ◀── checks every 6 h, updates itself
```

- **Version:** the upstream release it is built on, plus `-mediamesh`, e.g. `v3.16.0-mediamesh`.
  Later builds on the same upstream release count up: `v3.16.0-mediamesh.2`, `.3`, …
- **Image:** `ghcr.io/cascadiamesh-llc/corescope:latest` (newest build). Like upstream's
  `:v3` and `:v3.16`, `:v3-mediamesh` follows the newest 3.x build and `:v3.16-mediamesh` the
  newest 3.16.x build. Pin one exact build with `:v3.16.0-mediamesh`.
- **Releases:** <https://github.com/cascadiamesh-llc/CoreScope/releases>
- **Observers:** how to connect one, with MediaMesh: [observers.md](observers.md)

---

## For the analyzer maintainer: switch analyzer.cascadiamesh.org

One script does it. It works whether the analyzer runs the prebuilt image
(`docker compose`) or is built from source with `manage.sh`. Run it on the
server, from the folder you run the analyzer from (the one with
`docker-compose.yml` or `manage.sh`):

```bash
curl -fsSLO https://raw.githubusercontent.com/cascadiamesh-llc/CoreScope/master/scripts/mediamesh/corescope-mediamesh.sh
sudo bash corescope-mediamesh.sh install
```

What it does, in order:

1. Checks what's running and reads the current version and node count.
2. Downloads the MediaMesh build while the analyzer keeps running.
3. **Backs up the whole data folder** with SQLite's online backup. That's a
   consistent snapshot taken while the analyzer keeps running, with no downtime,
   and each copy is checked. The backup goes to `corescope-backups/` next to the
   data folder. **If there isn't enough disk space, it stops before changing anything.**
4. Switches over:
   - *docker compose:* the image line becomes `ghcr.io/cascadiamesh-llc/corescope:latest`.
     The original file is saved as `docker-compose.yml.pre-mediamesh`. A few seconds of downtime.
   - *manage.sh:* `origin` points at this fork, and `manage.sh update` builds the newest
     `-mediamesh` release. Downtime is the usual rebuild time.
5. Waits for the analyzer to answer, then confirms the version ends in `-mediamesh`
   and that **the node count is at least what it was before**.
6. Turns on automatic updates: a systemd timer (or cron) that checks every 6 hours.

### Data: nothing is lost

- The new build uses **the same data folder**. Nothing in it is moved, rewritten
  or deleted. MediaMesh only adds two new, empty tables (`observation_mediamesh`,
  `node_mediamesh`). No existing table is altered and nothing is backfilled, so the
  first start on the existing database is as quick as an upstream upgrade.
- Every automatic update makes a fresh backup first (the newest two are kept). The
  pre-switch backup is never deleted.
- If an update doesn't come up healthy within 15 minutes, it is rolled back to the
  previous build automatically.

If the data folder is on a small disk, put backups elsewhere:
`sudo BACKUP_ROOT=/mnt/big/corescope-backups bash corescope-mediamesh.sh install`.

### Day to day

```bash
sudo corescope-mediamesh status     # version, node count, next update check
sudo corescope-mediamesh update     # check for a new build now
sudo corescope-mediamesh rollback   # back to upstream CoreScope (data kept)
journalctl -u corescope-mediamesh-update   # update history (systemd hosts)
```

Going back to upstream keeps all data. Upstream ignores the two MediaMesh tables.

---

## For fork maintainers

### How the fork stays current

`.github/workflows/mediamesh-sync.yml` runs every 6 hours (Actions → **MediaMesh
upstream sync** → *Run workflow* to run it now). When upstream has published a
release that master doesn't contain, it **merges** it. It doesn't rebase, so the
MediaMesh history stays intact. It then runs the tests and pushes master.
`.github/workflows/mediamesh-release.yml` then tests again and publishes the image
and the `-mediamesh` release.

MediaMesh changes go to master as usual. Each push to master publishes a new build,
and the analyzer picks it up within 6 hours.

Keep MediaMesh code in its own files where possible (`*mediamesh*`), with only
small hooks in shared upstream files. That keeps upstream merges conflict-free.

### When a sync conflicts

If an upstream release touches the same lines as MediaMesh, master is left
unchanged, so the analyzer keeps running the last good build. The sync run fails
and explains what to do. With Issues turned on, it also opens an issue listing
the files. To merge it by hand:

```bash
git fetch https://github.com/Kpa-clawbot/CoreScope.git tag vX.Y.Z --no-tags
git checkout master && git pull
git merge --no-ff vX.Y.Z        # fix the listed files, keeping both upstream's change and MediaMesh's
sh test-all.sh && make test
git push origin master          # publishes vX.Y.Z-mediamesh
```

### One-time setup

1. **Make the image public** (after the first *MediaMesh release* run): your
   profile → Packages → `corescope` → Package settings → Change visibility →
   Public. Otherwise servers can't pull it without logging in.
2. **Add `SYNC_TOKEN`.** Upstream releases often change upstream's own
   `.github/workflows` files, and GitHub never lets the built-in token push those.
   Create a fine-grained token (Settings → Developer settings → Fine-grained
   tokens) for `cascadiamesh-llc/CoreScope` only, with **Contents: read and write**
   and **Workflows: read and write**. Add it under the repo's Settings → Secrets
   and variables → Actions as `SYNC_TOKEN`. Without it, those syncs stop and say so.
3. **Turn on Issues** (Settings → General → Features → Issues), so conflicts open an issue.
4. **Turn off upstream-only workflows** (Actions → pick each → ⋯ → Disable
   workflow): the four **Squad …** workflows and **Release Fast Path**. They're
   upstream's project bots and release tooling. Disabling them in the Actions tab
   doesn't change any files, so it never conflicts.

Upstream's own **CI/CD Pipeline** stays on. It runs the full test suite, including
browser tests, on every pull request to the fork, and on master it also publishes
an `:edge` image of the fork.
