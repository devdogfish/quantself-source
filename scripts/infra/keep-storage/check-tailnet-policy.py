#!/usr/bin/env python3
"""Render a private Keep Tailnet policy and compare it with approved JSON."""

import json
import os
import re
import stat
import sys


MAX_JSON_BYTES = 1024 * 1024
ROLE = re.compile(r"[a-z][a-z0-9_]*")


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate object key")
        result[key] = value
    return result


def invalid_constant(_value):
    raise ValueError("invalid JSON constant")


def read_private_object(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
            raise ValueError("owner-only regular file required")
        data = source.read(MAX_JSON_BYTES + 1)
    if len(data) > MAX_JSON_BYTES:
        raise ValueError("JSON too large")
    result = json.loads(data, object_pairs_hook=unique_object, parse_constant=invalid_constant)
    if not isinstance(result, dict):
        raise ValueError("JSON object required")
    return result


def selector(value):
    return isinstance(value, str) and bool(value) and all("!" <= char <= "~" for char in value)


def selector_list(value):
    if not isinstance(value, list) or not all(map(selector, value)):
        raise ValueError("selector list required")


def render_policy(policy, inputs):
    if set(policy) != {"tagOwners", "grants", "tests"}:
        raise ValueError("unexpected policy sections")
    if not all(ROLE.fullmatch(role) and selector(value) for role, value in inputs.items()):
        raise ValueError("invalid private input")
    if not isinstance(policy["tagOwners"], dict):
        raise ValueError("tag owner map required")
    for owners in policy["tagOwners"].values():
        selector_list(owners)

    used = set()
    references = 0

    def resolve(value):
        nonlocal references
        if isinstance(value, dict) and set(value) == {"$private"}:
            role = value["$private"]
            if not isinstance(role, str) or role not in inputs:
                raise ValueError("missing private input")
            references += 1
            used.add(role)
            return inputs[role]
        if not selector(value):
            raise ValueError("invalid selector or private reference")
        return value

    def resolve_list(value):
        if not isinstance(value, list):
            raise ValueError("selector list required")
        return [resolve(item) for item in value]

    grants = policy["grants"]
    tests = policy["tests"]
    if not isinstance(grants, list) or not isinstance(tests, list):
        raise ValueError("grants and tests must be arrays")
    for grant in grants:
        if not isinstance(grant, dict) or set(grant) != {"src", "dst", "ip"}:
            raise ValueError("unexpected grant shape")
        for field in ("src", "dst"):
            grant[field] = resolve_list(grant[field])
        selector_list(grant["ip"])

    for test in tests:
        if not isinstance(test, dict) or not {"src"} <= set(test) <= {"src", "accept", "deny", "proto"}:
            raise ValueError("unexpected test shape")
        if not ({"accept", "deny"} & set(test)):
            raise ValueError("policy test needs accept or deny expectations")
        if "proto" in test and not selector(test["proto"]):
            raise ValueError("invalid test protocol")
        test["src"] = resolve(test["src"])
        for field in ("accept", "deny"):
            if field in test:
                test[field] = resolve_list(test[field])

    if not used or used != set(inputs):
        raise ValueError("private inputs must match the template slots exactly")
    return references


def main(args):
    try:
        if len(args) != 3:
            raise ValueError("three policy files required")
        template, inputs, approved = map(read_private_object, args)
        references = render_policy(template, inputs)
        if json.dumps(template, sort_keys=True) != json.dumps(approved, sort_keys=True):
            raise ValueError("render differs from approved policy")
    except (OSError, ValueError, RecursionError):
        print("policy_matches=0 errors=1")
        return 1
    print(
        f"policy_matches=1 grants={len(template['grants'])} tests={len(template['tests'])} "
        f"private_roles={len(inputs)} private_references={references}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
