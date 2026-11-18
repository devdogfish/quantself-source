"""Validate reviewed release pins independently of the discovery plan."""

import argparse
import json
from pathlib import Path
import re

from roundcube_release_assets import RELEASE_DOWNLOAD


DEFAULT = {
    "prior": {
        "version": "1.7.5",
        "archive_sha256": "93a66c94e3efff7db93187c1c9d7f35546647a3e1e7b9327cc87911564edf9d1",
        "signature_sha256": "f47b244e653db7a1fac358ed3ff9b338d9f2b398f865f20fedf9d14b1b965c3a",
    },
    "candidate": {
        "version": "1.7.6",
        "archive_sha256": "0168085bf0bfeeb5d4eca3b9730effbe610dbdb380a68567d292fec51f09db36",
        "signature_sha256": "964dfdb1050ec21c0af3c3b7e401a4764cdd9c1520e7e6b9859a03abcdb41f95",
    },
}
STABLE = re.compile(r"1\.7\.(0|[1-9][0-9]*)")
SHA256 = re.compile(r"[a-f0-9]{64}")


def load_review(path=None):
    return validate_review(DEFAULT if path is None else json.loads(path.read_text()))


def validate_review(review):
    if not isinstance(review, dict) or set(review) != {"prior", "candidate"}:
        raise ValueError("Expected only prior and candidate in the reviewed release input")
    patches = []
    for role in ("prior", "candidate"):
        entry = review[role]
        if (not isinstance(entry, dict) or set(entry) != {"version", "archive_sha256", "signature_sha256"}
                or not all(isinstance(value, str) for value in entry.values())
                or not (tag := STABLE.fullmatch(entry["version"]))
                or not all(SHA256.fullmatch(entry[key]) for key in ("archive_sha256", "signature_sha256"))):
            raise ValueError(f"Expected a stable 1.7 {role} and reviewed SHA-256 pins for both files")
        patches.append(int(tag[1]))
    if patches[1] <= patches[0]:
        raise ValueError("The reviewed candidate must be newer than the prior stable 1.7 release")
    return review


def check_plan(plan, review):
    approved = review["candidate"]
    version = approved["version"]
    url = f"{RELEASE_DOWNLOAD}{version}/roundcubemail-{version}-complete.tar.gz"
    candidate = plan.get("candidate") if isinstance(plan, dict) else None
    if (not isinstance(candidate, dict) or plan.get("installed") != review["prior"]["version"]
            or candidate.get("version") != version
            or candidate.get("archive") != {"url": url, "sha256": approved["archive_sha256"]}
            or candidate.get("signature") != {"url": url + ".asc", "sha256": approved["signature_sha256"]}):
        raise ValueError("Selected release plan does not match the reviewed release pair and asset pins")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--review", type=Path)
    parser.add_argument("--plan", type=Path)
    args = parser.parse_args()
    try:
        review = load_review(args.review)
        if args.plan:
            check_plan(json.loads(args.plan.read_text()), review)
        elif args.review:
            raise ValueError("A nondefault reviewed release pair requires a selected security plan")
        for role in ("prior", "candidate"):
            print(*(review[role][key] for key in ("version", "archive_sha256", "signature_sha256")))
    except (OSError, ValueError) as error:
        parser.exit(2, f"Invalid native fixture release input: {error}\n")


if __name__ == "__main__":
    main()
