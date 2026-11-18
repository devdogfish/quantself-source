"""Summarize one captured #300 timing window. This tool makes no requests."""

from dataclasses import dataclass
import json
from pathlib import Path
import re
import sys


EXPECTED_STATUS = {"web": 200, "api": 200, "deny": 404}
MAX_PROBE_IDLE_US = 1_000_000
CONTROL_REPO_ID = "1459341623"
HEX_ID = re.compile(r"[0-9a-fA-F]{32}")
DASHED_UUID = re.compile(r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}")


@dataclass(frozen=True)
class Probe:
    lane: str
    start: int
    end: int
    ok: bool


def read_probes(path):
    probes = []
    for line in path.read_text().splitlines():
        lane, start, end, rc, status, verdict = line.split("\t")
        start, end, rc, status = map(int, (start, end, rc, status))
        if not (lane in EXPECTED_STATUS and 0 < start <= end and verdict in ("ok", "fail")):
            raise ValueError(f"Malformed probe in {path.name}")
        probes.append(Probe(lane, start, end, verdict == "ok" and rc == 0 and status == EXPECTED_STATUS[lane]))
    return probes


def read_event(path):
    line, = path.read_text().splitlines()
    observed, payload = line.split("\t", 1)
    return int(observed), json.loads(payload)


def normalize_boot_id(value):
    if not isinstance(value, str) or not (HEX_ID.fullmatch(value) or DASHED_UUID.fullmatch(value)):
        raise ValueError("Malformed journal boot ID")
    return value.replace("-", "").lower()


def journal_micros(value):
    if not isinstance(value, str) or not re.fullmatch(r"[0-9]+", value):
        raise ValueError("Malformed journal monotonic timestamp")
    return int(value)


def summarize_relay(directory, attempt, command, handoff):
    phases = ("provision_started", "admitted", "runner_issued", "launcher_acknowledged", "assignment_observed")
    events = [json.loads(line) for line in (directory / "relay-timing.jsonl").read_text().splitlines()]
    if [event["phase"] for event in events] != list(phases) or any(
        event[key] != attempt[key] for event in events for key in ("run_id", "attempt")
    ):
        raise ValueError("Relay phases do not identify the exact attempt in order")
    stamps = [event["monotonic_us"] for event in events]
    if any(type(stamp) is not int for stamp in stamps) or not command <= stamps[0] <= stamps[-1] <= handoff or stamps != sorted(stamps):
        raise ValueError("Relay phases are outside the Mac command window or out of order")
    metrics = {phase + "_since_command_ms": (stamp - command) / 1000 for phase, stamp in zip(phases, stamps)}
    dispatch_path = directory / "dispatch-observed.tsv"
    if dispatch_path.exists():
        observed, message = dispatch_path.read_text().strip().split("\t", 1)
        dispatch = int(observed)
        if message != f"Starting the exact Atlas relay for production deploy run {attempt['run_id']}, attempt {attempt['attempt']}." or not command <= dispatch <= handoff:
            raise ValueError("Dispatch observation does not identify the exact attempt")
        metrics["dispatch_observed_since_command_ms"] = (dispatch - command) / 1000
    worker_path = directory / "relay-worker.jsonl"
    if worker_path.exists():
        launch = events[3]
        launch_id = launch["launch_id"]
        mode = launch["worker_mode"]
        selection = launch["selection_ms"]
        if not HEX_ID.fullmatch(launch_id) or mode not in ("--worker", "--worker-template") or type(selection) is not int or selection < 0:
            raise ValueError("Invalid relay launcher timing receipt")
        started, finished = [json.loads(line) for line in worker_path.read_text().splitlines()]
        for event, state in ((started, "started"), (finished, "finished")):
            if (event["_SYSTEMD_UNIT"] != "quantself-atlas-control-jit.service"
                    or event["MESSAGE"] != f"Atlas relay worker timing: {launch_id} {mode} {state}"):
                raise ValueError("Worker markers do not match the relay launcher receipt")
        if not (
            HEX_ID.fullmatch(started["_SYSTEMD_INVOCATION_ID"])
            and started["_SYSTEMD_INVOCATION_ID"] == finished["_SYSTEMD_INVOCATION_ID"]
            and normalize_boot_id(started["_BOOT_ID"]) == normalize_boot_id(finished["_BOOT_ID"])
        ):
            raise ValueError("Worker markers do not belong to one relay boot and invocation")
        guest_start = journal_micros(started["__MONOTONIC_TIMESTAMP"])
        guest_finish = journal_micros(finished["__MONOTONIC_TIMESTAMP"])
        if not 0 < guest_start <= guest_finish:
            raise ValueError("Worker markers are outside the relay monotonic window")
        metrics["runner_preparation"] = {
            "mode": "template" if mode == "--worker-template" else "archive",
            "selection_ms": selection,
            "materialization_ms": (guest_finish - guest_start) / 1000,
        }
    return metrics


def summarize(directory):
    command = int((directory / "command-us").read_text())
    handoff = int((directory / "handoff-observed-us").read_text())
    observed, marker = read_event(directory / "switch.tsv")
    receipt_observed, receipt = read_event(directory / "receipt.tsv")
    attempt = json.loads((directory / "attempt.json").read_text())
    boot = normalize_boot_id((directory / "boot-id").read_text().strip())
    if not (
        0 < command <= min(observed, handoff)
        and normalize_boot_id(marker["boot"]) == boot
        and isinstance(marker["invocation"], str) and HEX_ID.fullmatch(marker["invocation"])
        and marker["slot"] in ("blue", "green")
    ):
        raise ValueError("Switch is outside the captured command window or has the wrong identity")
    if not (
        attempt["repo_id"] == CONTROL_REPO_ID and attempt["attempt"] == "1"
        and re.fullmatch(r"[1-9][0-9]{0,19}", attempt["run_id"])
        and re.fullmatch(r"[0-9a-f]{40}", attempt["source_sha"])
        and all(receipt[key] == attempt[key] for key in ("repo_id", "attempt", "run_id", "source_sha"))
        and re.fullmatch(r"sha256:[0-9a-f]{64}", receipt["image_id"])
        and normalize_boot_id(receipt["boot"]) == boot and receipt["invocation"] == marker["invocation"]
        and receipt_observed >= observed and 0 < journal_micros(marker["keep_us"]) <= journal_micros(receipt["keep_us"])
    ):
        raise ValueError("CLI attempt and fresh Keep receipt do not identify the same switch")

    confirmation = read_probes(directory / "confirm.tsv")
    if sorted(probe.lane for probe in confirmation) != sorted(EXPECTED_STATUS):
        raise ValueError("Expected one post-switch confirmation for each lane")
    if any(probe.start < observed for probe in confirmation):
        raise ValueError("Confirmation started before the switch was observed")
    confirmed = max(probe.end for probe in confirmation)

    lanes = {}
    for lane in EXPECTED_STATUS:
        probes = read_probes(directory / f"{lane}.tsv")
        if not (
            probes and probes[0].end <= command and probes[-1].end >= confirmed
            and sum(probe.start >= max(handoff, receipt_observed) for probe in probes) >= 5
            and all(probe.lane == lane for probe in probes)
            and all(first.end <= second.start for first, second in zip(probes, probes[1:]))
        ):
            raise ValueError(f"Incomplete or out-of-order monitor coverage for {lane}")
        max_idle = max(second.start - first.end for first, second in zip(probes, probes[1:]))
        if max_idle > MAX_PROBE_IDLE_US:
            raise ValueError(f"Probe stream idle for more than one second in {lane}")
        lanes[lane] = {
            "attempts": len(probes),
            "failures": sum(not probe.ok for probe in probes),
            "first_start_us": probes[0].start,
            "last_end_us": probes[-1].end,
            "max_start_gap_us": max(second.start - first.start for first, second in zip(probes, probes[1:])),
            "max_idle_us": max_idle,
        }
    confirm_failures = sum(not probe.ok for probe in confirmation)
    result = {
        "release": {key: receipt[key] for key in ("repo_id", "run_id", "attempt", "source_sha", "image_id")},
        "switch_invocation": marker["invocation"],
        "switch_slot": marker["slot"],
        "command_to_marker_receipt_ms": (observed - command) / 1000,
        "command_to_confirmed_live_upper_bound_ms": (confirmed - command) / 1000 if not confirm_failures else None,
        "confirmation_failures": confirm_failures,
        "monitor_lanes": lanes,
    }
    if (directory / "relay-timing.jsonl").exists() or (directory / "relay-worker.jsonl").exists():
        result["relay"] = summarize_relay(directory, attempt, command, handoff)
    push_path = directory / "push-us"
    if push_path.exists():
        push = int(push_path.read_text())
        if not 0 < push <= command:
            raise ValueError("Push start must precede the command on the same clock")
        result["push_to_confirmed_live_upper_bound_ms"] = (confirmed - push) / 1000 if not confirm_failures else None
    return result


def main(argv):
    if len(argv) != 1:
        print("Usage: summarize-live-timing.py EVIDENCE_DIRECTORY", file=sys.stderr)
        return 2
    try:
        result = summarize(Path(argv[0]))
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(f"Incomplete timing evidence: {error}", file=sys.stderr)
        return 2
    print(json.dumps(result, indent=2))
    return int(bool(result["confirmation_failures"] or any(lane["failures"] for lane in result["monitor_lanes"].values())))


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
