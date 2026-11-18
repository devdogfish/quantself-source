#!/usr/bin/env bash
set -euo pipefail
set +x
umask 077

hermes_version=v0.23.1
hermes_commit=3b421578588243f920886e6fe79a6faa87ea026e
# The Honcho memory provider pinned in this Hermes release's plugin catalog.
honcho_commit=894b88321872e01702a1aa638ddfdde6ad60f173
honcho_source=https://github.com/plastic-labs/honcho.git#hermes-plugin-honcho
libexec=/usr/local/libexec/quantself-agent
vault_client=/usr/local/libexec/quantself-vaultwarden-keys

die() { printf '%s\n' "$*" >&2; exit 1; }

role_dir=${1:?Run the install.sh for the intended Agent}
shift
[[ $# == 1 ]] || die "Usage: $role_dir/install.sh SITE.json"
[[ $(uname -s) == Linux && $EUID == 0 && -d /run/systemd/system ]] ||
  die "Run as root on the dedicated systemd Linux Agent host"
role=${role_dir##*/}
shared=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo=$(cd -- "$shared/../.." && pwd)

missing_tools=()
for tool in bun curl flock git python3 runuser systemctl tailscale bw \
  Xvfb xauth xdpyinfo openbox chromium x11vnc websockify socat; do
  command -v "$tool" >/dev/null || missing_tools+=("$tool")
done
(( ${#missing_tools[@]} == 0 )) || die "Required commands missing: ${missing_tools[*]}"
[[ -x "$vault_client" ]] || die "The #376 Vaultwarden service client is required at $vault_client"

account=$(getent passwd hermes) || die "Create the dedicated locked hermes account first"
IFS=: read -r _ _ _ _ _ account_home _ <<< "$account"
[[ -d "$account_home" ]] || die "The hermes account needs an existing home directory"

install -d -o root -g root -m 0700 -- /run/quantself-agent-install
exec 9>/run/quantself-agent-install/lock
flock -n 9 || die "An Agent install is already in progress"
stage=$(mktemp -d)
trap 'rm -rf -- "$stage"' EXIT
python3 "$shared/render.py" "$role" "$1" "$account_home" "$stage"
grep -Fxq "$(cat "$stage/api-host")" < <(tailscale ip -4) ||
  die "api_host is not assigned to this machine by Tailscale"

managed=/etc/hermes
[[ ! -e "$managed/quantself-agent" || $(cat "$managed/quantself-agent") == "$role" ]] ||
  die "This host is already configured for a different Agent"

as_hermes() {
  runuser -u hermes -- env HERMES_HOME="$profile" HERMES_MANAGED_DIR="$managed" GIT_TERMINAL_PROMPT=0 "$@"
}

write_as_hermes() {
  # Expand the temporary path in the unprivileged shell.
  # shellcheck disable=SC2016
  as_hermes bash -c '
    set -e
    tmp=$(mktemp -- "$1.XXXXXX")
    trap '\''rm -f -- "$tmp"'\'' EXIT
    cat > "$tmp"
    chmod 0600 "$tmp"
    mv -fT -- "$tmp" "$1"
  ' _ "$1" < "$2"
}

profile=$account_home/.hermes
source_dir=$profile/hermes-agent
hermes=$source_dir/.hermes/bin/hermes
as_hermes mkdir -p -- "$profile/skills" "$account_home/workspace"
as_hermes touch -- "$profile/.no-bundled-skills"

bootstrap_completed() {
  as_hermes python3 -B - "$source_dir/.hermes-bootstrap-complete" "$hermes_commit" <<'PY'
import json
from pathlib import Path
import sys

try:
    receipt = json.loads(Path(sys.argv[1]).read_text())
except (OSError, ValueError):
    sys.exit(1)

sys.exit(not (isinstance(receipt, dict) and receipt.get("schemaVersion") == 1
              and receipt.get("pinnedCommit") == sys.argv[2]))
PY
}

installed_commit=$(as_hermes git -C "$source_dir" rev-parse HEAD 2>/dev/null || true)
if [[ "$installed_commit" != "$hermes_commit" || ! -x "$hermes" ]] || ! bootstrap_completed; then
  curl --fail --silent --show-error --location --proto '=https' \
    "https://raw.githubusercontent.com/NousResearch/hermes-agent/$hermes_commit/scripts/install.sh" \
    -o "$stage/hermes-install.sh"
  as_hermes bash -s -- --commit "$hermes_commit" --dir "$source_dir" \
    --hermes-home "$profile" --non-interactive < "$stage/hermes-install.sh"
fi
[[ $(as_hermes git -C "$source_dir" rev-parse HEAD) == "$hermes_commit" ]] ||
  die "Hermes checkout does not match $hermes_commit"
bootstrap_completed || die "Hermes bootstrap did not complete for $hermes_commit"
version=$(as_hermes "$hermes" --version </dev/null)
[[ "$version" == "Hermes Agent $hermes_version "* ]] ||
  die "Hermes CLI does not report $hermes_version"

as_hermes "$hermes" plugins install "$honcho_source" --ref "$honcho_commit" \
  --force --enable --yes-deps </dev/null

# The CLI has no external imports. Build from this checkout without installing repo dependencies.
(cd -- "$stage" && bun build --compile "$repo/packages/cli/src/index.ts" --outfile "$stage/quantself")
as_hermes cp -aT -- "$source_dir/skills/note-taking/obsidian" "$profile/skills/obsidian"
as_hermes cp -aT -- "$source_dir/optional-skills/research/llm-wiki" "$profile/skills/llm-wiki"
tar -C "$repo/.codex/skills" -cf - quantself-cli | as_hermes tar -C "$profile/skills" -xf -
write_as_hermes "$profile/SOUL.md" "$role_dir/SOUL.md"

install -d -o root -g root -m 0755 -- "$managed" "$libexec"
install -d -o root -g root -m 0755 -- "$managed/plugins/quantself-vaultwarden"
install -o root -g root -m 0644 -- "$repo/agents/vaultwarden/plugin/__init__.py" \
  "$repo/agents/vaultwarden/plugin/plugin.yaml" "$managed/plugins/quantself-vaultwarden/"
as_hermes mkdir -p -- "$profile/plugins/quantself-vaultwarden"
write_as_hermes "$profile/plugins/quantself-vaultwarden/__init__.py" "$managed/plugins/quantself-vaultwarden/__init__.py"
write_as_hermes "$profile/plugins/quantself-vaultwarden/plugin.yaml" "$managed/plugins/quantself-vaultwarden/plugin.yaml"
if [[ "$role" == sam ]]; then
  install -d -o root -g root -m 0755 -- "$managed/plugins/quantself-jobs-mail"
  install -o root -g root -m 0644 -- "$role_dir/jobs-mail/plugin/__init__.py" \
    "$role_dir/jobs-mail/plugin/plugin.yaml" "$managed/plugins/quantself-jobs-mail/"
  as_hermes mkdir -p -- "$profile/plugins/quantself-jobs-mail"
  write_as_hermes "$profile/plugins/quantself-jobs-mail/__init__.py" "$managed/plugins/quantself-jobs-mail/__init__.py"
  write_as_hermes "$profile/plugins/quantself-jobs-mail/plugin.yaml" "$managed/plugins/quantself-jobs-mail/plugin.yaml"
fi
install -o root -g root -m 0755 -- "$shared/vault.py" "$shared/draft.py" "$shared/screen.py" "$libexec/"
install -o root -g root -m 0644 -- "$shared/seed-profile.py" "$libexec/"
install -o root -g root -m 0755 -- "$stage/quantself" /usr/local/bin/quantself
install -o root -g root -m 0644 -- "$stage/config.yaml" "$stage/.env" \
  "$stage/agent-profile.yaml" "$stage/honcho.json" "$managed/"
hermes_python=$(
  as_hermes "$hermes" --print-runtime-command |
    python3 -c 'import json, sys; print(json.load(sys.stdin)[0])'
)
# The plugin installer can drop managed keys from the local profile on a repeat install.
as_hermes env HERMES_DISABLE_LAZY_INSTALLS=1 "$hermes_python" -BI \
  "$libexec/seed-profile.py" "$source_dir" "$profile/config.yaml" \
  < "$stage/agent-profile.yaml"
# Bootstrap selects dependencies from the restored configuration in this fresh process.
as_hermes "$hermes_python" -BI -c '
import sys
sys.path.insert(0, sys.argv[1])
import hermes_bootstrap
try:
    from honcho import Honcho
except ImportError:
    sys.exit("Hermes could not load the Honcho SDK")
' "$source_dir"
write_as_hermes "$profile/honcho.json" "$stage/honcho.json"
printf '%s\n' "$role" > "$stage/quantself-agent"
install -o root -g root -m 0644 -- "$stage/quantself-agent" "$managed/"
install -o root -g root -m 0644 -- "$stage/hermes-gateway.service" "$stage/hermes-screen.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable hermes-gateway.service
printf 'Configured %s with Hermes %s. Complete the Owner sign-in and rollout checks before starting the gateway.\n' "$role" "$hermes_version"
