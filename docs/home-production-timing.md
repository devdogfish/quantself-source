# Measure Keep promotions for #300

Reuse the [accepted staging evidence](https://github.com/devdogfish/quantself/issues/352#issuecomment-6903689913) for the exact images it covers. Its 1,698 probes, 21.62 s promotion and 13.04 s rollback do not count as production samples. The ingress bootstrap was a separate operation. Update the [acceptance ledger](home-production-blue-green-rehearsal.md#acceptance-ledger) under the [session rules](agents/infrastructure-sessions.md).

## Evidence audit, November 17

**0 of 5 qualifying samples in the reviewed evidence.** A sample needs the actual launch time, first confirmed response from the exact candidate, and continuous production probes across the switch.

| Evidence | What it measured |
| --- | --- |
| [#209 production cutover](https://github.com/devdogfish/quantself/issues/209#issuecomment-6898372932) and [job timestamps](https://github.com/devdogfish/quantself/actions/runs/43738322042/job/132885756066) | 81 s from GitHub run creation to job completion, 75 s in the deploy job, 62 s in its SSH step. No operator start stamp, first candidate response timestamp, or continuous switch probe series in the reviewed record. |
| [Atlas control runs](https://github.com/devdogfish/quantself-atlas-control/actions/workflows/promote-keep.yml) | 11 successful relay acknowledgments for 11 requested source SHAs. Original dispatch creation to run-level completion update ranged from 70–504 s, and the successful SSH steps took 48–483 s. These intervals include work beyond the first live response. Run `44089866904` succeeded on attempt 2, with 52 s in SSH. The failed first attempt is separate. |
| [#371 release confirmation](https://github.com/devdogfish/quantself/issues/371#issuecomment-6949528986) | Run `44097585764` has a verified staged digest and post-release app/API and health checks. GitHub records 84 s from dispatch creation to completion update and 52 s in SSH. The record has no command start, first live timestamp, or continuous probe series. |
| [#300 loopback](https://github.com/devdogfish/quantself/issues/300#issuecomment-6898937086) and [#352 staging](https://github.com/devdogfish/quantself/issues/352#issuecomment-6903174033) | 332 loopback probes and 1,278 staging probes had zero unexpected responses. The later #352 staging run had 1,698 passing probes. The production ingress bootstrap saw one TLS handshake failure in 107 probes and did not promote a release. |

Five Atlas runs waited **138–221 s from dispatch creation to the SSH step start**. For a fresh switch requiring that step, this is a lower bound on dispatch to live. Each would exceed both budgets if it were a classified sample and the command or push preceded dispatch. The evidence does not establish those classifications or continuity. [44008825826](https://github.com/devdogfish/quantself-atlas-control/actions/runs/44008825826) · [43970866607](https://github.com/devdogfish/quantself-atlas-control/actions/runs/43970866607) · [44052959955](https://github.com/devdogfish/quantself-atlas-control/actions/runs/44052959955) · [44082222248](https://github.com/devdogfish/quantself-atlas-control/actions/runs/44082222248) · [43796412245](https://github.com/devdogfish/quantself-atlas-control/actions/runs/43796412245)

### Where the relay waited

GitHub's attempt and job timestamps locate almost all of the five delays before the relay job started. The recorded SSH start is the beginning of the workflow step, before its local setup and pinned SSH connection.

| Control run | Dispatch creation → job creation | Job creation → job start | Job start → SSH step | SSH step to completion |
| --- | ---: | ---: | ---: | ---: |
| [44008825826](https://github.com/devdogfish/quantself-atlas-control/actions/runs/44008825826/job/133790607346) | 1 s | 136 s | 1 s | 50 s |
| [43970866607](https://github.com/devdogfish/quantself-atlas-control/actions/runs/43970866607/job/133662360892) | 2 s | 143 s | 1 s | 110 s |
| [44052959955](https://github.com/devdogfish/quantself-atlas-control/actions/runs/44052959955/job/133935076175) | 2 s | 145 s | 1 s | 99 s |
| [44082222248](https://github.com/devdogfish/quantself-atlas-control/actions/runs/44082222248/job/134035428828) | 2 s | 150 s | 1 s | 196 s |
| [43796412245](https://github.com/devdogfish/quantself-atlas-control/actions/runs/43796412245/job/133066135473) | 2 s | 218 s | 1 s | 103 s |
| [43978946831, faster comparison](https://github.com/devdogfish/quantself-atlas-control/actions/runs/43978946831/job/133690098730) | 1 s | 17 s | 1 s | 48 s |

`bun run prod` checks clean canonical main, dispatches once, prints the returned run ID and watches it. The separate Mac provisioning command checks repository identity, reads five policy and job endpoints concurrently, validates the exact queued attempt, and issues its one-job runner. It then connects to the existing relay guest and waits for assignment to that exact runner. The guest launcher checks the archive, starts the restricted systemd worker, and acknowledges before the worker necessarily finishes extraction or connects to GitHub. The provisioning command contains no VM boot operation. The 136–218 s intervals combine those pre-job stages and any operator wait. GitHub's records do not split operator delay, guest boot, extraction, registration, or time spent waiting for assignment after runner registration. [Relay procedure](home-production-deploy.md#run-one-queued-relay)

The smallest path toward 40 s is a bounded automatic handoff from the exact dispatch response to the existing Mac JIT provisioner, with the isolated relay guest already reachable for the approved release window and the exact signed image staged on Keep. The offline-qualified opt-in handoff waits briefly for the job to materialize and retries only an absent job under the authenticated run identity. It must stop on an ineligible job and preserve the protected GitHub workflow, one-job runner label, pinned SSH, and Keep release admission. A warm guest can still start a fresh runner only when its exact job is queued. The 19 s comparison leaves at most 21 s for CLI time before dispatch, Keep admission, the actual switch and external confirmation. This budget needs end-to-end measurement. The SSH step includes verification, drain and final handoff, so its full duration does not supply the first-live endpoint. The just-pushed path also needs verification, building and staging inside its 120 s budget. [Staging reference](https://github.com/devdogfish/quantself/issues/352#issuecomment-6903689913)

Automatic handoff already enables `--timing`. The Mac capture below saves `provision_started`, `admitted`, `runner_issued`, `launcher_acknowledged` and `assignment_observed` for the exact run and attempt on the Mac monotonic clock. The dispatch observation includes output handling delay. Assignment is observed by polling and can come after job start. Record any cold guest boot separately. Keep admission starts once the workflow connects to Keep. The relay launch receipt joins guest selection and materialization to that attempt. Keep's separate receipt joins the same attempt to the switch. Subtract only timestamps from the same clock.

### Offline runner preparation comparison

The deployed launcher hashes the pinned compressed archive before acknowledging startup and extracts it for each job. The opt-in candidate verifies and extracts that archive once into a root-owned template, then copies it as the service UID into a fresh private job directory. The disposable fixture uses the candidate's actual preparation, selection and materialization code. It checks fallback on a stale digest and unsafe links, rejection when neither source is valid, runner write denial, pinned listener version, and fresh copies without prior job state.

With the [pinned runner archive](home-production-deploy.md#prepare-the-independent-atlas-relay-guest) at an absolute `runner_archive` path and the Debian amd64 image already local, run from the repo root:

```sh
docker run --rm --pull=never --network none --platform linux/amd64 \
  --tmpfs /scratch:exec,size=1g \
  --mount "type=bind,src=$runner_archive,dst=/runner.tar.gz,readonly" \
  --mount "type=bind,src=$PWD/scripts/infra/home-production/bench-relay-runner-materialization.sh,dst=/bench.sh,readonly" \
  --mount "type=bind,src=$PWD/scripts/infra/home-production/quantself-atlas-control-jit,dst=/launcher.sh,readonly" \
  debian:13-slim bash /bench.sh
```

Five paired runs of the exact launcher on Debian 13 amd64 under Docker on the ARM Mac measured median selection plus materialization of **5.08 s** for verified extraction and **1.16 s** for template validation and copy. Preparing the template once took **6.70 s** and consumed about 682 MiB of disk. Each job still needs its private writable copy and an ephemeral Actions runner. Template preparation needs no persistent process.

This test ends at `Runner.Listener --version` and supplies zero production samples. All **136–218 s** of historical job-creation-to-start time remain unassigned by stage. The local savings cannot be subtracted from those records. On native Atlas, use the exact-attempt timing flow below and capture the guest's archive extraction or template copy markers to quantify the effect after automatic handoff.

### Approved production capture

Run in a separately approved window after the [Atlas control path](home-production-deploy.md#atlas-production-control-relay) is admitted. Keep one run in flight, with no unrelated reloads or maintenance. Record source SHA, image config digest, prior SHA and digest, slots, readiness approval, and exact control repo/run/attempt. Use the Owner Mac with Python 3.10+, Bash, curl, jq and the existing pinned Owner SSH alias to Keep.

## Probe before, during and after the switch

Create a private evidence directory outside any checkout. Set `evidence` to its absolute path in each terminal. Save as `probe.sh` there:

```bash
#!/usr/bin/env bash
set -uo pipefail
origin="${ORIGIN:-https://qs.girke.dev}"
clock() { python3 -c 'import time; print(time.monotonic_ns() // 1000)'; }
probe() {
  local name="$1" method="$2" path="$3" expected="$4"
  local start end result status rc=0 verdict=ok
  start="$(clock)" || return 2
  if [[ "$name" == api ]]; then
    result="$(curl -q -s --noproxy '*' --max-time 2 -X "$method" -w '\n%{http_code}' "$origin$path")" || rc=$?
    status="${result##*$'\n'}"
    if (( rc == 0 )) && [[ "$status" == "$expected" ]]; then
      jq -e '.service == "quantself-api" and .status == "ok"' >/dev/null 2>&1 \
        <<< "${result%$'\n'*}" || verdict=fail
    fi
  else
    status="$(curl -q -s --noproxy '*' --max-time 2 -X "$method" -w '%{http_code}' -o /dev/null "$origin$path")" || rc=$?
  fi
  end="$(clock)" || return 2
  [[ "$status" =~ ^[0-9]{3}$ ]] || status=000
  [[ "$rc:$status" == "0:$expected" ]] || verdict=fail
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$name" "$start" "$end" "$rc" "$status" "$verdict"
  [[ "$verdict" == ok ]]
}
case "${1:-}" in
  web) args=(web GET /favicon.ico 200) ;;
  api) args=(api GET /api/health 200) ;;
  deny) args=(deny POST /api/internal/jobs/runner/heartbeat 404) ;;
  *) exit 2 ;;
esac
if [[ "${2:-}" == once ]]; then probe "${args[@]}"; exit $?; fi
while :; do
  probe "${args[@]}" || { [[ $? == 1 ]] || exit 2; }
  sleep 0.25
done
```

Start these in three separate terminals (umask 077 in each):

```bash
bash "$evidence/probe.sh" web  > "$evidence/web.tsv"
bash "$evidence/probe.sh" api  > "$evidence/api.tsv"
bash "$evidence/probe.sh" deny > "$evidence/deny.tsv"
```

Require a clean baseline; use a source where ingress denies the Jobs lane. A 401 on that lane fails the sample: it can indicate the request reached the upstream. These probes use no credentials, redirects or retries. Keep authenticated Jobs, database reads through the application and held responses as separate checks where approved. A known page redirect in staging does not change the favicon expectation.

## Time the exact launch and confirm the release

In a fourth Mac terminal running Bash, set `keep` to the reviewed Owner SSH alias. The staged Keep broker must emit `Atlas promotion receipt` after a fresh successful claim. Capture a cursor before launching. The observer matches that receipt and the switch by Keep boot and systemd invocation. The checker normalizes the dashed kernel boot UUID and compact journal ID before comparison. [Journal field formats](https://www.freedesktop.org/software/systemd/man/latest/systemd.journal-fields.html#_BOOT_ID=)

```bash
umask 077
set -o pipefail
ssh -T "$keep" 'cat /proc/sys/kernel/random/boot_id' > "$evidence/boot-id" || exit 1
cursor="$(ssh -T "$keep" 'sudo -n journalctl -b -n 1 -o json --no-pager --output-fields=__CURSOR | jq -er .__CURSOR')" || exit 1
[[ "$cursor" =~ ^[a-zA-Z0-9\;=:_-]+$ ]] || exit 1
ssh -T "$keep" "sudo -n journalctl -b --after-cursor='$cursor' --no-tail --follow -o json --no-pager --output-fields=MESSAGE,_SYSTEMD_UNIT,_SYSTEMD_INVOCATION_ID --grep='^(Keep ingress switched to (blue|green|legacy)\.|Atlas promotion receipt [0-9]+ [0-9]+ [0-9]+ [0-9a-f]{40} sha256:[0-9a-f]{64})$'" |
  jq --unbuffered -rc 'select(._SYSTEMD_UNIT | (. // "") | test("^quantself-atlas-deploy@.+\\.service$")) |
    (.MESSAGE | split(" ")) as $words |
    {invocation: ._SYSTEMD_INVOCATION_ID, boot: ._BOOT_ID, keep_us: .__MONOTONIC_TIMESTAMP} +
    (if $words[0] == "Keep" then {kind:"switch", slot:($words[4]|rtrimstr("."))}
     else {kind:"receipt", repo_id:$words[3], run_id:$words[4], attempt:$words[5],
           source_sha:$words[6], image_id:$words[7]} end)' |
  while IFS= read -r marker; do
    observed="$(python3 -c 'import time; print(time.monotonic_ns() // 1000)')" || exit 1
    case "$(jq -r .kind <<< "$marker")" in
      switch)
        printf '%s\t%s\n' "$observed" "$marker" >> "$evidence/switch.tsv"
        for probe in web api deny; do bash "$evidence/probe.sh" "$probe" once >> "$evidence/confirm.tsv"; done
        ;;
      receipt) printf '%s\t%s\n' "$observed" "$marker" >> "$evidence/receipt.tsv" ;;
      *) exit 1 ;;
    esac
  done
printf '%s\n' 'Observer stream ended; check coverage before accepting a sample.' >&2
```

The marker follows Caddy reload and the broker's first pinned TLS smoke. Start from clean canonical main with the [approved automatic handoff settings](home-production-deploy.md#automatic-handoff-candidate), including `QUANTSELF_ATLAS_RELAY_AUTO=1`. The filter displays ordinary CLI output and saves only timing markers.

```bash
umask 077
set -o pipefail
export QUANTSELF_DEPLOY_CONTROL_REPO=devdogfish/quantself-atlas-control
python3 -c '
import os, sys, time
with open(sys.argv[1], "x") as f:
    f.write(f"{time.monotonic_ns() // 1000}\n")
os.execvp("bun", ["bun", "run", "prod"])
' "$evidence/command-us" 2>&1 | while IFS= read -r line; do
  printf '%s\n' "$line"
  case "$line" in
    'Starting the exact Atlas relay for production deploy run '*)
      (set -o noclobber
       observed="$(python3 -c 'import time; print(time.monotonic_ns() // 1000)')" &&
       printf '%s\t%s\n' "$observed" "$line" > "$evidence/dispatch-observed.tsv") || exit 1
      ;;
    'Atlas relay timing: '*)
      printf '%s\n' "${line#Atlas relay timing: }" >> "$evidence/relay-timing.jsonl" || exit 1
      ;;
    'Atlas timing attempt: '*)
      (set -o noclobber
       printf '%s\n' "${line#Atlas timing attempt: }" > "$evidence/attempt.json" &&
       python3 -c 'import time; print(time.monotonic_ns() // 1000)' > "$evidence/handoff-observed-us") || exit 1
      ;;
  esac
done
```

When log following starts, Ctrl-C detaches. Keep probes running until every lane has at least five additional successful samples after both the CLI acknowledgment and the Keep receipt. Reconcile failed or ambiguous attempts against the original run and broker journal before another dispatch.

For guest timings, use the pinned relay admin SSH alias. The forced launcher alias is only for launching the one-job runner. This read retrieves just the worker markers for the launch ID in the Mac receipt:

```bash
umask 077
launch_id="$(jq -ser '[.[] | select(.phase == "launcher_acknowledged") | .launch_id] |
  select(length == 1) | .[0] | select(type == "string" and test("^[0-9a-f]{32}$"))' "$evidence/relay-timing.jsonl")" || exit 1
[[ $launch_id =~ ^[0-9a-f]{32}$ ]] || exit 1
(
  capture="$(mktemp "$evidence/.relay-worker.XXXXXX")" || exit 1
  trap 'unlink "$capture"' EXIT
  ssh -T "$relay_admin" "sudo -n journalctl -u quantself-atlas-control-jit.service --no-pager -o json --output-fields=MESSAGE,_SYSTEMD_UNIT,_SYSTEMD_INVOCATION_ID --grep='^Atlas relay worker timing: $launch_id '" > "$capture" || exit 1
  jq -es 'length == 2 and all(.[]; type == "object")' "$capture" >/dev/null || exit 1
  ln "$capture" "$evidence/relay-worker.jsonl"
)
```

An interrupted read or incomplete response leaves any existing capture in place. If the full checker rejects a saved worker capture, move it aside for inspection before repeating this read. Keep the original launch and probe records.

The checker reports the Mac offsets and guest preparation durations separately. An older launcher can supply Mac offsets alone. A capture claiming guest preparation needs both worker markers and one matching launch receipt. Dispatch and assignment observations are upper bounds. They can be observed later than their next underlying phase.

For a just-pushed sample, capture the same timestamp in `push-us` immediately before the approved push. After capture, check the local evidence without contacting Keep:

```bash
python3 scripts/infra/home-production/summarize-live-timing.py "$evidence"
```

The checker attaches the exact attempt, source, digest and switch invocation. It reports the confirmed-live upper bound and each lane's attempt count, failures, and largest gap. The CLI acknowledgment and SSH observer can arrive in either order on the Mac. Within the same Keep boot and invocation, the journal orders the switch before the receipt. Exit 1 means a failed probe. Exit 2 means incomplete evidence, including a silent idle gap over one second in any lane. Each lane runs one credential-free request at a time with a two-second timeout and a quarter-second pause. Verify the live ingress and app/API identities independently before counting a sample.

Require exactly one switch marker after launch, the expected boot/invocation, and a successful exact run/attempt and broker receipt. Confirm the marker's slot was initially inactive, then active with no pending recovery. Verify the live ingress upstreams target it, and both app and API container image IDs and revision label match the approved release. On Keep, resolve names and ports as in [the promotion script](../scripts/promote-home.sh); use Docker inspect format for only `.Image` and the OCI revision label, and inspect only route targets. Do not save raw Docker config, private environment files, Caddy config, or response bodies. A no-op, replay, overlapping switch, automatic recovery or lost observer stream cannot count.

- **Command to confirmed live**: subtract `command-us` from the last completion in the three successful confirmation rows, then divide by 1,000,000. All three must start after the one marker. This is an upper bound including journal transport and external probe latency. Also report command to marker receipt. Ordinary API health has no revision; the slot/digest/attempt checks bind the responses to the exact release.
- **Prebuilt**: exact candidate built, verified, staged and admitted before launch. ≤40 s for each measured bound demonstrates the target. A bound above 40 s cannot by itself establish when the switch actually happened.
- **Just pushed**: save the same Mac clock before the approved push. Record push acknowledgement, readiness and actual command launch separately. Report push start to confirmed live against 120 s, including verification, build, staging and any approval wait. `bun run prod` dispatches immediately and does not wait for missing readiness. If safe immediate launch is unsupported, report that explicitly; a later staged launch is a separate measurement.
- **Continuity**: count attempts and all failures by lane across the entire window. Include first start, last completion and largest gap between starts. Preserve timeouts, TLS/network errors, unexpected statuses and invalid bodies even if later samples succeed. Zero failures applies to these sampled requests.
- **Breakdown**: record queue/runner wait, admission, readiness, switch, drain and full handoff separately where timestamps exist. Subtract only timestamps from the same clock. Report at least five distinct successful production promotions across both timing classes. Record Atlas idle CPU/RAM separately.

## Same-database rollback evidence

The staged `scripts/promote-home.sh rollback` targets the retained prior slot, but the [current protected Atlas workflow](../scripts/infra/home-production/promote-keep.yml) accepts only `source_sha` promotion. Before a production rollback drill, review and approve a protected Actions invocation binding the intended prior SHA, digest and slot under the existing production lock. Do not substitute manual root execution, reset main or restore a database to make a timing sample.

Once that route is approved, repeat the probes and capture exact launch, switch and completion using its journal unit. Verify pre/post ingress targets and the exact app/API digests. On approved Keep, capture the database container ID, data volume and SQL system identifier before promotion, post-promotion and after rollback:

```bash
sudo -n docker inspect -f '{{.Id}} {{range .Mounts}}{{if eq .Destination "/var/lib/postgresql"}}{{.Name}}{{end}}{{end}}' quantself-postgres
sudo -n docker exec -i quantself-postgres sh -ec \
  'exec psql -XqAt -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL'
BEGIN READ ONLY;
SELECT system_identifier FROM pg_control_system();
SELECT count(*), md5(string_agg(migration_name || ':' || checksum, ',' ORDER BY migration_name, checksum))
FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;
ROLLBACK;
SQL
```

Require the post-promotion migration count and fingerprint to match after rollback. Record one approved durable record written through the candidate and read through the previous release after rollback. Keep record contents private. This handoff does not authorize any production write. Pass requires the prior digest on the same database with forward migrations and the recorded write intact.
