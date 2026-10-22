#!/usr/bin/env bash
set -euo pipefail
lab_dir=/home/ubuntu/xagent-mastra-lab
test ! -L "$lab_dir"
test "$(realpath "$lab_dir")" = "$lab_dir"
cd "$lab_dir"
install -d -m 700 data
if [ ! -f .env ]; then
  umask 077
  cp .env.example .env
fi
chmod 600 .env
test "$(id -u)" = 1000 || { printf 'Container data ownership requires review for this host UID.\n' >&2; exit 1; }
docker compose --project-name xagent-mastra-lab up --build -d
python3 scripts/verify.py --container xagent-mastra-lab
