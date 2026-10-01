#!/bin/sh
# Runs HALO_SERVERS game servers (default 1) in one container, each a
# gateway with its own game, room, WebRTC port (HALO_WEBRTC_UDP_PORT + n),
# status port (8790 + n), data and save folders. A server that stops is
# started again; the others play on.
set -u
count="${HALO_SERVERS:-1}"
base_udp="${HALO_WEBRTC_UDP_PORT:-40100}"
index=0
while [ "$index" -lt "$count" ]; do
  data="/tmp/halo-data-$index"
  mkdir -p "$data" && ln -sfn /data/maps "$data/maps"
  (
    while true; do
      HALO_DATA_ROOT="$data" \
      HALO_SAVE_ROOT="/tmp/halo-save-$index" \
      HALO_WEBRTC_UDP_PORT=$((base_udp + index)) \
      HALO_STATUS_ADDRESS=":$((8790 + index))" \
        /opt/halo/halo-gateway 2>&1 | sed -u "s/^/[server $index] /"
      echo "[server $index] stopped; starting again in 3 s"
      sleep 3
    done
  ) &
  index=$((index + 1))
done
wait
