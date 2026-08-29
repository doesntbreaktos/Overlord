#!/bin/sh
set -eu

client_workspace=/app/Overlord-Client
client_seed=/opt/overlord-client-source

mkdir -p "${GOTMPDIR:-/app/client-build-cache/go-tmp}"

if [ ! -s "$client_workspace/go.mod" ]; then
  cp -a "$client_seed/." "$client_workspace/"
fi

exec "$@"
