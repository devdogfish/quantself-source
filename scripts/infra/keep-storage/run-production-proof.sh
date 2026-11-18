#!/usr/bin/env bash
# Reuse #252 unchanged; substitute only the reviewed production image.
# Synthetic local Docker proof, never a deployment or Keep acceptance test.
set -euo pipefail
source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
proof_dir="$source_dir/../../proofs/opencloud-storage"
staging_dir="$(mktemp -d "${TMPDIR:-/tmp}/qs-production-proof-source.XXXXXX")"
trap 'rm -rf -- "$staging_dir"' EXIT
cp "$proof_dir/compose.yaml" "$proof_dir/proof.mjs" "$proof_dir/run.sh" "$staging_dir/"
python3 - "$source_dir/opencloud-image.txt" "$staging_dir/compose.yaml" <<'PY'
from pathlib import Path
import re, sys
image = Path(sys.argv[1]).read_text().strip()
if not re.fullmatch(r'opencloudeu/opencloud:\d+\.\d+\.\d+@sha256:[0-9a-f]{64}', image):
    raise SystemExit('Expected a production image pinned by version and digest')
compose = Path(sys.argv[2])
updated, count = re.subn(r'(?m)^    image: opencloudeu/opencloud-rolling:[^\n]+$', '    image: '+image, compose.read_text())
if count != 1:
    raise SystemExit('Proof image contract changed; review before running')
compose.write_text(updated)
PY
bash "$staging_dir/run.sh"
