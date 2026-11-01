#!/usr/bin/env bash
# corescope-mediamesh: switch a CoreScope analyzer to the CascadiaMesh MediaMesh
# build and keep it updated, without losing any data.
#
#   sudo bash corescope-mediamesh.sh install  [DIR]   switch DIR's analyzer + enable auto-updates
#   sudo corescope-mediamesh update                     what the timer runs (safe to run by hand)
#   sudo corescope-mediamesh status
#   sudo corescope-mediamesh rollback                   back to upstream CoreScope (data kept)
#
# DIR is the folder you run the analyzer from: the one with docker-compose.yml
# (prebuilt image) or with manage.sh (built from source). Default: current folder.
#
# Data safety:
#   - Nothing in the data folder is changed, moved or deleted. The new build
#     uses the same folder; MediaMesh only adds two new, empty tables.
#   - Before switching, and before every update, the databases are copied with
#     SQLite's online backup (a consistent snapshot while the analyzer keeps
#     running; no downtime), then checked. If there is not enough disk space
#     for a backup, nothing is changed.
#   - The node count is read before and after the switch and compared.
#   - An update that does not come up healthy is rolled back to the previous build.
#
# Docs: docs/mediamesh-fork.md in https://github.com/cascadiamesh-llc/CoreScope

set -euo pipefail

FORK_IMAGE="${CORESCOPE_FORK_IMAGE:-ghcr.io/cascadiamesh-llc/corescope}"
FORK_GIT="${CORESCOPE_FORK_GIT:-https://github.com/cascadiamesh-llc/CoreScope.git}"
UPSTREAM_IMAGE_RE='ghcr\.io/kpa-clawbot/corescope'
CONF=/etc/corescope-mediamesh.conf
SELF_INSTALLED=/usr/local/sbin/corescope-mediamesh
HEALTH_WAIT=${HEALTH_WAIT:-900}   # seconds; big databases can take minutes to load
KEEP_AUTO_BACKUPS=${KEEP_AUTO_BACKUPS:-2}

say()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m ✓ \033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m ! \033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m ✗ \033[0m %s\n' "$*" >&2; exit 1; }

need_root() { [ "$(id -u)" -eq 0 ] || die "Run with sudo."; }
dc() { (cd "$DIR" && docker compose "$@"); }

compose_file() {
  local f
  for f in docker-compose.yml docker-compose.yaml compose.yml compose.yaml; do
    [ -f "$DIR/$f" ] && { echo "$DIR/$f"; return 0; }
  done
  return 1
}

detect_mode() {
  if [ -f "$DIR/manage.sh" ] && [ -d "$DIR/.git" ]; then echo source; return; fi
  local f; f=$(compose_file) || die "No docker-compose.yml or manage.sh in $DIR. Run this from the analyzer's folder."
  grep -Eq "image:[[:space:]]*[\"']?($UPSTREAM_IMAGE_RE|${FORK_IMAGE//./\\.})" "$f" \
    || die "$f does not use the CoreScope image ($FORK_IMAGE or ghcr.io/kpa-clawbot/corescope)."
  echo image
}

# Running analyzer container: the one with /app/data mounted, from this folder.
find_container() {
  local id
  if [ "$MODE" = image ]; then
    for id in $(dc ps -q 2>/dev/null); do
      if docker inspect "$id" --format '{{range .Mounts}}{{.Destination}} {{end}}' | grep -qw /app/data; then
        echo "$id"; return 0
      fi
    done
  else
    id=$(docker ps -q -f name='^corescope-prod$')
    [ -n "$id" ] && { echo "$id"; return 0; }
  fi
  return 1
}

data_dir() {
  docker inspect "$1" --format '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{.Source}}{{end}}{{end}}'
}

# GET an analyzer API path from inside the container (no host port or proxy involved).
api() { docker exec "$1" wget -qO- "http://localhost:3000$2" 2>/dev/null; }
json_field() { sed -n "s/.*\"$1\":\"\{0,1\}\([^\",}]*\).*/\1/p" | head -1; }

# Consistent copy of the data folder while the analyzer keeps running.
backup_data() {   # backup_data SRC DEST
  local src=$1 dst=$2 size avail f
  size=$(du -sb "$src" | cut -f1)
  mkdir -p "$(dirname "$dst")"
  avail=$(df -B1 --output=avail "$(dirname "$dst")" | tail -1)
  if [ "$avail" -lt $(( size + size / 10 + 104857600 )) ]; then
    die "Not enough free space for a backup: need ~$(( size / 1048576 + size / 10485760 + 100 )) MB in $(dirname "$dst"), have $(( avail / 1048576 )) MB. Nothing was changed. Free space, or set BACKUP_ROOT to a bigger disk."
  fi
  command -v python3 >/dev/null || die "python3 is needed for a live database backup (apt install python3)."
  mkdir -p "$dst"
  # Plain files first (config.json, theme.json, ...); databases via SQLite below.
  ( cd "$src" && find . -type f ! -name '*.db' ! -name '*.db-wal' ! -name '*.db-shm' ! -name '*.db-journal' \
      -exec cp -a --parents {} "$dst/" \; )
  while IFS= read -r -d '' f; do
    local rel=${f#"$src"/}
    mkdir -p "$dst/$(dirname "$rel")"
    say "Backing up $rel ($(du -h "$f" | cut -f1))..."
    python3 - "$f" "$dst/$rel" <<'PY'
import sqlite3, sys
# Read-only, so a root backup never creates files the analyzer (often uid 1000) can't use.
try:
    src = sqlite3.connect("file:%s?mode=ro" % sys.argv[1], uri=True, timeout=120)
    src.execute("SELECT 1 FROM sqlite_master LIMIT 1")
except sqlite3.Error:
    src = sqlite3.connect(sys.argv[1], timeout=120)
dst = sqlite3.connect(sys.argv[2])
src.backup(dst)                      # one read transaction: a consistent snapshot; writers keep going (WAL)
dst.close(); src.close()
chk = sqlite3.connect(sys.argv[2])
res = chk.execute("PRAGMA quick_check").fetchone()[0]
if res != "ok":
    sys.exit("backup check failed: " + res)
PY
  done < <(find "$src" -type f -name '*.db' -print0)
  ok "Backup complete: $dst ($(du -sh "$dst" | cut -f1))"
}

backup_root() { echo "${BACKUP_ROOT:-$(dirname "$1")/corescope-backups}"; }

wait_healthy() {   # wait_healthy -> prints the running container id
  local t=0 id stats
  while [ "$t" -lt "$HEALTH_WAIT" ]; do
    if id=$(find_container) && stats=$(api "$id" /api/stats) && [ -n "$stats" ]; then
      echo "$id"; return 0
    fi
    sleep 10; t=$((t + 10))
  done
  return 1
}

node_count() { api "$1" /api/stats | json_field totalNodesAllTime; }
version_of() { api "$1" /api/stats | json_field version; }

install_auto_update() {
  install -m 0755 "$0" "$SELF_INSTALLED"
  if command -v systemctl >/dev/null && [ -d /run/systemd/system ]; then
    cat > /etc/systemd/system/corescope-mediamesh-update.service <<EOF
[Unit]
Description=Update CoreScope (MediaMesh build) if a new release is out
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=$SELF_INSTALLED update
EOF
    cat > /etc/systemd/system/corescope-mediamesh-update.timer <<'EOF'
[Unit]
Description=Check for CoreScope MediaMesh updates every 6 hours

[Timer]
OnBootSec=15min
OnUnitActiveSec=6h
RandomizedDelaySec=30min
Persistent=true

[Install]
WantedBy=timers.target
EOF
    systemctl daemon-reload
    systemctl enable --now corescope-mediamesh-update.timer >/dev/null
    ok "Auto-updates on: checks every 6 hours (systemctl list-timers corescope-mediamesh-update)"
  else
    echo "23 */6 * * * root $SELF_INSTALLED update >> /var/log/corescope-mediamesh.log 2>&1" > /etc/cron.d/corescope-mediamesh
    ok "Auto-updates on: checks every 6 hours (/etc/cron.d/corescope-mediamesh)"
  fi
}

load_conf() {
  [ -f "$CONF" ] || die "Not set up yet. Run: sudo bash corescope-mediamesh.sh install /path/to/analyzer"
  # shellcheck disable=SC1090
  . "$CONF"
}

# ─────────────────────────────────────────────────────────────────────────────
cmd_install() {
  need_root
  DIR=$(cd "${1:-.}" && pwd)
  command -v docker >/dev/null || die "Docker is not installed."
  [ -f "$0" ] || die "Download the script first, then run it with: sudo bash corescope-mediamesh.sh install"
  MODE=$(detect_mode)
  if [ "$MODE" = image ]; then say "Analyzer in $DIR (prebuilt image, docker compose)"
  else say "Analyzer in $DIR (built from source with manage.sh)"; fi

  local cid data before_nodes before_ver stamp bdir
  cid=$(find_container) || die "The analyzer is not running. Start it first, so its data can be backed up and checked."
  data=$(data_dir "$cid"); [ -d "$data" ] || die "Could not find the analyzer's data folder."
  before_nodes=$(node_count "$cid" || true); before_ver=$(version_of "$cid" || true)
  ok "Running ${before_ver:-unknown version}, ${before_nodes:-?} nodes, data in $data"

  # 1. Get the new build ready while the analyzer keeps running.
  if [ "$MODE" = image ]; then
    say "Downloading the MediaMesh build..."
    docker pull "$FORK_IMAGE:latest" >/dev/null || die "Could not pull $FORK_IMAGE:latest. Is the package public? (docs/mediamesh-fork.md)"
  else
    git ls-remote --tags "$FORK_GIT" 'v*-mediamesh*' | grep -q . \
      || die "No MediaMesh release found at $FORK_GIT yet (or it can't be reached)."
  fi

  # 2. Backup (no downtime).
  stamp=$(date +%Y%m%d-%H%M%S)
  bdir="$(backup_root "$data")/pre-mediamesh-$stamp"
  backup_data "$data" "$bdir"

  # 3. Remember how to undo (and install this script, so rollback works even
  #    if the next step fails), then switch.
  install -m 0755 "$0" "$SELF_INSTALLED"
  {
    echo "DIR=$(printf %q "$DIR")"
    echo "MODE=$MODE"
    echo "FIRST_BACKUP=$(printf %q "$bdir")"
  } > "$CONF"
  if [ "$MODE" = image ]; then
    local f; f=$(compose_file)
    [ -f "$f.pre-mediamesh" ] || cp -a "$f" "$f.pre-mediamesh"
    echo "ORIGINAL_COMPOSE=$(printf %q "$f.pre-mediamesh")" >> "$CONF"
    sed -E -i "s#($UPSTREAM_IMAGE_RE|${FORK_IMAGE//./\\.})(:[^[:space:]\"']*)?#$FORK_IMAGE:latest#" "$f"
    say "Restarting on the MediaMesh build (a few seconds of downtime)..."
    dc up -d
  else
    echo "ORIGINAL_REMOTE=$(printf %q "$(git -C "$DIR" remote get-url origin)")" >> "$CONF"
    git -C "$DIR" remote set-url origin "$FORK_GIT"
    # manage.sh builds the newest v* tag it has. Drop tags from the old remote,
    # so an upstream release that is newer than the MediaMesh build can't win.
    git -C "$DIR" tag -l | xargs -r git -C "$DIR" tag -d >/dev/null
    git -C "$DIR" fetch -q origin --tags --force
    say "Building the MediaMesh release from source (manage.sh update)..."
    (cd "$DIR" && ./manage.sh update)
  fi

  # 4. Check.
  say "Waiting for the analyzer to come back (loading a big database can take a few minutes)..."
  cid=$(wait_healthy) || die "The analyzer did not answer within $((HEALTH_WAIT / 60)) min. Check its logs (docker compose logs / ./manage.sh logs). To undo: sudo $SELF_INSTALLED rollback"
  local after_ver after_nodes
  after_ver=$(version_of "$cid"); after_nodes=$(node_count "$cid" || true)
  case "$after_ver" in *-mediamesh*) ok "Now running $after_ver" ;; *) warn "Running '$after_ver'. Expected a -mediamesh version." ;; esac
  if [ -n "$before_nodes" ] && [ -n "$after_nodes" ]; then
    if [ "$after_nodes" -ge "$before_nodes" ]; then ok "All nodes still there: $after_nodes (was $before_nodes)"
    else warn "Node count is $after_nodes, was $before_nodes. If it doesn't catch up in a few minutes, run: sudo $SELF_INSTALLED rollback"; fi
  fi

  install_auto_update
  echo
  ok "Done. Backup of the data before the switch: $bdir"
}

cmd_update() {
  need_root; load_conf
  local cid data old new stamp bdir
  cid=$(find_container) || die "Analyzer not running; not updating."
  data=$(data_dir "$cid")

  if [ "$MODE" = image ]; then
    old=$(docker inspect "$cid" --format '{{.Image}}')
    docker pull -q "$FORK_IMAGE:latest" >/dev/null || die "Pull failed; staying on the current build."
    new=$(docker image inspect "$FORK_IMAGE:latest" --format '{{.Id}}')
    [ "$old" = "$new" ] && { echo "$(date -Is) up to date"; exit 0; }
  else
    git -C "$DIR" fetch -q origin --tags --force
    old=$(git -C "$DIR" describe --tags --exact-match 2>/dev/null || git -C "$DIR" rev-parse --short HEAD)
    new=$(git -C "$DIR" tag -l 'v*' --sort=-v:refname | head -1)
    [ "$old" = "$new" ] && { echo "$(date -Is) up to date ($old)"; exit 0; }
  fi

  if [ "$MODE" = image ]; then say "$(date -Is) new build available (running $(version_of "$cid"))"
  else say "$(date -Is) update available: $old -> $new"; fi
  stamp=$(date +%Y%m%d-%H%M%S)
  bdir="$(backup_root "$data")/auto-$stamp"
  backup_data "$data" "$bdir"      # exits (no update) if it cannot back up

  if [ "$MODE" = image ]; then dc up -d; else (cd "$DIR" && ./manage.sh update); fi

  if cid=$(wait_healthy); then
    ok "Updated to $(version_of "$cid")"
    # keep the newest auto backups (the pre-mediamesh one is never removed)
    find "$(dirname "$bdir")" -maxdepth 1 -type d -name 'auto-*' | sort -r | tail -n +$((KEEP_AUTO_BACKUPS + 1)) | xargs -r rm -rf
  else
    warn "New build did not come up healthy. Going back to the previous build."
    if [ "$MODE" = image ]; then
      docker tag "$old" "$FORK_IMAGE:latest" && dc up -d
    else
      (cd "$DIR" && ./manage.sh update "$old")
    fi
    die "Rolled back to the previous build. Data backup from before the update: $bdir"
  fi
}

cmd_status() {
  load_conf
  local cid; cid=$(find_container) || die "Analyzer not running."
  echo "Folder:   $DIR ($MODE)"
  echo "Version:  $(version_of "$cid")"
  echo "Nodes:    $(node_count "$cid")"
  echo "Backups:  $(dirname "$FIRST_BACKUP")"
  if command -v systemctl >/dev/null; then systemctl list-timers corescope-mediamesh-update.timer --no-pager 2>/dev/null | sed -n 2p; fi
}

cmd_rollback() {
  need_root; load_conf
  say "Switching back to upstream CoreScope. The data folder is kept as it is."
  if [ "$MODE" = image ]; then
    cp -a "$ORIGINAL_COMPOSE" "${ORIGINAL_COMPOSE%.pre-mediamesh}"
    dc pull -q && dc up -d
  else
    git -C "$DIR" remote set-url origin "$ORIGINAL_REMOTE"
    git -C "$DIR" tag -l | xargs -r git -C "$DIR" tag -d >/dev/null
    (cd "$DIR" && ./manage.sh update)
  fi
  systemctl disable --now corescope-mediamesh-update.timer 2>/dev/null || true
  rm -f /etc/cron.d/corescope-mediamesh
  ok "Back on upstream. Auto-updates from the MediaMesh build are off."
  echo "   The pre-switch backup is still at $FIRST_BACKUP (not needed for a normal rollback)."
}

case "${1:-}" in
  install)  shift; cmd_install "$@" ;;
  update)   cmd_update ;;
  status)   cmd_status ;;
  rollback) cmd_rollback ;;
  *) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
