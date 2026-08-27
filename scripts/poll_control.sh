#!/bin/sh

# Fixed deployment tools and lock path. Confirm these paths with command -v on the VPS.
SCRIPT_DIR=${0%/*}
cd "$SCRIPT_DIR/.." || exit 1
REPO_DIR=$PWD

/usr/bin/flock -n -E 75 /run/lock/ksql-poll-control.lock \
  /usr/bin/node --env-file="$REPO_DIR/.env" "$REPO_DIR/scripts/poll_control.mjs" \
  --config "$REPO_DIR/poll-control.config.json"
status=$?

# Lock contention is a normal skip. Other statuses are passed through unchanged.
if [ "$status" -eq 75 ]; then
  exit 0
fi
exit "$status"
