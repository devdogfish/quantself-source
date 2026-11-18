#!/bin/bash
# Run in a disposable Debian amd64 container with networking disabled.
set -euo pipefail
[[ -f /.dockerenv && $(uname -m) == x86_64 && $(stat -f -c %T /scratch) == tmpfs ]]
# shellcheck source=/dev/null
source /launcher.sh

runner_install=$(mktemp -d /opt/relay-template-fixture.XXXXXXXX)
scratch=$(mktemp -d /scratch/relay-runtime.XXXXXXXX)
trap 'rm -rf -- "$runner_install" "$scratch"' EXIT
runner_archive=$runner_install/runner.tar.gz
runner_template=$runner_install/template
runtime=$scratch/job
install -m 0644 /runner.tar.gz "$runner_archive"
chmod 0755 "$runner_install" "$scratch"

as_runner() {
  setpriv --no-new-privs --reuid=65534 --regid=65534 --clear-groups "$@"
}

elapsed_ms() {
  local start finish
  start=$(date +%s%N)
  "$@" >&2 || return
  finish=$(date +%s%N)
  printf '%s' "$(( (finish - start) / 1000000 ))"
}

expect_worker() {
  [[ $(select_worker) == "$1" ]]
}

materialize_as_runner() {
  # shellcheck disable=SC2016 # Positional parameters belong to the worker shell.
  as_runner bash -ec '
    source /launcher.sh
    runner_archive=$1 runner_template=$2 runtime=$3
    materialize_runner "$4"
  ' fixture "$runner_archive" "$runner_template" "$runtime" "$1"
}

exercise_admission() {
  local marker=$runner_template/source-sha256
  expect_worker --worker-template

  mv "$marker" "$marker.exact"
  printf '%064d\n' 0 > "$marker"
  expect_worker --worker
  mv "$runner_archive" "$runner_archive.exact"
  printf '%s\n' 'wrong archive' > "$runner_archive"
  if select_worker >/dev/null; then return 1; fi
  mv -f "$runner_archive.exact" "$runner_archive"
  rm "$marker"
  ln -s source-sha256.exact "$marker"
  expect_worker --worker
  rm "$marker"
  mv "$marker.exact" "$marker"

  local link=$runner_template/runner/fixture-escape
  ln -s /etc/passwd "$link"
  expect_worker --worker
  rm "$link"

  ln -s ../source-sha256 "$link"
  expect_worker --worker
  rm "$link"

  mv "$runner_template" "$runner_template.exact"
  ln -s template.exact "$runner_template"
  expect_worker --worker
  rm "$runner_template"
  mv "$runner_template.exact" "$runner_template"
  expect_worker --worker-template

  if as_runner touch "$runner_template/runner/.unexpected-write" 2>/dev/null; then return 1; fi
  if as_runner test -w "$runner_template/runner/run.sh"; then return 1; fi
  if (prepare_template >/dev/null 2>&1); then return 1; fi
  printf '%s\n' 'PASS stale digest, archive mismatch, symlinks, write denial and no replacement'
}

prepare_ms=$(elapsed_ms prepare_template)
printf 'prepare_ms=%s\n' "$prepare_ms"
exercise_admission
printf 'template_kib=%s\n' "$(du -sk "$runner_template" | cut -f1)"
printf 'trial path selection_ms materialize_ms listener_version\n'

for trial in 1 2 3 4 5; do
  paths=(extract copy)
  if (( trial % 2 == 0 )); then paths=(copy extract); fi
  for path in "${paths[@]}"; do
    rm -rf -- "$runtime"
    install -d -m 0700 -o 65534 -g 65534 "$runtime"

    if [[ $path == extract ]]; then
      mv "$runner_template" "$runner_template.exact"
      selection_ms=$(elapsed_ms expect_worker --worker)
      mv "$runner_template.exact" "$runner_template"
      materialize_ms=$(elapsed_ms materialize_as_runner --worker)
      tree=$runtime
    else
      selection_ms=$(elapsed_ms expect_worker --worker-template)
      materialize_ms=$(elapsed_ms materialize_as_runner --worker-template)
      tree=$runtime/runner
      test "$(stat -c %a "$runtime")" == 700
      test "$(stat -c %u "$tree/bin/Runner.Listener")" == 65534
      if materialize_as_runner --worker-template >/dev/null 2>&1; then exit 1; fi
    fi

    version=$(cd "$tree" && as_runner env -i PATH=/usr/bin:/bin HOME="$runtime" \
      DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1 ./bin/Runner.Listener --version)
    test "$version" == 2.338.2
    cmp "$tree/bin/Runner.Listener" "$runner_template/runner/bin/Runner.Listener"
    test ! -e "$tree/.job-state"
    as_runner touch "$tree/.job-state"
    test ! -e "$runner_template/runner/.job-state"
    printf '%s %s %s %s %s\n' "$trial" "$path" "$selection_ms" "$materialize_ms" "$version"
  done
done
