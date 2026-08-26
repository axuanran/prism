#!/usr/bin/env bash
# Starts a throwaway PostgreSQL for the persistence suite.
#
# The suite refuses to run against a fake, so it needs a real server. This
# script prefers whatever is already there and only creates a cluster as a last
# resort. On Windows, PostgreSQL refuses to start under an administrator
# account, which is why the WSL path exists.
#
#   PRISM_TEST_DATABASE_URL   set this and the suite uses it directly
#   otherwise                 the suite looks for 127.0.0.1:55432
set -euo pipefail

PORT="${PRISM_PG_PORT:-55432}"
DATA_DIR="${PRISM_PG_DATA:-/tmp/prismpg}"
SOCKET_DIR="${PRISM_PG_SOCKET:-/tmp/prismpg-sock}"
USER_NAME="${PRISM_PG_USER:-prism}"

find_bin_dir() {
  for candidate in /usr/lib/postgresql/*/bin; do
    [ -x "$candidate/pg_ctl" ] && printf '%s' "$candidate" && return 0
  done
  command -v pg_ctl >/dev/null 2>&1 && dirname "$(command -v pg_ctl)" && return 0
  return 1
}

BIN_DIR="$(find_bin_dir)" || {
  echo "No PostgreSQL server binaries found. Install postgresql, or set PRISM_TEST_DATABASE_URL." >&2
  exit 1
}
export PATH="$BIN_DIR:$PATH"

if pg_isready -h 127.0.0.1 -p "$PORT" >/dev/null 2>&1; then
  echo "PostgreSQL already listening on 127.0.0.1:$PORT"
  exit 0
fi

if [ ! -s "$DATA_DIR/PG_VERSION" ]; then
  echo "Initialising a cluster in $DATA_DIR"
  rm -rf "$DATA_DIR"
  mkdir -p "$DATA_DIR"
  initdb -D "$DATA_DIR" -U "$USER_NAME" --auth=trust -E UTF8 >/dev/null
fi

mkdir -p "$SOCKET_DIR"
# `-k` matters: the default socket directory is usually root-owned, and the
# server exits rather than start without one it can write to.
pg_ctl -D "$DATA_DIR" \
  -o "-p $PORT -c listen_addresses=* -k $SOCKET_DIR" \
  -l "$DATA_DIR/server.log" start

sleep 2
pg_isready -h 127.0.0.1 -p "$PORT"
echo "PostgreSQL ready at postgres://$USER_NAME@127.0.0.1:$PORT/postgres"
