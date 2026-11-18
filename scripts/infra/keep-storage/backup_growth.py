#!/usr/bin/env python3
"""Count B2 data retained under the guest's backup prefix using its existing key."""
from datetime import datetime, timezone
import json
import os
import signal
import socket
import sys
import time

from verify_b2_access import ApiError, B2, ROLES, Transport, TransportError, guest_env, require

# Each versions page is one documented Class C transaction, with no downloads.
PAGE_SIZE = 1000
MAX_SECONDS = 80
COUNTERS = {"retained_bytes", "retained_versions", "unfinished_bytes", "unfinished_uploads"}


def pages(call, operation, items_key, cursors, **fields):
    cursor = {}
    seen = set()
    while True:
        result = call(operation, **fields, **cursor)
        items = result[items_key]
        require(isinstance(items, list), "Unexpected B2 page format.")
        yield from items
        values = tuple(result.get(key) for key in cursors)
        if all(value is None for value in values):
            return
        require(all(value for value in values) and values not in seen, "Invalid B2 pagination cursor.")
        seen.add(values)
        cursor = dict(zip(cursors.values(), values))


def length(item):
    value = item["contentLength"]
    require(type(value) is int and value >= 0, "Invalid B2 object size.")
    return value


def census(b2, role, pause=time.sleep):
    prefix = role + "/"
    counts = dict.fromkeys(COUNTERS, 0)

    def call(operation, **fields):
        for attempt in range(3):
            try:
                return b2.call(operation, **fields)
            except (TransportError, ApiError) as error:
                if attempt == 2 or (isinstance(error, ApiError) and error.status not in (429, 500, 502, 503, 504)):
                    raise
                pause(attempt + 1)

    for item in pages(call, "b2_list_file_versions", "files",
                      {"nextFileName": "startFileName", "nextFileId": "startFileId"},
                      bucketId=b2.bucket_id, prefix=prefix, maxFileCount=PAGE_SIZE):
        require(item["fileName"].startswith(prefix) and item["bucketId"] == b2.bucket_id,
                "B2 version outside expected scope.")
        if item["action"] == "upload":
            counts["retained_bytes"] += length(item)
            counts["retained_versions"] += 1
        else:
            require(item["action"] in ("hide", "start"), "Unknown B2 version action.")

    # The versions API can show start markers, which have zero size. Obtain
    # unfinished uploads and their uploaded part sizes through their own APIs.
    for item in pages(call, "b2_list_unfinished_large_files", "files",
                      {"nextFileId": "startFileId"}, bucketId=b2.bucket_id,
                      namePrefix=prefix, maxFileCount=100):
        require(item["fileName"].startswith(prefix) and item["bucketId"] == b2.bucket_id,
                "B2 multipart upload outside expected scope.")
        file_id = item["fileId"]
        require(isinstance(file_id, str) and file_id, "Invalid B2 multipart upload ID.")
        counts["unfinished_uploads"] += 1
        for part in pages(call, "b2_list_parts", "parts", {"nextPartNumber": "startPartNumber"},
                          fileId=file_id, maxPartCount=PAGE_SIZE):
            require(part["fileId"] == file_id, "B2 multipart part outside expected upload.")
            counts["unfinished_bytes"] += length(part)
    return counts


def main():
    role = ROLES.get(socket.gethostname().split(".")[0])
    require(os.geteuid() == 0 and role, "Run as root on the quantself or files guest.")
    values, endpoint, bucket = guest_env(role)
    transport = Transport(seconds=MAX_SECONDS, max_response_bytes=16 * 1024 * 1024)
    start = datetime.now(timezone.utc)
    b2 = B2(transport, values, endpoint, bucket, role)
    counts = census(b2, role)
    end = datetime.now(timezone.utc)
    print(json.dumps({"format": 1, "prefix_role": role, "sample_start": start.isoformat(),
                      "sample_end": end.isoformat(), **counts}, sort_keys=True))


if __name__ == "__main__":
    try:
        # Bound the guest process even if the host stops waiting or the
        # network trickles bytes without hitting a socket idle timeout.
        signal.alarm(MAX_SECONDS)
        main()
    except (Exception, KeyboardInterrupt):
        print("B2 version census did not complete.", file=sys.stderr)
        sys.exit(1)
