#!/usr/bin/env python3
"""Qualify a pinned Roundcube candidate or revalidate it for a disposable cutover."""

import argparse
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
from tempfile import TemporaryDirectory

from roundcube_release_assets import download_selected_assets
from roundcube_reviewed_releases import DEFAULT, STABLE, check_plan, load_review, validate_review


HERE = Path(__file__).resolve().parent
LOCAL_JSON_LIMIT = 16 * 1024


def read_local_json(path):
    # Open the file itself once so replacements cannot race its ownership check.
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, "rb") as source:
        info = os.fstat(source.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid not in (0, os.geteuid())
                or info.st_mode & (stat.S_IWGRP | stat.S_IWOTH)):
            raise ValueError(f"Expected a trusted regular file owned by root or the runner: {path}")
        data = source.read(LOCAL_JSON_LIMIT + 1)
        if len(data) > LOCAL_JSON_LIMIT:
            raise ValueError(f"Local qualification input exceeds {LOCAL_JSON_LIMIT} bytes: {path}")
        return json.loads(data)


def configure_qualification(args):
    path = args.qualification_config
    config = read_local_json(path)
    required = {"installed_manifest", "assets"}
    if (not isinstance(config, dict) or not required <= config.keys()
            or config.keys() - required - {"reviewed_release"}
            or not all(isinstance(value, str) and value for value in config.values())):
        raise ValueError("Expected installed_manifest, assets and optional reviewed_release paths")

    manifest = read_local_json(path.parent / config["installed_manifest"])
    if (not isinstance(manifest, dict) or manifest.keys() != {"version"}
            or not isinstance(manifest["version"], str) or not STABLE.fullmatch(manifest["version"])):
        raise ValueError("Installed manifest must contain one stable Roundcube 1.7 version")
    args.installed = manifest["version"]
    args.assets = path.parent / config["assets"]
    args.fetch_official = args.fetch_assets = True
    if "reviewed_release" in config:
        args.reviewed_release = path.parent / config["reviewed_release"]
        return validate_review(read_local_json(args.reviewed_release))
    return None


def receipt_manifest(plan, receipt, review):
    saved_plan = receipt.get("plan") if isinstance(receipt, dict) else None
    if not isinstance(saved_plan, dict) or receipt.get("status") != "fixture_qualified":
        raise ValueError("Expected a fixture qualification receipt")
    if receipt.get("reviewed_release", DEFAULT) != review:
        raise ValueError("Saved receipt is stale for the reviewed release input")
    saved = saved_plan.get("candidate")
    current = plan["candidate"]
    if (saved_plan.get("installed") != plan["installed"] or not isinstance(saved, dict) or current is None
            or any(saved.get(key) != current[key] for key in ("version", "archive", "signature"))):
        raise ValueError("Saved receipt is stale for the current installed version or security selection")
    files = receipt.get("plugin_files")
    if not isinstance(files, dict):
        raise ValueError("Saved receipt is missing its plugin manifest")
    return files


def check(args, review):
    select = [sys.executable, str(HERE / "select-roundcube-security-release.py"),
              "--installed", args.installed]
    if args.fetch_official:
        select.append("--fetch-official")
    else:
        select.extend(("--releases", str(args.releases)))
        for bulletin in args.bulletin:
            select.extend(("--bulletin", str(bulletin)))
    selected = subprocess.run(select, check=True, stdout=subprocess.PIPE, text=True).stdout
    plan = json.loads(selected)
    expected = None
    if args.revalidate_receipt is not None:
        expected = receipt_manifest(plan, json.loads(args.revalidate_receipt.read_text()), review)
    if plan["candidate"] is None:
        return {"status": "no_candidate", "plan": plan}
    if args.qualification_config is not None and (review is None
            or review["prior"]["version"] != plan["installed"]
            or review["candidate"]["version"] != plan["candidate"]["version"]):
        return {"status": "review_required", "plan": plan}
    check_plan(plan, review)

    with TemporaryDirectory(prefix="qs-roundcube-readiness-") as scratch:
        plan_path = Path(scratch) / "plan.json"
        manifest = Path(scratch) / "manifest.json"
        plan_path.write_text(selected)
        assets = args.assets.resolve()
        if args.fetch_assets:
            assets = Path(scratch) / "assets"
            count = download_selected_assets(plan, args.assets, assets)
            print(f"Fetched the selected archive and detached signature in {count} HTTP requests", file=sys.stderr)
        env = {key: value for key, value in os.environ.items() if not key.startswith("QS_ROUNDCUBE_")}
        env.update(
            QS_ROUNDCUBE_FIXTURE_PACKAGE="1",
            QS_ROUNDCUBE_FIXTURE_NATIVE_INPUTS=str(assets),
            QS_ROUNDCUBE_FIXTURE_RELEASE_PLAN=str(plan_path),
        )
        if args.reviewed_release is not None:
            review_path = Path(scratch) / "reviewed-release.json"
            review_path.write_text(json.dumps(review))
            env["QS_ROUNDCUBE_FIXTURE_REVIEWED_RELEASE"] = str(review_path)
        if expected is None:
            env["QS_ROUNDCUBE_FIXTURE_QUALIFICATION_MANIFEST"] = str(manifest)
            mode = "--qualify-only"
        else:
            manifest.write_text(json.dumps(expected))
            env["QS_ROUNDCUBE_FIXTURE_EXPECTED_MANIFEST"] = str(manifest)
            mode = "--revalidate-cutover"
        subprocess.run(
            ["bash", str(HERE / "verify-roundcube-http.sh"), "--joined-https", mode],
            env=env, check=True, stdout=sys.stderr,
        )
        if expected is not None:
            return {"status": "fixture_cutover_revalidated", "plan": plan, "reviewed_release": review,
                    "plugin_files": expected, "rollback": "held_candidate_state_retained"}
        return {"status": "fixture_qualified", "plan": plan, "reviewed_release": review,
                "plugin_files": json.loads(manifest.read_text())}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--qualification-config", type=Path,
                        help="Trusted local configuration for one unattended disposable qualification check")
    parser.add_argument("--installed")
    parser.add_argument("--releases", type=Path)
    parser.add_argument("--bulletin", action="append", type=Path)
    parser.add_argument("--fetch-official", action="store_true", help="Acquire official metadata in this invocation")
    parser.add_argument("--assets", type=Path,
                        help="Directory with pubkey.asc, the prior release and signature, and any saved candidate assets")
    parser.add_argument("--fetch-assets", action="store_true",
                        help="Download the selected archive and detached signature into disposable staging inputs")
    parser.add_argument("--reviewed-release", type=Path,
                        help="Independently reviewed JSON pins for the prior and candidate stable releases")
    parser.add_argument("--revalidate-receipt", type=Path,
                        help="Revalidate a saved qualification receipt and rehearse the disposable cutover")
    args = parser.parse_args()
    unattended = args.qualification_config is not None
    if unattended:
        if any(value is not None for value in (
            args.installed, args.releases, args.bulletin, args.assets, args.reviewed_release, args.revalidate_receipt,
        )) or args.fetch_official or args.fetch_assets:
            parser.error("Use --qualification-config by itself")
    else:
        if args.installed is None or args.assets is None:
            parser.error("Supply --installed and --assets, or use --qualification-config")
        if args.fetch_official and (args.releases or args.bulletin):
            parser.error("Choose fresh discovery or saved metadata")
        if not args.fetch_official and not (args.releases and args.bulletin):
            parser.error("Use --fetch-official or supply --releases and --bulletin")
    try:
        review = configure_qualification(args) if unattended else load_review(args.reviewed_release)
        result = check(args, review)
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        if unattended:
            print(json.dumps({"status": "failed"}))
        parser.exit(1, f"Roundcube patch readiness failed: {error}\n")
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
