#!/usr/bin/env bash
set -euo pipefail
umask 077

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

[[ "$#" == 3 ]] || fail 'Usage: atlas-build.sh SOURCE_CHECKOUT EXPECTED_SHA OUTPUT_DIR'
source_checkout=$1
revision=$2
[[ "$revision" =~ ^[0-9a-f]{40}$ ]] || fail 'Expected a full lowercase Git SHA.'

# The supervisor admits the source event, SHA and checkout before invoking this recipe.
checkout_git() {
  GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_ATTR_NOSYSTEM=1 \
    git --no-replace-objects -C "$source_checkout" "$@"
}
[[ "$(checkout_git rev-parse --is-inside-work-tree)" == true &&
   -z "$(checkout_git rev-parse --show-prefix)" ]] || fail 'Expected the root of a source checkout.'
if checkout_git symbolic-ref --quiet HEAD >/dev/null; then
  fail 'Source checkout must have a detached HEAD.'
fi
[[ "$(checkout_git rev-parse --verify 'HEAD^{commit}')" == "$revision" ]] || fail 'Source revision differs.'
source_status=$(checkout_git status --porcelain=v1 --untracked-files=all)
[[ -z "$source_status" ]] || fail 'Source checkout must be clean.'

output=$(python3 - "$3" <<'PY'
import os
from pathlib import Path
import stat
import sys

requested = Path(sys.argv[1])
parent = requested.parent.resolve(strict=True)
info = parent.stat()
if (not requested.name or requested.name == ".." or not stat.S_ISDIR(info.st_mode)
        or info.st_uid != os.getuid() or info.st_mode & 0o077):
    sys.exit("Output parent must be a private directory owned by the builder user.")
output = parent / requested.name
if os.path.lexists(output):
    sys.exit("Output directory already exists.")
print(output)
PY
)
work=$(mktemp -d "$(dirname "$output")/.atlas-build.XXXXXXXX")
image="quantself-atlas:$revision-${work##*.}"
stage="$work/archive"

private() {
  env -i "PATH=$PATH" "HOME=$work/home" "XDG_RUNTIME_DIR=/run/user/$UID" \
    "DOCKER_HOST=unix:///run/user/$UID/docker.sock" \
    DOCKER_DEFAULT_PLATFORM=linux/amd64 "$@"
}

remove_image=0
cleanup() {
  if [[ "$remove_image" == 1 ]]; then
    private docker image rm "$image" >/dev/null 2>&1 || true
  fi
  rm -rf -- "$work"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

mkdir "$work/home" "$work/source" "$stage"
checkout_git archive --format=tar "$revision" | tar -xf - -C "$work/source"
cd "$work/source"

# Use the dedicated VM's Docker daemon and retain its local BuildKit cache between runs.
security_options=$(private docker info --format '{{json .SecurityOptions}}')
jq -e 'index("name=rootless") != null' <<< "$security_options" >/dev/null \
  || fail 'Atlas build requires a dedicated rootless Docker daemon.'
remove_image=1
private docker buildx build --builder default --platform linux/amd64 --load \
  --provenance=false --sbom=false \
  --tag "$image" --label "org.opencontainers.image.revision=$revision" \
  --build-arg QUANTSELF_SKIP_NEXT_TYPECHECK=1 . >&2
private docker image inspect "$image" \
  --format '{"size":{{.Size}},"architecture":{{json .Architecture}},"os":{{json .Os}},"revision":{{json (index .Config.Labels "org.opencontainers.image.revision")}}}' \
  > "$stage/image.json"
jq -e --arg revision "$revision" '
  .os == "linux" and .architecture == "amd64" and .revision == $revision
  and (.size | type == "number" and . > 0)
' "$stage/image.json" >/dev/null || fail 'Built image has unexpected platform, revision or size.'

private bash scripts/ci/image-size.sh "$image" >&2
private bash scripts/ci/smoke-image.sh "$image" "$revision" >&2
private docker save "$image" | gzip -1 > "$stage/image.tar.gz"

python3 -B - "$stage" "$output" <<'PY'
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import tarfile

stage, output = map(Path, sys.argv[1:])
sys.path.insert(0, str(Path.cwd() / "scripts/infra/keep-storage"))
from backup_guest import verify_docker_archive


def archive_config_id(path):
    # Docker's containerd image store may report an index ID from image inspect.
    with tarfile.open(path, mode="r|gz") as archive:
        for member in archive:
            if PurePosixPath(member.name) != PurePosixPath("manifest.json"):
                continue
            if not member.isfile() or member.size > 65536:
                break
            rows = json.load(archive.extractfile(member))
            if not isinstance(rows, list) or len(rows) != 1 or not isinstance(rows[0], dict):
                break
            config = rows[0].get("Config")
            if isinstance(config, str):
                match = re.fullmatch(r"blobs/sha256/([0-9a-f]{64})|([0-9a-f]{64})\.json", config)
                if match:
                    return "sha256:" + (match[1] or match[2])
            break
    sys.exit("Expected one Docker archive image with a digest-addressed config.")


archive = stage / "image.tar.gz"
image_id = archive_config_id(archive)
verify_docker_archive(archive, image_id)
metadata = stage / "image.json"
record = json.loads(metadata.read_text())
record["id"] = image_id
metadata.write_text(json.dumps(record) + "\n")
with (stage / "SHA256SUMS").open("wb") as sums:
    subprocess.run(["sha256sum", archive.name, metadata.name], cwd=stage, stdout=sums, check=True)
if os.path.lexists(output):
    sys.exit("Output directory already exists.")
os.rename(stage, output)
PY
printf '%s\n' "$output"
