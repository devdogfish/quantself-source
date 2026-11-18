#!/usr/bin/env bash
set -euo pipefail
role_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
exec "$role_dir/../shared/install.sh" "$role_dir" "$@"
