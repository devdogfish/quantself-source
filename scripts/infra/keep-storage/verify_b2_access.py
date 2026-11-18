#!/usr/bin/env python3
"""Root-only synthetic B2 drill. Seed both guests with one UUID before verify."""
import argparse
import base64
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import socket
import stat
import subprocess
import sys
import tempfile
import time
from xml.etree import ElementTree
from urllib.error import HTTPError
from urllib.parse import quote, urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

DIRECTORY = Path("/etc/keep-restic")
RESTIC = "/usr/local/bin/restic"
API = "/b2api/v4/"
ROLES = {"quantself": "quantself", "files": "vault"}
UPLOAD_CAPABILITIES = {"listBuckets", "listAllBucketNames", "listFiles", "readFiles", "writeFiles"}
ENV_NAMES = {"RESTIC_REPOSITORY", "RESTIC_PASSWORD_FILE", "AWS_DEFAULT_REGION",
             "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"}
REPO_PATTERN = (r"s3:(https://s3\.(ca-east-[0-9]{3})\.backblazeb2\.com)"
                r"/([a-z0-9][a-z0-9-]{4,61}[a-z0-9])/(quantself|vault)")


class VerifyError(Exception):
    """Safe diagnostic with no credential or response content."""


class ApiError(VerifyError):
    def __init__(self, operation, status, code):
        super().__init__(f"{operation} failed (HTTP {status}).")
        self.status, self.code = status, code


class TransportError(VerifyError):
    pass


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def require(condition, message):
    if not condition:
        raise VerifyError(message)


def private_file(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd) as source:
        meta = os.fstat(source.fileno())
        require(stat.S_ISREG(meta.st_mode) and stat.S_IMODE(meta.st_mode) == 0o600
                and meta.st_uid == meta.st_gid == 0, "Guest credential files must be root-owned mode 0600.")
        return source.read(8193)


def parse_env(text):
    values = {}
    for line in text.splitlines():
        tokens = shlex.split(line)
        require(len(tokens) == 1 and "=" in tokens[0], "Unexpected repository environment.")
        key, value = tokens[0].split("=", 1)
        require(key in ENV_NAMES and key not in values and value, "Unexpected repository environment.")
        values[key] = value
    require(values.keys() == ENV_NAMES, "Missing repository settings.")
    return values


def guest_env(role):
    info = DIRECTORY.lstat()
    require(stat.S_ISDIR(info.st_mode) and stat.S_IMODE(info.st_mode) == 0o700
            and info.st_uid == info.st_gid == 0, "Guest credential directory must be root-owned mode 0700.")
    values = parse_env(private_file(DIRECTORY / "repository.env"))
    match = re.fullmatch(REPO_PATTERN, values["RESTIC_REPOSITORY"])
    require(match and match[4] == role and match[2] == values["AWS_DEFAULT_REGION"],
            "Unexpected Canada East restic repository or guest role.")
    require(values["RESTIC_PASSWORD_FILE"] == str(DIRECTORY / "password"),
            "Unexpected restic password path.")
    require(re.fullmatch(r"[a-f0-9]{64}\n", private_file(DIRECTORY / "password")),
            "Unexpected restic password file format.")
    return values, match[1], match[3]


class Transport:
    def __init__(self, seconds=360, max_response_bytes=262144):
        self.deadline = time.monotonic() + seconds
        self.max_response_bytes = max_response_bytes
        self.opener = build_opener(ProxyHandler({}), NoRedirect())

    def timeout(self, limit):
        remaining = self.deadline - time.monotonic()
        require(remaining > 0, "Verification time limit reached.")
        return min(limit, remaining)

    def request(self, operation, url, token, *, body=None, headers=None):
        request = Request(url, data=body, headers={"Authorization": token, **(headers or {})})
        try:
            with self.opener.open(request, timeout=self.timeout(20)) as response:
                content = response.read(self.max_response_bytes + 1)
                require(len(content) <= self.max_response_bytes, f"{operation} response exceeds verifier limit.")
                return content
        except HTTPError as error:
            with error:
                try:
                    code = json.loads(error.read(4096)).get("code")
                except (ValueError, AttributeError):
                    code = None
            raise ApiError(operation, error.code, code) from None
        except OSError:
            raise TransportError(f"{operation} transport failed.") from None


class B2:
    def __init__(self, transport, values, endpoint, bucket, role):
        self.transport, self.bucket = transport, bucket
        raw = values["AWS_ACCESS_KEY_ID"] + ":" + values["AWS_SECRET_ACCESS_KEY"]
        basic = base64.b64encode(raw.encode()).decode()
        result = json.loads(transport.request("B2 authorize", "https://api.backblazeb2.com" + API
                                              + "b2_authorize_account", "Basic " + basic))
        storage = result["apiInfo"]["storageApi"]
        allowed = storage["allowed"]
        buckets = allowed["buckets"]
        require(storage["s3ApiUrl"] == endpoint and len(buckets) == 1
                and buckets[0]["name"] == bucket and allowed["namePrefix"] == role + "/",
                "B2 authorization scope differs from the guest configuration.")
        capabilities = allowed.get("capabilities")
        require(isinstance(capabilities, list) and len(capabilities) == len(UPLOAD_CAPABILITIES)
                and set(capabilities) == UPLOAD_CAPABILITIES,
                "B2 authorization capabilities differ from the uploader contract.")
        self.bucket_id = buckets[0]["id"]
        self.token = result["authorizationToken"]
        self.api = storage["apiUrl"]
        self.download = storage["downloadUrl"]
        require(re.fullmatch(r"https://api[0-9]+\.backblazeb2\.com", self.api)
                and re.fullmatch(r"https://f[0-9]+\.backblazeb2\.com", self.download),
                "Unexpected B2 API endpoint.")
        self.upload_endpoint = None

    def call(self, operation, **fields):
        return json.loads(self.transport.request(
            operation, self.api + API + operation, self.token,
            body=json.dumps(fields).encode(), headers={"Content-Type": "application/json"}))

    def listing(self, prefix, versions=False):
        operation = "b2_list_file_versions" if versions else "b2_list_file_names"
        result = self.call(operation, bucketId=self.bucket_id, prefix=prefix, maxFileCount=100)
        require(not result.get("nextFileName"), "Unexpected probe listing size.")
        return result["files"]

    def upload(self, name, content):
        if self.upload_endpoint is None:
            result = self.call("b2_get_upload_url", bucketId=self.bucket_id)
            url = urlsplit(result["uploadUrl"])
            require(result["bucketId"] == self.bucket_id and url.scheme == "https" and re.fullmatch(
                r"pod-[0-9-]+\.(backblaze\.com|backblazeb2\.com)", url.netloc)
                and re.match(r"/b2api/v[0-9]+/b2_upload_file(?:/|$)", url.path),
                "Unexpected B2 upload endpoint.")
            self.upload_endpoint = result["uploadUrl"], result["authorizationToken"]
        url, token = self.upload_endpoint
        sha = hashlib.sha1(content).hexdigest()  # B2 upload integrity header.
        try:
            response = self.transport.request(
                "b2_upload_file", url, token, body=content,
                headers={"X-Bz-File-Name": quote(name, safe="/"), "Content-Type": "application/octet-stream",
                         "X-Bz-Content-Sha1": sha, "Content-Length": str(len(content))})
        except ApiError:
            self.upload_endpoint = None
            raise
        result = json.loads(response)
        require(result["fileName"] == name and result["bucketId"] == self.bucket_id
                and result["action"] == "upload" and result["contentSha1"] == sha and result["fileId"],
                "B2 upload response did not match the synthetic fixture.")
        return result["fileId"]

    def read(self, name):
        return self.transport.request("b2_download_file_by_name",
                                      f"{self.download}/file/{self.bucket}/{quote(name, safe='/')}", self.token)

    def read_version(self, file_id):
        return self.transport.request("b2_download_file_by_id",
                                      self.download + API + "b2_download_file_by_id?"
                                      + urlencode({"fileId": file_id}), self.token)


def expect_error(label, fn, status=401, code="unauthorized"):
    try:
        fn()
    except ApiError as error:
        require((error.status, error.code) == (status, code),
                f"{label} returned unexpected HTTP {error.status}.")
    else:
        raise VerifyError(f"{label} unexpectedly succeeded.")


def path_for(role, run_id):
    return f"{role}/_verify/{run_id}/"


def fixture(role, run_id):
    return f"keep-b2 synthetic fixture {role} {run_id}\n".encode()


def seed(b2, role, run_id):
    name = path_for(role, run_id) + "sentinel"
    payload = fixture(role, run_id)
    versions = b2.listing(name, versions=True)
    if versions:
        require(len(versions) == 1 and versions[0]["fileName"] == name
                and versions[0]["action"] == "upload" and b2.read(name) == payload,
                "Existing synthetic sentinel conflicts; use a fresh run ID.")
    else:
        b2.upload(name, payload)
        require(b2.read(name) == payload, "Synthetic sentinel read differs.")
    require(any(item["fileName"] == name for item in b2.listing(name)),
            "Synthetic sentinel missing from own-prefix listing.")


def verify_native(b2, role, run_id):
    prefix = path_for(role, run_id)
    other = "vault" if role == "quantself" else "quantself"
    peer = path_for(other, run_id)
    payload = fixture(role, run_id)
    require(b2.read(prefix + "sentinel") == payload, "Seed this guest before verifying.")
    expect_error("Cross-prefix read", lambda: b2.read(peer + "sentinel"))
    name = prefix + "hide-probe"
    require(not b2.listing(name, versions=True), "Hide probe already exists; use a fresh run ID.")
    file_id = b2.upload(name, payload)
    require(b2.read(name) == payload, "Own-prefix probe read differs.")
    # Reuse the upload token known to work above. Target a different object
    # from the peer's sentinel even if access is unexpectedly granted.
    expect_error("Cross-prefix write", lambda: b2.upload(peer + "denial-from-" + role, payload))
    result = b2.call("b2_hide_file", bucketId=b2.bucket_id, fileName=name)
    require(result["action"] == "hide" and result["fileName"] == name, "B2 did not confirm probe hide.")
    expect_error("Read hidden probe by name", lambda: b2.read(name), 404, "not_found")
    require(b2.read_version(file_id) == payload, "Hidden version could not be read by ID.")
    expect_error("Permanent version deletion",
                 lambda: b2.call("b2_delete_file_version", fileName=name, fileId=file_id))
    require(b2.read_version(file_id) == payload, "Probe version changed after denied deletion.")


class SignedS3:
    def __init__(self, env, role, timeout):
        match = re.fullmatch(REPO_PATTERN, env["RESTIC_REPOSITORY"])
        require(match and match[2] == env["AWS_DEFAULT_REGION"] and match[4] == role,
                "Unexpected signed S3 target.")
        self.bucket = match[3]
        self.base = f"{match[1]}/{self.bucket}/"
        self.region = match[2]
        self.timeout = timeout
        access, secret = env["AWS_ACCESS_KEY_ID"], env["AWS_SECRET_ACCESS_KEY"]
        require(all(re.fullmatch(r"[A-Za-z0-9_+/=-]{1,512}", value) for value in (access, secret)),
                "Unexpected signing credential format.")
        # Config on stdin keeps both credential values out of argv and the
        # child environment. The strict format excludes curl config syntax.
        self.config = f'user = "{access}:{secret}"\n'.encode()

    def request(self, method, key="", *, query=None, upload=None):
        url = self.base + quote(key, safe="/")
        if query is not None:
            url += "?" + urlencode(query, quote_via=quote)
        seconds = self.timeout(20)
        argv = ["/usr/bin/curl", "-q", "--config", "-", "--silent", "--globoff",
                "--proto", "=https", "--noproxy", "*", "--max-redirs", "0",
                "--max-time", str(seconds), "--max-filesize", "262144",
                "--aws-sigv4", f"aws:amz:{self.region}:s3",
                "--request", method, "--write-out", "\n%{http_code}"]
        if upload is not None:
            argv.extend(("--upload-file", str(upload)))
        try:
            result = subprocess.run([*argv, "--", url], input=self.config,
                                    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                    env={"PATH": "/usr/bin:/bin", "LANG": "C"},
                                    timeout=seconds + 2, check=False)
        except (OSError, subprocess.TimeoutExpired):
            raise VerifyError(f"Signed S3 {method} transport failed.") from None
        body, _, status = result.stdout.rpartition(b"\n")
        require(result.returncode == 0 and re.fullmatch(rb"[1-5][0-9]{2}", status)
                and len(body) <= 262144, f"Signed S3 {method} transport failed.")
        return int(status), body


def s3_denied(label, result):
    status, body = result
    require(status == 403, f"Signed S3 {label} did not return HTTP 403.")
    try:
        error = ElementTree.fromstring(body)
    except ElementTree.ParseError:
        raise VerifyError(f"Signed S3 {label} returned invalid denial evidence.") from None
    require(error.tag.rsplit("}", 1)[-1] == "Error"
            and error.findtext("{*}Code") == "AccessDenied",
            f"Signed S3 {label} did not return AccessDenied.")


def s3_fixture_version(s3, key):
    status, body = s3.request("GET", query={"versions": "", "prefix": key, "max-keys": "2"})
    require(status == 200, "Signed S3 fixture version listing failed.")
    try:
        listing = ElementTree.fromstring(body)
    except ElementTree.ParseError:
        raise VerifyError("Signed S3 fixture version listing was invalid.") from None
    versions = listing.findall("{*}Version")
    require(listing.tag.rsplit("}", 1)[-1] == "ListVersionsResult"
            and listing.findtext("{*}Name") == s3.bucket
            and listing.findtext("{*}IsTruncated") == "false"
            and len(versions) == 1 and not listing.findall("{*}DeleteMarker")
            and versions[0].findtext("{*}Key") == key
            and versions[0].findtext("{*}IsLatest") == "true",
            "Signed S3 fixture version was missing or ambiguous.")
    version = versions[0].findtext("{*}VersionId")
    require(version and version != "null" and re.fullmatch(r"[A-Za-z0-9_+/=.-]{1,512}", version),
            "Signed S3 fixture version ID was invalid.")
    return version


def s3_verify_listing(s3, own_key, peer_key):
    query = {"list-type": "2", "prefix": own_key, "max-keys": "2"}
    status, body = s3.request("GET", query=query)
    require(status == 200, "Signed S3 own-prefix listing failed.")
    try:
        listing = ElementTree.fromstring(body)
    except ElementTree.ParseError:
        raise VerifyError("Signed S3 own-prefix listing was invalid.") from None
    contents = listing.findall("{*}Contents")
    require(listing.tag.rsplit("}", 1)[-1] == "ListBucketResult"
            and listing.findtext("{*}Name") == s3.bucket
            and listing.findtext("{*}IsTruncated") == "false"
            and len(contents) == 1 and contents[0].findtext("{*}Key") == own_key,
            "Signed S3 own-prefix listing did not identify the sentinel.")
    s3_denied("cross-prefix listing", s3.request("GET", query={**query, "prefix": peer_key}))


def verify_s3(b2, env, role, run_id, timeout):
    s3 = SignedS3(env, role, timeout)
    own = path_for(role, run_id)
    peer = path_for("vault" if role == "quantself" else "quantself", run_id)
    payload = fixture(role, run_id)
    require(s3.request("GET", own + "sentinel") == (200, payload),
            "Signed S3 own-prefix read control failed.")
    s3_denied("cross-prefix read", s3.request("GET", peer + "sentinel"))
    s3_verify_listing(s3, own + "sentinel", peer + "sentinel")
    name = own + "s3-version-probe"
    require(not b2.listing(name, versions=True), "Signed S3 fixture exists; use a fresh run ID.")
    with tempfile.TemporaryDirectory(prefix="keep-b2-s3-probe-") as scratch:
        source = Path(scratch) / "fixture"
        source.write_bytes(payload)
        require(s3.request("PUT", name, upload=source)[0] == 200,
                "Signed S3 own-prefix write control failed.")
        s3_denied("cross-prefix write",
                  s3.request("PUT", peer + "s3-denial-from-" + role, upload=source))
    query = {"versionId": s3_fixture_version(s3, name)}
    require(s3.request("GET", name, query=query) == (200, payload),
            "Signed S3 fixture version read control failed.")
    s3_denied("permanent version deletion", s3.request("DELETE", name, query=query))
    require(s3.request("GET", name, query=query) == (200, payload),
            "Signed S3 fixture version changed after denied deletion.")


def verify_restic(b2, env, role, run_id, timeout):
    prefix = path_for(role, run_id) + "restic"
    require(not b2.listing(prefix + "/", versions=True),
            "Synthetic restic repository already exists; use a fresh run ID.")
    with tempfile.TemporaryDirectory(prefix="keep-b2-verifier-") as scratch:
        # A fresh temporary password isolates the synthetic repository from the
        # real repository and avoids retaining another recovery credential.
        path = Path(scratch)
        payload = fixture(role, run_id)
        (path / "fixture").write_bytes(payload)
        (path / "password").touch(mode=0o600)
        (path / "password").write_text(secrets.token_hex(32) + "\n")
        restic_env = {**env, "RESTIC_REPOSITORY": env["RESTIC_REPOSITORY"] + f"/_verify/{run_id}/restic",
                      "RESTIC_PASSWORD_FILE": str(path / "password"), "HOME": scratch,
                      "PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C", "AWS_EC2_METADATA_DISABLED": "true"}

        def restic(*args):
            result = subprocess.run([RESTIC, "--no-cache", *args], env=restic_env, cwd=scratch,
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout(75))
            require(result.returncode == 0, f"Synthetic restic {args[0]} failed (exit {result.returncode}).")
            return result.stdout

        restic("init")
        restic("backup", "fixture")
        snapshots = json.loads(restic("snapshots", "--json"))
        require(len(snapshots) == 1 and re.fullmatch(r"[0-9a-f]{64}", snapshots[0]["id"]),
                "Synthetic restic snapshot missing or ambiguous.")
        restic("check", "--read-data")
        restic("restore", snapshots[0]["id"], "--target", "restore")
        restored = [item for item in (path / "restore").rglob("fixture") if item.is_file()]
        require(len(restored) == 1 and restored[0].read_bytes() == payload, "Restored fixture differs.")
    lock_prefix = prefix + "/locks/"
    require(not b2.listing(lock_prefix), "A current restic lock remains after successful commands.")
    versions = b2.listing(lock_prefix, versions=True)
    uploads = {item["fileName"] for item in versions if item["action"] == "upload"}
    hides = {item["fileName"] for item in versions if item["action"] == "hide"}
    require(uploads and uploads <= hides, "B2 did not show restic lock uploads and S3 hide markers.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phase", choices=("seed", "verify"))
    parser.add_argument("--bucket", required=True, help="Exact Owner-approved B2 bucket")
    parser.add_argument("--run-id", required=True, help="Same fresh UUID4 hex on both guests")
    args = parser.parse_args()
    require(re.fullmatch(r"[0-9a-f]{12}4[0-9a-f]{3}[89ab][0-9a-f]{15}", args.run_id),
            "Provide a lowercase UUID4 hex run ID.")
    role = ROLES.get(socket.gethostname())
    require(os.geteuid() == 0 and role, "Run as root on the quantself or files guest.")
    os.umask(0o077)
    lock = os.open(DIRECTORY, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise VerifyError("Another credential setup or verification run holds the guest directory lock.") from None
        env, endpoint, bucket = guest_env(role)
        require(bucket == args.bucket, "Installed repository does not match the approved B2 bucket.")
        transport = Transport()
        b2 = B2(transport, env, endpoint, bucket, role)
        if args.phase == "seed":
            seed(b2, role, args.run_id)
        else:
            verify_native(b2, role, args.run_id)
            verify_s3(b2, env, role, args.run_id, transport.timeout)
            verify_restic(b2, env, role, args.run_id, transport.timeout)
    finally:
        os.close(lock)
    print(json.dumps({"phase": args.phase, "role": role, "runId": args.run_id, "result": "passed"}))


if __name__ == "__main__":
    try:
        main()
    except (Exception, KeyboardInterrupt) as error:
        print(str(error) if isinstance(error, VerifyError) else
              "Verification stopped. Synthetic objects may remain. No secret values displayed.", file=sys.stderr)
        sys.exit(1)
