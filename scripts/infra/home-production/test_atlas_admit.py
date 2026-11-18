import importlib.util
import json
import os
from io import StringIO
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).with_name("atlas-admit.py")
spec = importlib.util.spec_from_file_location("atlas_admit", SCRIPT)
atlas = importlib.util.module_from_spec(spec)
spec.loader.exec_module(atlas)


class AtlasAdmissionTest(unittest.TestCase):
    def setUp(self):
        temporary_directory = self.enterContext(tempfile.TemporaryDirectory())
        self.scratch = Path(temporary_directory).resolve()
        self.checkout_root = self.scratch / "private"
        self.checkout_root.mkdir(mode=0o700)
        self.remote = self.scratch / "repository"
        self.remote.mkdir()
        self.git(self.remote, "init", "--quiet", "--template=", "--object-format=sha1", "--initial-branch=main")
        self.first_sha = self.commit("first on main")
        self.git(self.remote, "checkout", "--quiet", "-b", "fork")
        self.fork_sha = self.commit("fork change")
        self.git(self.remote, "update-ref", "refs/pull/1/head", self.fork_sha)
        self.git(self.remote, "checkout", "--quiet", "main")
        self.enterContext(patch.object(atlas, "CANONICAL_REPOSITORY", self.remote.as_uri()))
        self.enterContext(patch.object(atlas, "GIT_PROTOCOL", "file"))

    def git(self, directory, *args):
        return atlas.git(directory, "-c", "user.name=Atlas Fixture", "-c", "user.email=atlas@example.test", *args)

    def commit(self, contents):
        (self.remote / "tracked").write_text(contents)
        self.git(self.remote, "add", "tracked")
        self.git(self.remote, "commit", "--quiet", "-m", contents)
        return self.git(self.remote, "rev-parse", "HEAD")

    def test_builds_fresh_detached_checkouts_from_main_only(self):
        first = atlas.admit(self.checkout_root, self.first_sha)
        second_sha = self.commit("updated main")
        second = atlas.admit(self.checkout_root)
        self.assertEqual(first["commit"], self.first_sha)
        self.assertEqual(second["commit"], second_sha)

        for result, expected_contents in [(first, "first on main"), (second, "updated main")]:
            checkout = Path(result["checkout"])
            self.assertEqual(checkout.parent, self.checkout_root)
            self.assertEqual(checkout.stat().st_mode & 0o777, 0o700)
            self.assertEqual((checkout / "tracked").read_text(), expected_contents)
            self.assertEqual(self.git(checkout, "rev-parse", "HEAD"), result["commit"])
            self.assertEqual(self.git(checkout, "status", "--porcelain"), "")
            self.assertEqual(self.git(checkout, "for-each-ref", "--format=%(refname)"), atlas.FETCHED_REF)
            with self.assertRaises(subprocess.CalledProcessError):
                self.git(checkout, "symbolic-ref", "--quiet", "HEAD")

    def test_rejects_stale_main_fork_and_untrusted_sha_inputs(self):
        self.commit("updated main")
        for revision in (self.first_sha, self.fork_sha, "main", "refs/pull/1/head", self.first_sha[:7]):
            with self.subTest(revision=revision), self.assertRaises(ValueError):
                atlas.admit(self.checkout_root, revision)
        self.assertEqual(list(self.checkout_root.iterdir()), [])

    def test_fetch_failure_does_not_reuse_an_old_checkout(self):
        first = atlas.admit(self.checkout_root)
        self.git(self.remote, "checkout", "--quiet", "fork")
        self.git(self.remote, "branch", "-D", "main")
        with self.assertRaises(subprocess.CalledProcessError):
            atlas.admit(self.checkout_root, self.first_sha)
        with self.assertRaises(subprocess.CalledProcessError):
            atlas.check_main(self.first_sha)
        self.assertEqual(list(self.checkout_root.iterdir()), [Path(first["checkout"])])

    def test_rejects_nonprivate_and_symlinked_roots(self):
        self.checkout_root.chmod(0o755)
        with self.assertRaisesRegex(ValueError, "mode 0700"):
            atlas.admit(self.checkout_root)
        self.checkout_root.chmod(0o700)
        alias = self.scratch / "alias"
        alias.symlink_to(self.checkout_root)
        with self.assertRaisesRegex(ValueError, "absolute, resolved"):
            atlas.admit(alias)

    def test_ignores_git_environment_from_caller(self):
        with patch.dict(os.environ, {
            "GIT_DIR": str(self.remote / ".git"),
            "GIT_WORK_TREE": str(self.remote),
            "GIT_CONFIG_COUNT": "1",
            "GIT_CONFIG_KEY_0": "url.file:///missing.insteadOf",
            "GIT_CONFIG_VALUE_0": self.remote.as_uri(),
            "GIT_ALLOW_PROTOCOL": "https",
        }):
            result = atlas.admit(self.checkout_root)
        self.assertEqual(result["commit"], self.first_sha)
        self.assertEqual(self.git(self.remote, "status", "--porcelain"), "")

    def test_check_only_requires_current_main_without_creating_checkout(self):
        argv = [str(SCRIPT), "--check-only", "--expected-sha", self.first_sha]
        with patch.object(sys, "argv", argv), patch("builtins.print") as output:
            atlas.main()
        self.assertEqual(json.loads(output.call_args.args[0]), {"commit": self.first_sha})

        second_sha = self.commit("updated main")
        self.assertEqual(atlas.check_main(second_sha), {"commit": second_sha})
        for revision in (self.first_sha, self.fork_sha, "main"):
            with self.subTest(revision=revision), self.assertRaises(ValueError):
                atlas.check_main(revision)
        self.assertEqual(list(self.checkout_root.iterdir()), [])

    def test_check_only_rejects_missing_expected_sha(self):
        with patch.object(sys, "argv", [str(SCRIPT), "--check-only"]):
            with patch.object(sys, "stderr", StringIO()), self.assertRaises(SystemExit) as error:
                atlas.main()
            self.assertEqual(error.exception.code, 2)

    def test_trusted_credential_helper_is_scoped_to_remote_git_operations(self):
        helper = self.scratch / "private-helper"
        helper.write_text("#!/bin/sh\nexit 0\n")
        helper.chmod(0o700)
        with (
            patch.object(atlas, "validate_credential_helper") as validate,
            patch.object(atlas.subprocess, "run", wraps=subprocess.run) as run,
        ):
            atlas.admit(self.checkout_root, self.first_sha, helper)
            atlas.check_main(self.first_sha, helper)
        self.assertEqual([call.args for call in validate.call_args_list], [(helper,), (helper,)])
        authenticated_commands = []
        for call in run.call_args_list:
            argv = call.args[0]
            helper_config = f"credential.helper={helper}"
            if helper_config in argv:
                authenticated_commands.append(argv)
                self.assertLess(argv.index("credential.helper="), argv.index(helper_config))
                self.assertIn("credential.useHttpPath=true", argv)
                self.assertIn(self.remote.as_uri(), argv)
                self.assertNotIn("HOME", call.kwargs["env"])
        self.assertEqual(len(authenticated_commands), 2)
        self.assertIn("fetch", authenticated_commands[0])
        self.assertIn("ls-remote", authenticated_commands[1])

    def test_ssh_fetch_and_late_main_recheck_use_only_the_pinned_remote(self):
        key = self.scratch / "deploy-key"
        key.touch(mode=0o600)
        ssh_fixture = self.scratch / "ssh-fixture"
        ssh_fixture.write_text(
            "#!/bin/sh\n" + shlex.join(["exec", "/usr/bin/git", "upload-pack", str(self.remote)]) + "\n"
        )
        ssh_fixture.chmod(0o700)
        remote_calls = []

        def run_git(argv, **kwargs):
            env = kwargs["env"]
            if "GIT_SSH_COMMAND" in env:
                self.assertEqual(argv[-2], "ssh://git@github.com/devdogfish/quantself.git")
                self.assertEqual(env["GIT_ALLOW_PROTOCOL"], "ssh")
                self.assertEqual(env["GIT_SSH_VARIANT"], "ssh")
                self.assertNotIn("HOME", env)
                self.assertNotIn("SSH_AUTH_SOCK", env)
                ssh = shlex.split(env["GIT_SSH_COMMAND"])
                self.assertEqual(ssh[:3], ["/usr/bin/ssh", "-F", os.devnull])
                self.assertEqual(ssh[-2:], ["-i", str(key)])
                for option in ("IdentitiesOnly=yes", "IdentityAgent=none", "StrictHostKeyChecking=yes",
                               "HostKeyAlgorithms=ssh-ed25519", "UpdateHostKeys=no", "ConnectTimeout=10",
                               "ServerAliveInterval=10", "ServerAliveCountMax=2"):
                    self.assertIn(option, ssh)
                pin = Path(next(arg.split("=", 1)[1] for arg in ssh if arg.startswith("UserKnownHostsFile=")))
                self.assertEqual(pin.read_text(), atlas.GITHUB_HOST_KEY + "\n")
                self.assertEqual(pin.parent.stat().st_mode & 0o777, 0o700)
                remote_calls.append((argv[-1], pin))
                # Git still runs both operations. Replace only the SSH exec with the local upload-pack fixture.
                kwargs["env"] = dict(env, GIT_SSH_COMMAND=shlex.quote(str(ssh_fixture)))
            return subprocess_run(argv, **kwargs)

        subprocess_run = subprocess.run
        with (
            patch.object(atlas, "validate_deploy_key") as validate,
            patch.object(atlas.subprocess, "run", side_effect=run_git),
        ):
            result = atlas.admit(self.checkout_root, self.first_sha, deploy_key=key)
            self.assertEqual(result["commit"], self.first_sha)
            self.assertEqual(atlas.check_main(self.first_sha, deploy_key=key), {"commit": self.first_sha})
            self.commit("new main")
            with self.assertRaisesRegex(ValueError, "but canonical main is"):
                atlas.check_main(self.first_sha, deploy_key=key)
        self.assertEqual([call.args for call in validate.call_args_list], [(key,)] * 3)
        self.assertEqual([ref for ref, _ in remote_calls], [
            f"{atlas.MAIN_REF}:{atlas.FETCHED_REF}", atlas.MAIN_REF, atlas.MAIN_REF,
        ])
        self.assertTrue(all(not pin.parent.exists() for _, pin in remote_calls))

    def test_ssh_failure_removes_checkout_and_suppresses_stderr(self):
        key = self.scratch / "deploy-key"
        subprocess_run = subprocess.run

        def fail_ssh(argv, **kwargs):
            if "GIT_SSH_COMMAND" in kwargs["env"]:
                raise subprocess.CalledProcessError(128, argv, stderr="private SSH diagnostic")
            return subprocess_run(argv, **kwargs)

        args = [str(SCRIPT), "--checkout-root", str(self.checkout_root), "--deploy-key", str(key)]
        stderr = StringIO()
        with (
            patch.object(atlas, "validate_deploy_key"),
            patch.object(atlas.subprocess, "run", side_effect=fail_ssh),
            patch.object(sys, "argv", args),
            patch.object(sys, "stderr", stderr),
            self.assertRaises(SystemExit) as error,
        ):
            atlas.main()
        self.assertEqual(error.exception.code, 1)
        self.assertNotIn("private SSH diagnostic", stderr.getvalue())
        self.assertEqual(list(self.checkout_root.iterdir()), [])

    def test_deploy_key_path_rejects_alias_ssh_tokens_and_public_mode(self):
        key = self.scratch / "deploy-key"
        key.touch(mode=0o644)
        alias = self.scratch / "deploy-key-alias"
        alias.symlink_to(key)
        for path in (key, alias, Path("/private/ssh/%h"), Path("deploy-key")):
            with self.subTest(path=path), self.assertRaises(ValueError):
                atlas.validate_deploy_key(path)

    def test_rejects_credential_helper_symlink_shell_syntax_and_nonprivate_modes(self):
        alias = self.scratch / "helper-link"
        alias.symlink_to("/usr/bin/true")
        writable = self.scratch / "helper"
        writable.touch()
        writable.chmod(0o777)
        for helper in (alias, Path("/usr/bin/true;false"), writable, Path("helper")):
            with self.subTest(helper=helper), self.assertRaises(ValueError):
                atlas.check_main(self.first_sha, helper)
        for mode in (0o755, 0o744, 0o701, 0o710):
            writable.chmod(mode)
            with self.subTest(mode=oct(mode)), self.assertRaisesRegex(ValueError, "private executable"):
                atlas.validate_credential_helper(writable)

    def test_cli_omits_git_stderr_from_auth_failure(self):
        stderr = StringIO()
        argv = [
            str(SCRIPT), "--check-only", "--expected-sha", self.first_sha,
            "--credential-helper", "/usr/bin/true",
        ]
        failed = subprocess.CalledProcessError(128, ["git"], stderr="sensitive helper stderr")
        with (
            patch.object(sys, "argv", argv),
            patch.object(sys, "stderr", stderr),
            patch.object(atlas, "validate_credential_helper"),
            patch.object(atlas.subprocess, "run", side_effect=failed),
            self.assertRaises(SystemExit) as error,
        ):
            atlas.main()
        self.assertEqual(error.exception.code, 1)
        self.assertIn("Git exited with status 128", stderr.getvalue())
        self.assertNotIn(failed.stderr, stderr.getvalue())

    def test_cli_outputs_result_json_and_rejects_source_arguments(self):
        with patch.object(sys, "argv", [str(SCRIPT), "--checkout-root", str(self.checkout_root)]):
            with patch("builtins.print") as output:
                atlas.main()
            result = json.loads(output.call_args.args[0])
        self.assertEqual(result["commit"], self.first_sha)
        for extra in (["--ref", "fork"], ["--repo", str(self.remote)], ["--checkout", str(self.remote)]):
            argv = [str(SCRIPT), "--checkout-root", str(self.checkout_root), *extra]
            with self.subTest(extra=extra), patch.object(sys, "argv", argv):
                with patch.object(sys, "stderr", StringIO()), self.assertRaises(SystemExit) as error:
                    atlas.main()
                self.assertEqual(error.exception.code, 2)


if __name__ == "__main__":
    unittest.main()
