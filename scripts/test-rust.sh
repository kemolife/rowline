#!/bin/zsh
# Runs Rust tests; MySQL tests use the local test DB from dev/docker (docker compose up -d there)
set -e
ENV_FILE=${0:A:h}/../dev/docker/.env
if [[ -f $ENV_FILE ]]; then
  set -a; . $ENV_FILE; set +a
  export ROWLINE_TEST_MYSQL="127.0.0.1:13306:${DB_USER}:${DB_PASSWORD}:shop"
fi
cd ${0:A:h}/../src-tauri
cargo test --lib "$@"
