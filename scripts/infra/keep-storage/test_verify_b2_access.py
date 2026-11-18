"""Synthetic B2 API and restic subprocess fixtures."""
import importlib.util
import json
from pathlib import Path
import shlex
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("verify_b2_access", Path(__file__).with_name("verify_b2_access.py"))
verify = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verify)
RUN_ID = "cafeaaaa12344fff8eeeeeeeeeaaaaaa"
ENV = {"RESTIC_REPOSITORY": "s3:https://s3.ca-east-006.backblazeb2.com/synthetic-bucket/quantself",
       "AWS_DEFAULT_REGION": "ca-east-006", "AWS_ACCESS_KEY_ID": "fixture-id",
       "AWS_SECRET_ACCESS_KEY": "fixture-secret", "RESTIC_PASSWORD_FILE": "/etc/keep-restic/password"}


class FakeB2:
    bucket_id = "fixture-bucket"

    def __init__(self, objects, role="quantself"):
        self.objects = objects
        self.prefix = role + "/"
        self.denials = []
        self.bad_read = None
        self.delete_allowed = False

    def upload(self, name, payload):
        if not name.startswith(self.prefix):
            self.denials.append("write")
            raise verify.ApiError("upload", 401, "unauthorized")
        version = {"fileName": name, "fileId": name + "-id", "action": "upload"}
        self.objects[name] = [(version, payload)]
        return version["fileId"]

    def read(self, name):
        if not name.startswith(self.prefix):
            self.denials.append("read")
            if self.bad_read:
                raise verify.ApiError("read", *self.bad_read)
            assert name in self.objects
            raise verify.ApiError("read", 401, "unauthorized")
        if name not in self.objects or self.objects[name][0][0]["action"] == "hide":
            raise verify.ApiError("read", 404, "not_found")
        return self.objects[name][0][1]

    def read_version(self, file_id):
        for versions in self.objects.values():
            for item, payload in versions:
                if item.get("fileId") == file_id:
                    return payload
        raise AssertionError("Missing version")

    def listing(self, prefix, versions=False):
        return [item for name, entries in self.objects.items() if name.startswith(prefix)
                for item, _ in (entries if versions else entries[:1]) if versions or item["action"] == "upload"]

    def call(self, operation, **params):
        name = params["fileName"]
        if operation == "b2_hide_file":
            marker = {"fileName": name, "action": "hide"}
            self.objects[name].insert(0, (marker, None))
            return marker
        if operation == "b2_delete_file_version":
            assert name == self.prefix + f"_verify/{RUN_ID}/hide-probe"
            assert self.objects[name][1][0]["fileId"] == params["fileId"]
            if self.delete_allowed:
                self.objects[name].pop()
                return {}
            self.denials.append("permanent delete")
            raise verify.ApiError("delete", 401, "unauthorized")
        raise AssertionError(operation)


class B2VerifierTest(unittest.TestCase):
    def setUp(self):
        blocked = patch.object(verify, "build_opener", side_effect=AssertionError("No network allowed"))
        blocked.start()
        self.addCleanup(blocked.stop)
        self.b2 = FakeB2({})
        verify.seed(self.b2, "quantself", RUN_ID)
        verify.seed(FakeB2(self.b2.objects, "vault"), "vault", RUN_ID)

    def test_native_proves_existing_peer_denials_and_own_version_survives(self):
        verify.seed(self.b2, "quantself", RUN_ID)  # Seed is safely repeatable.
        verify.verify_native(self.b2, "quantself", RUN_ID)
        self.assertEqual(self.b2.denials, ["read", "write", "permanent delete"])
        self.assertEqual(len(self.b2.objects), 3)
        self.assertEqual(self.b2.objects[verify.path_for("quantself", RUN_ID) + "hide-probe"][1][1],
                         verify.fixture("quantself", RUN_ID))

    def test_missing_object_expired_token_or_cap_error_is_not_denial_evidence(self):
        for status, code in [(404, "not_found"), (401, "expired_auth_token"), (403, "download_cap_exceeded")]:
            self.b2.bad_read = status, code
            with self.subTest(code=code), self.assertRaisesRegex(verify.VerifyError, "unexpected HTTP"):
                verify.verify_native(self.b2, "quantself", RUN_ID)
        self.assertEqual(len(self.b2.objects), 2)

    def test_unexpected_delete_success_fails(self):
        self.b2.delete_allowed = True
        with self.assertRaisesRegex(verify.VerifyError, "deletion unexpectedly succeeded"):
            verify.verify_native(self.b2, "quantself", RUN_ID)

    def test_restic_uses_synthetic_repo_private_password_and_checks_lock_versions(self):
        prefix = verify.path_for("quantself", RUN_ID) + "restic/"
        commands = []

        def run(argv, *, env, cwd, **kwargs):
            commands.append(argv[2])
            self.assertTrue(env["RESTIC_REPOSITORY"].endswith("/_verify/" + RUN_ID + "/restic"))
            self.assertNotEqual(env["RESTIC_PASSWORD_FILE"], ENV["RESTIC_PASSWORD_FILE"])
            self.assertEqual(Path(env["RESTIC_PASSWORD_FILE"]).stat().st_mode & 0o777, 0o600)
            self.assertNotIn(ENV["AWS_SECRET_ACCESS_KEY"], argv)
            if argv[2] == "snapshots":
                return subprocess.CompletedProcess(argv, 0, stdout=json.dumps([{"id": "a" * 64}]).encode())
            if argv[2] == "restore":
                output = Path(cwd) / "restore"
                output.mkdir()
                (output / "fixture").write_bytes(verify.fixture("quantself", RUN_ID))
                name = prefix + "locks/synthetic"
                self.b2.objects[name] = [({"fileName": name, "action": "hide"}, None),
                                         ({"fileName": name, "action": "upload"}, b"synthetic lock")]
            return subprocess.CompletedProcess(argv, 0, stdout=b"")

        with patch.object(verify.subprocess, "run", side_effect=run):
            verify.verify_restic(self.b2, ENV, "quantself", RUN_ID, float)
        self.assertEqual(commands, ["init", "backup", "snapshots", "check", "restore"])
        with patch.object(verify.subprocess, "run", side_effect=AssertionError("Must stop before init")):
            with self.assertRaisesRegex(verify.VerifyError, "already exists"):
                verify.verify_restic(self.b2, ENV, "quantself", RUN_ID, float)

    def test_env_parses_values_without_shell_and_rejects_unknown_assignments(self):
        values = {**ENV, "AWS_SECRET_ACCESS_KEY": "literal $HOME ' `fixture`"}
        raw = "".join(f"{key}={shlex.quote(value)}\n" for key, value in values.items())
        self.assertEqual(verify.parse_env(raw), values)
        with self.assertRaisesRegex(verify.VerifyError, "Unexpected repository"):
            verify.parse_env(raw + "BASH_ENV=/tmp/fixture\n")

    def test_bucket_mismatch_fails_before_any_transport(self):
        for phase in ("seed", "verify"):
            with self.subTest(phase=phase), tempfile.TemporaryDirectory() as directory, \
                 patch.object(verify, "DIRECTORY", Path(directory)), \
                 patch.object(verify.os, "geteuid", return_value=0), \
                 patch.object(verify.os, "umask"), \
                 patch.object(verify.socket, "gethostname", return_value="quantself"), \
                 patch.object(verify.sys, "argv", ["verify", phase, "--bucket", "approved-bucket", "--run-id", RUN_ID]), \
                 patch.object(verify, "guest_env", return_value=(ENV, "fixture-endpoint", "synthetic-bucket")), \
                 patch.object(verify, "Transport", side_effect=AssertionError("No transport allowed")):
                with self.assertRaisesRegex(verify.VerifyError, "does not match the approved B2 bucket"):
                    verify.main()

    def test_signed_s3_curl_keeps_credentials_in_stdin_and_blocks_external_config(self):
        s3 = verify.SignedS3(ENV, "quantself", float)
        with patch.object(verify.subprocess, "run") as run:
            run.return_value = subprocess.CompletedProcess([], 0, stdout=b"fixture\n200")
            self.assertEqual(s3.request("GET", "quantself/probe", query={"versionId": "v+1"}),
                             (200, b"fixture"))
        argv = run.call_args.args[0]
        self.assertEqual(argv[:4], ["/usr/bin/curl", "-q", "--config", "-"])
        self.assertEqual(argv[-1],
                         "https://s3.ca-east-006.backblazeb2.com/synthetic-bucket/quantself/probe?versionId=v%2B1")
        self.assertNotIn(ENV["AWS_SECRET_ACCESS_KEY"], " ".join(argv))
        self.assertNotIn("AWS_SECRET_ACCESS_KEY", run.call_args.kwargs["env"])
        self.assertEqual(run.call_args.kwargs["input"], b'user = "fixture-id:fixture-secret"\n')
        self.assertEqual(argv[argv.index("--noproxy") + 1], "*")
        self.assertEqual(argv[argv.index("--proto") + 1], "=https")
        with self.assertRaisesRegex(verify.VerifyError, "credential format"):
            verify.SignedS3({**ENV, "AWS_SECRET_ACCESS_KEY": 'bad"\nurl=evil'}, "quantself", float)

    def test_signed_s3_probes_existing_peer_and_deletes_only_a_listed_owned_version(self):
        own = verify.path_for("quantself", RUN_ID)
        peer = verify.path_for("vault", RUN_ID)
        name = own + "s3-version-probe"
        payload = verify.fixture("quantself", RUN_ID)
        version = "fixture+version"
        listing = f"""<ListVersionsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
          <Name>synthetic-bucket</Name><IsTruncated>false</IsTruncated><Version><Key>{name}</Key>
          <VersionId>{version}</VersionId><IsLatest>true</IsLatest></Version></ListVersionsResult>""".encode()
        objects = f"""<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
          <Name>synthetic-bucket</Name><IsTruncated>false</IsTruncated>
          <Contents><Key>{own}sentinel</Key></Contents></ListBucketResult>""".encode()
        denial = b"<Error><Code>AccessDenied</Code></Error>"
        requests = [
            ("GET", own + "sentinel", None, (200, payload)),
            ("GET", peer + "sentinel", None, (403, denial)),
            ("GET", "", {"list-type": "2", "prefix": own + "sentinel", "max-keys": "2"}, (200, objects)),
            ("GET", "", {"list-type": "2", "prefix": peer + "sentinel", "max-keys": "2"}, (403, denial)),
            ("PUT", name, None, (200, b"")),
            ("PUT", peer + "s3-denial-from-quantself", None, (403, denial)),
            ("GET", "", {"versions": "", "prefix": name, "max-keys": "2"}, (200, listing)),
            ("GET", name, {"versionId": version}, (200, payload)),
            ("DELETE", name, {"versionId": version}, (403, denial)),
            ("GET", name, {"versionId": version}, (200, payload)),
        ]

        def request(method, key="", *, query=None, upload=None):
            expected_method, expected_key, expected_query, response = requests.pop(0)
            self.assertEqual((method, key, query), (expected_method, expected_key, expected_query))
            if method == "PUT":
                self.assertEqual(upload.read_bytes(), payload)
            return response

        with patch.object(verify.SignedS3, "request", side_effect=request):
            verify.verify_s3(self.b2, ENV, "quantself", RUN_ID, float)
        self.assertFalse(requests)

    def test_signed_s3_rejects_non_authorization_errors_and_ambiguous_listing(self):
        for response in ((404, b"<Error><Code>NoSuchKey</Code></Error>"),
                         (403, b"<Error><Code>SignatureDoesNotMatch</Code></Error>"),
                         (403, b"proxy error"), (200, b"")):
            with self.subTest(response=response), self.assertRaises(verify.VerifyError):
                verify.s3_denied("fixture", response)
        s3 = unittest.mock.Mock()
        s3.request.return_value = (200, b"<ListVersionsResult><IsTruncated>true</IsTruncated></ListVersionsResult>")
        with self.assertRaisesRegex(verify.VerifyError, "missing or ambiguous"):
            verify.s3_fixture_version(s3, "quantself/fixture")

    def test_signed_s3_rejects_wrong_bucket_and_peer_listing_success(self):
        s3 = unittest.mock.Mock(bucket="expected-bucket")
        s3.request.return_value = (200, b"""<ListVersionsResult>
          <Name>other-bucket</Name><IsTruncated>false</IsTruncated>
          <Version><Key>quantself/fixture</Key><IsLatest>true</IsLatest><VersionId>fixture</VersionId></Version>
          </ListVersionsResult>""")
        with self.assertRaisesRegex(verify.VerifyError, "missing or ambiguous"):
            verify.s3_fixture_version(s3, "quantself/fixture")
        s3.request.side_effect = [
            (200, b"""<ListBucketResult><Name>expected-bucket</Name><IsTruncated>false</IsTruncated>
              <Contents><Key>quantself/sentinel</Key></Contents></ListBucketResult>"""),
            (200, b"<ListBucketResult/>"),
        ]
        with self.assertRaisesRegex(verify.VerifyError, "cross-prefix listing did not return HTTP 403"):
            verify.s3_verify_listing(s3, "quantself/sentinel", "vault/sentinel")

    def test_authorization_requires_exact_capabilities_before_any_mutation(self):
        endpoint = "https://s3.ca-east-006.backblazeb2.com"
        expected = sorted(verify.UPLOAD_CAPABILITIES)
        for capabilities in (None, expected[:-1], expected + ["deleteFiles"],
                             expected + ["writeBuckets"], expected + ["writeKeys"]):
            with self.subTest(capabilities=capabilities):
                response = {"authorizationToken": "fixture-auth", "apiInfo": {"storageApi": {
                    "apiUrl": "https://api006.backblazeb2.com",
                    "downloadUrl": "https://f006.backblazeb2.com", "s3ApiUrl": endpoint,
                    "allowed": {"buckets": [{"name": "synthetic-bucket", "id": "fixture-bucket"}],
                                "namePrefix": "quantself/", "capabilities": capabilities}}}}
                transport = unittest.mock.Mock()
                transport.request.return_value = json.dumps(response).encode()
                with self.assertRaisesRegex(verify.VerifyError, "capabilities differ"):
                    verify.B2(transport, ENV, endpoint, "synthetic-bucket", "quantself")
                self.assertEqual(transport.request.call_count, 1)

    def test_b2_v4_routes_and_upload_token_lifetime(self):
        endpoint = "https://s3.ca-east-006.backblazeb2.com"
        native = "https://api006.backblazeb2.com"
        upload = "https://pod-006-1005-03.backblaze.com/b2api/v4/b2_upload_file?cvt=fixture"
        download = "https://f006.backblazeb2.com"
        operations = []

        class FixtureTransport:
            def request(self, operation, url, token, **kwargs):
                operations.append(operation)
                if operation == "B2 authorize":
                    assert url == "https://api.backblazeb2.com/b2api/v4/b2_authorize_account"
                    assert token.startswith("Basic ")
                    return json.dumps({"authorizationToken": "fixture-auth", "apiInfo": {"storageApi": {
                        "apiUrl": native, "downloadUrl": download, "s3ApiUrl": endpoint,
                        "allowed": {"buckets": [{"name": "synthetic-bucket", "id": "fixture-bucket"}],
                                    "namePrefix": "quantself/",
                                    "capabilities": sorted(verify.UPLOAD_CAPABILITIES)}}}}).encode()
                if operation == "b2_get_upload_url":
                    assert url == native + "/b2api/v4/b2_get_upload_url"
                    assert token == "fixture-auth"
                    assert json.loads(kwargs["body"]) == {"bucketId": "fixture-bucket"}
                    return json.dumps({"bucketId": "fixture-bucket", "uploadUrl": upload,
                                       "authorizationToken": "fixture-upload-auth"}).encode()
                if operation == "b2_upload_file":
                    assert token == "fixture-upload-auth"
                    assert url == upload
                    name = kwargs["headers"]["X-Bz-File-Name"]
                    if name.startswith("vault/"):
                        raise verify.ApiError(operation, 401, "unauthorized")
                    return json.dumps({"bucketId": "fixture-bucket", "fileName": name, "action": "upload",
                                       "contentSha1": kwargs["headers"]["X-Bz-Content-Sha1"],
                                       "fileId": "fixture-file"}).encode()
                if operation == "b2_download_file_by_id":
                    assert token == "fixture-auth"
                    assert url == download + "/b2api/v4/b2_download_file_by_id?fileId=fixture-file"
                    return b"fixture"
                raise AssertionError(operation)

        b2 = verify.B2(FixtureTransport(), ENV, endpoint, "synthetic-bucket", "quantself")
        self.assertEqual(b2.upload("quantself/synthetic", b"fixture"), "fixture-file")
        verify.expect_error("Cross write", lambda: b2.upload("vault/synthetic", b"fixture"))
        self.assertEqual(b2.read_version("fixture-file"), b"fixture")
        self.assertEqual(b2.upload("quantself/synthetic", b"fixture"), "fixture-file")
        self.assertEqual(operations.count("b2_get_upload_url"), 2)


if __name__ == "__main__":
    unittest.main()
