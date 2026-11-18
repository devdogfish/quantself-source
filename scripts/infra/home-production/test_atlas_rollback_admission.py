"""Offline rollback contract. The approval, release facts and switch are local fixtures.

A live caller would need protected dispatch and Owner authorization for
the approval writer. Legacy has no managed release record.
"""

from contextlib import closing, contextmanager
from dataclasses import asdict, dataclass, replace
import fcntl
import hashlib
import json
import os
from pathlib import Path
import runpy
import sqlite3
import stat
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from test_atlas_control_admission import (
    ATTEMPT, CONTROL, CONTROL_REPO_ID, CONTROL_SHA, IMAGE_ID, NOW, POLICY, RUN_ID, SOURCE_SHA, run_fixture,
)
from test_atlas_deploy_journal import BindingConflict, Claim, DeployJournal, ReconciliationRequired
from atlas_rollback_shell_fixture import RollbackShellFixture
from atlas_rollback_workflow_fixture import FIXTURE, WORKFLOW_PATH, RollbackWorkflowFixture


PRIOR_SHA = "d" * 40
SOURCE = runpy.run_path(Path(__file__).with_name("atlas-admit.py"))
PREFLIGHT = runpy.run_path(Path(__file__).with_name("atlas-rollback-preflight.py"))
START_SERVICES = PREFLIGHT["START_SERVICES"]
FIXTURE_TOKEN = "synthetic-control-response"
WORKFLOW_BYTES = FIXTURE.read_bytes()
ROLLBACK_POLICY = CONTROL["RollbackControlPolicy"](
    POLICY.repository, POLICY.repository_id, WORKFLOW_PATH, POLICY.workflow_id + 1, POLICY.owner_id,
    POLICY.control_sha, "03c2ac89ca4757cf69d5910b52fb1bf1dbcb612b78d8570855fb1a688ef5e0bf",
)


@dataclass(frozen=True)
class RollbackRequest:
    canonical_sha: str
    target_sha: str
    image_id: str
    prior_slot: str
    run_id: str
    attempt: str

    def __post_init__(self):
        CONTROL["Request"](self.canonical_sha, self.run_id, self.attempt)
        Claim(str(CONTROL_REPO_ID), self.run_id, self.attempt, self.target_sha, self.image_id)
        if self.prior_slot not in PREFLIGHT["MANAGED_SLOTS"]:
            raise ValueError("Expected a managed rollback slot")

    @property
    def approval(self):
        return PREFLIGHT["ApprovedRollback"](self.canonical_sha, self.target_sha, self.image_id, self.prior_slot)

    @property
    def control_request(self):
        return CONTROL["Request"](self.canonical_sha, self.run_id, self.attempt)

    @property
    def control_title(self):
        return CONTROL["rollback_title"](self.approval)


APPROVED = RollbackRequest(SOURCE_SHA, PRIOR_SHA, IMAGE_ID, "blue", str(RUN_ID), str(ATTEMPT))


@dataclass(frozen=True)
class RollbackClaim(Claim):
    canonical_sha: str
    prior_slot: str
    control_binding: str

    @property
    def binding(self):
        return self.attempt, self.canonical_sha, self.prior_slot, self.source_sha, self.image_id, self.control_binding


def rollback_claim(policy, request):
    return RollbackClaim(
        str(policy.repository_id), request.run_id, request.attempt, request.target_sha, request.image_id,
        request.canonical_sha, request.prior_slot,
        json.dumps({"control_policy": asdict(policy), "control_ref": "refs/heads/main"}, sort_keys=True),
    )


class RehearsalJournal(DeployJournal):
    """Add an exact rollback binding to the fixture database only."""

    def initialize(self):
        super().initialize()
        with self._lock(), self._database() as database:
            database.execute("""
                CREATE TABLE rollback_binding (
                    repo_id TEXT NOT NULL, run_id TEXT NOT NULL, attempt TEXT NOT NULL,
                    canonical_sha TEXT NOT NULL, prior_slot TEXT NOT NULL,
                    target_sha TEXT NOT NULL, image_id TEXT NOT NULL, control_binding TEXT NOT NULL,
                    PRIMARY KEY (repo_id, run_id)
                )
            """)

    def _lookup(self, database, claim):
        # DeployJournal calls this under the shared lock before either replay path.
        rollback = database.execute("""
            SELECT attempt, canonical_sha, prior_slot, target_sha, image_id, control_binding
            FROM rollback_binding WHERE repo_id = ? AND run_id = ?
        """, claim.key[:2]).fetchone()
        if rollback is not None:
            if not isinstance(claim, RollbackClaim) or rollback != claim.binding:
                raise BindingConflict("Run is bound to a different rollback request")
        elif isinstance(claim, RollbackClaim) and database.execute("""
            SELECT 1 FROM deploy_claim WHERE repo_id = ? AND run_id = ? LIMIT 1
        """, claim.key[:2]).fetchone():
            raise BindingConflict("Run is already bound to a promotion receipt")
        return super()._lookup(database, claim)

    def bind_rollback(self, claim):
        # Called within the prepare callback. Persist before the switch can claim.
        # If interrupted between this write and the claim, only the exact request can retry.
        with self._database() as database:
            database.execute("""
                INSERT INTO rollback_binding VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT (repo_id, run_id) DO NOTHING
            """, (*claim.key[:2], *claim.binding))


def submit_rollback(
    journal, request, *, policy, require_approval, fetch_control, read_workflow, prepare_plan, confirm_plan,
    check_main, make_switch,
):
    """Run admission and the switch through the same journal lock."""
    claim = rollback_claim(policy, request)
    plan = None

    def authorize(_):
        require_approval(request)
        CONTROL["verify_rollback_operation"](
            policy, request.control_request, request.approval, FIXTURE_TOKEN,
            read_workflow=read_workflow, fetch_json=fetch_control, now=NOW,
        )

    def prepare(bound):
        nonlocal plan
        plan = prepare_plan(request.approval)
        confirm_plan(request.approval, plan)
        check_main(request.canonical_sha)
        require_approval(request)
        journal.bind_rollback(bound)

    return journal.submit(claim, lambda _: make_switch(request, plan), authorize=authorize, prepare=prepare)


# A real subprocess, with no access to release tooling. Its only write is the fixture event.
MOCK_SWITCH = """
import fcntl, json, sys
from pathlib import Path
root = Path(sys.argv[1])
with (root / "deploy.lock").open("r+") as lock:
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        pass
    else:
        raise AssertionError("Switch ran outside the deploy lock")
    with (root / "switches").open("a") as events:
        events.write(json.dumps(sys.argv[3:]) + "\\n")
sys.exit(int(sys.argv[2]))
"""


class RollbackAdmissionTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.lock = self.root / "deploy.lock"
        self.lock.touch()
        self.switches = self.root / "switches"
        self.state = self.root / "release-state"
        self.state.mkdir(mode=0o700)
        (self.state / "blue").mkdir(mode=0o700)
        self.active = self.state / "active"
        self.release = self.state / "blue/release"
        self.pending = self.state / "pending"
        self.names = tuple(f"quantself-blue-{service}-1" for service in START_SERVICES)
        self.ids = {name: f"{index:064x}" for index, name in enumerate(self.names, 1)}
        self.start_ids = tuple(self.ids.values())
        self.images = dict.fromkeys(self.names, IMAGE_ID)
        self.images["quantself-blue-gateway-1"] = "sha256:" + "0" * 64
        self.swap_after_lookup = False
        self.change_plan = lambda plan: plan
        self.inspect_count = 0
        self.control_reads = []
        self.source_reads = []
        self.owner_uid = os.getuid()
        self.journal = RehearsalJournal(self.lock, self.root / "deploy.sqlite")
        self.journal.initialize()
        self.approvals = self.root.resolve() / "approvals"
        self.approvals.mkdir(mode=0o700)
        self.policy = ROLLBACK_POLICY
        self.workflow_reader = lambda _commit, _path: WORKFLOW_BYTES
        self.workflow_reads = []
        self.approval_owner_uid = 0
        self.approval_now = int(NOW.timestamp())
        self.approval_expiry = self.approval_now + 120
        self.stage_approval()
        self.promotion = Claim(str(CONTROL_REPO_ID), str(RUN_ID), str(ATTEMPT), PRIOR_SHA, IMAGE_ID)
        self.claim = rollback_claim(self.policy, APPROVED)
        self.run = run_fixture()
        self.run.update(display_title=APPROVED.control_title, path=self.policy.workflow_path,
                        workflow_id=self.policy.workflow_id)
        self.main = SOURCE_SHA
        self.control_main = CONTROL_SHA
        self.exit_code = 0
        self.write_record(self.active, "green\nblue\n")
        self.write_record(self.release, f"{PRIOR_SHA}\n{IMAGE_ID}\n")

    @staticmethod
    def write_record(path, contents):
        path.write_text(contents)
        path.chmod(0o600)

    def assert_lock_held(self):
        with self.lock.open("r+") as lock:
            with self.assertRaises(BlockingIOError):
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)

    def approval_path(self, request=APPROVED):
        return CONTROL["rollback_approval_path"](self.approvals, self.policy, request.control_request)

    def stage_approval(self, request=APPROVED, *, expires_at=None):
        with self.approval_trust():
            return CONTROL["publish_rollback_approval"](
                self.approvals, self.policy, request.control_request, request.approval,
                expires_at=self.approval_expiry if expires_at is None else expires_at,
                lock=self.journal._lock, now=self.approval_now,
            )

    def revoke_approval(self, request=APPROVED):
        with self.approval_trust():
            return CONTROL["revoke_rollback_approval"](
                self.approvals, self.policy, request.control_request, lock=self.journal._lock,
            )

    def corrupt_approval(self, request=APPROVED, *, contents=None):
        if contents is None:
            contents = json.dumps(CONTROL["rollback_approval_record"](
                self.policy, request.control_request, request.approval, expires_at=self.approval_expiry,
            ))
        with self.journal._lock():
            self.write_record(self.approval_path(request), contents)

    @contextmanager
    def approval_trust(self):
        real_stat = Path.stat
        real_fstat = os.fstat

        def path_info(path, **kwargs):
            info = real_stat(path, **kwargs)
            # Only the host ancestors outside the fixture emulate production permissions.
            mode = info.st_mode if path.is_relative_to(self.approvals.parent) else info.st_mode & ~0o022
            return SimpleNamespace(st_uid=0, st_mode=mode)

        def file_info(descriptor):
            return SimpleNamespace(st_uid=self.approval_owner_uid, st_mode=real_fstat(descriptor).st_mode)

        with patch.object(Path, "stat", path_info), patch("os.fstat", side_effect=file_info):
            yield

    def require_approval(self, request):
        self.assert_lock_held()
        with self.approval_trust():
            CONTROL["require_rollback_approval"](
                self.approvals, self.policy, request.control_request, request.approval, now=self.approval_now,
            )

    def fetch_control(self, path, token):
        self.assert_lock_held()
        self.assertEqual(token, FIXTURE_TOKEN)
        self.control_reads.append(path)
        prefix = f"/repos/{self.policy.repository}"
        if path == f"{prefix}/git/ref/heads/main":
            return {"ref": "refs/heads/main", "object": {"type": "commit", "sha": self.control_main}}
        self.assertEqual(path, f"{prefix}/actions/runs/{RUN_ID}")
        return self.run

    def read_workflow(self, commit, path):
        self.assert_lock_held()
        self.workflow_reads.append((commit, path))
        return self.workflow_reader(commit, path)

    def check_main(self, expected_sha):
        def git_main(workspace, args, ref, credential_helper, deploy_key):
            self.assert_lock_held()
            self.assertTrue(workspace.is_dir())
            self.assertEqual((args, ref, credential_helper, deploy_key), (
                ("ls-remote", "--exit-code", "--refs"), "refs/heads/main", None, None,
            ))
            self.source_reads.append(ref)
            return f"{self.main}\t{ref}"

        check_main = SOURCE["check_main"]
        with patch.dict(check_main.__globals__, remote_git=git_main):
            check_main(expected_sha)

    def inspect(self, command):
        self.assert_lock_held()
        self.inspect_count += 1
        self.assertEqual(command[:4], [
            "container", "inspect", "--format", "{{.Name}} {{.Id}} {{.Image}}",
        ])
        references = tuple(command[4:])
        self.assertIn(references, (self.names, self.start_ids))
        lines = [
            f"/{name} {container_id} {self.images[name]}" for name, container_id in self.ids.items()
            if name in self.images and (name in references or container_id in references)
        ]
        if references == self.names and self.swap_after_lookup:
            app, api = "quantself-blue-app-1", "quantself-blue-api-1"
            self.ids[app], self.ids[api] = self.ids[api], self.ids[app]
        return "\n".join(lines)

    def prepare_plan(self, approval):
        self.assert_lock_held()
        plan = PREFLIGHT["prepare_rollback"](self.state, approval, owner_uid=self.owner_uid, inspect=self.inspect)
        return self.change_plan(plan)

    def confirm_plan(self, approval, plan):
        self.assert_lock_held()
        return PREFLIGHT["confirm_rollback"](self.state, approval, plan, owner_uid=self.owner_uid, inspect=self.inspect)

    def submit(self, request=APPROVED, *, make_switch=None):
        if make_switch is None:
            def make_switch(bound, plan):
                return [
                    sys.executable, "-I", "-B", "-c", MOCK_SWITCH, str(self.root), str(self.exit_code),
                    bound.canonical_sha, bound.target_sha, bound.image_id, bound.prior_slot, bound.run_id, bound.attempt,
                    *plan.start_ids,
                ]
        return submit_rollback(
            self.journal, request, policy=self.policy, require_approval=self.require_approval,
            fetch_control=self.fetch_control, read_workflow=self.read_workflow,
            prepare_plan=self.prepare_plan, confirm_plan=self.confirm_plan,
            check_main=self.check_main, make_switch=make_switch,
        )

    def shell_fixture(self, *, replacement=False):
        containers = {name: (self.ids[name], self.images[name]) for name in self.names}
        if replacement:
            containers["quantself-blue-api-1"] = ("f" * 64, IMAGE_ID)
        return RollbackShellFixture(self, containers)

    def configure_local_workflow(self):
        workflow = RollbackWorkflowFixture(self.root)
        self.assertTrue(self.revoke_approval())
        self.policy = replace(self.policy, control_sha=workflow.control_sha)
        self.claim = rollback_claim(self.policy, APPROVED)
        self.control_main = workflow.control_sha
        self.workflow_reader = workflow.read_workflow
        self.run.update(head_sha=workflow.control_sha, path=WORKFLOW_PATH)
        title = workflow.workflow["run-name"]
        for field in ("canonical_sha", "target_sha", "image_id", "prior_slot"):
            title = title.replace("${{ inputs." + field + " }}", getattr(APPROVED, field))
        self.run["display_title"] = title
        self.stage_approval()
        return workflow

    def submit_envelope(self, result, shell):
        result.check_returncode()
        action, run, attempt, canonical_sha, target_sha, image, slot = result.stdout.splitlines()
        if action != "rollback":
            raise ValueError("Unexpected rollback dispatch operation")
        request = RollbackRequest(canonical_sha, target_sha, image, slot, run, attempt)
        return self.submit(request, make_switch=shell.command)

    def assert_no_claim_or_switch(self):
        self.assertFalse(self.switches.exists())
        with closing(sqlite3.connect(self.root / "deploy.sqlite")) as database:
            self.assertEqual(database.execute("SELECT count(*) FROM deploy_claim").fetchone(), (0,))
            self.assertEqual(database.execute("SELECT count(*) FROM rollback_binding").fetchone(), (0,))

    def test_approved_existing_digest_switches_once_and_replay_cannot_reverse_it(self):
        first = self.submit()
        self.write_record(self.active, "blue\ngreen\n")
        self.journal = RehearsalJournal(self.lock, self.journal.journal_path)
        self.assertEqual(self.submit(), first)
        self.assertEqual(self.journal.reconcile(self.claim, lambda _: self.fail("New evidence requested")), first)
        self.assertEqual(first.outcome, "succeeded")
        self.assertEqual(first.claim, self.claim)
        self.assertEqual(self.inspect_count, 2)
        self.assertEqual(
            [json.loads(line) for line in self.switches.read_text().splitlines()],
            [[SOURCE_SHA, PRIOR_SHA, IMAGE_ID, "blue", str(RUN_ID), str(ATTEMPT), *self.start_ids]],
        )

    def test_promotion_receipt_cannot_acknowledge_rollback(self):
        shell = self.shell_fixture()
        self.journal.submit(self.promotion, lambda _: [sys.executable, "-I", "-B", "-c", "pass"])
        with self.assertRaisesRegex(ValueError, "bound to"):
            self.submit(make_switch=shell.command)
        self.assertFalse(shell.events_path.exists())
        self.assertEqual(self.inspect_count, 0)

    def test_rollback_receipt_cannot_acknowledge_promotion(self):
        self.submit()
        for claim in (self.promotion, replace(self.promotion, attempt=str(ATTEMPT + 1))):
            with self.assertRaisesRegex(ValueError, "bound to"):
                self.journal.submit(claim, lambda _: self.fail("Promotion reached a switch"))

    def test_changed_approval_and_run_cannot_replay_rollback_receipt(self):
        shell = self.shell_fixture()
        self.submit(make_switch=shell.command)
        events = shell.events()
        for change in (
            {"canonical_sha": CONTROL_SHA}, {"prior_slot": "green"},
            {"target_sha": CONTROL_SHA}, {"image_id": "sha256:" + "f" * 64},
            {"attempt": str(ATTEMPT + 1)},
        ):
            request = replace(APPROVED, **change)
            self.corrupt_approval(request)
            self.run["run_attempt"] = int(request.attempt)
            self.run["display_title"] = request.control_title
            with self.subTest(change=change), self.assertRaisesRegex(ValueError, "bound to"):
                self.submit(request, make_switch=shell.command)
        self.assertEqual(shell.events(), events)
        self.assertEqual(self.inspect_count, 2)

    def test_rejects_substituted_inputs_and_attempt_before_claim(self):
        for field, value in {
            "canonical_sha": CONTROL_SHA, "target_sha": SOURCE_SHA, "image_id": "sha256:" + "f" * 64,
            "prior_slot": "green", "run_id": str(RUN_ID + 1), "attempt": str(ATTEMPT + 1),
        }.items():
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "not approved"):
                self.submit(replace(APPROVED, **{field: value}))
            self.assert_no_claim_or_switch()

    def test_rejects_wrong_run_even_with_an_approved_request(self):
        original = self.run.copy()
        for field, value in {
            "run_attempt": ATTEMPT + 1, "id": RUN_ID + 1, "head_sha": SOURCE_SHA,
            "display_title": run_fixture()["display_title"],
            "head_repository": {"id": 999, "full_name": "fixture/fork"},
        }.items():
            self.run = original | {field: value}
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "Control run identity rejected"):
                self.submit()
            self.assert_no_claim_or_switch()
        self.run = original
        self.control_main = SOURCE_SHA
        with self.assertRaisesRegex(ValueError, "Control run identity rejected"):
            self.submit()
        self.assert_no_claim_or_switch()

    def test_approval_requires_exact_pinned_policy_and_unambiguous_json(self):
        observed = json.loads(self.approval_path().read_text())
        for fields in (
            {"action": "promote"}, {"format": True}, {"run_id": "999"}, {"attempt": "9"},
            {"control_ref": "refs/heads/topic"},
            {"control_policy": observed["control_policy"] | {"workflow_id": self.policy.workflow_id + 1}},
            {"control_policy": observed["control_policy"] | {"control_sha": SOURCE_SHA}},
            {"prior_slot": "green"}, {"image_id": "sha256:" + "0" * 64},
        ):
            self.corrupt_approval(contents=json.dumps(observed | fields))
            with self.subTest(fields=fields), self.assertRaisesRegex(ValueError, "not approved"):
                self.submit()
        duplicate = json.dumps(observed)[:-1] + ', "action": "rollback"}'
        self.corrupt_approval(contents=duplicate)
        with self.assertRaisesRegex(ValueError, "Duplicate rollback approval field"):
            self.submit()
        self.corrupt_approval(contents=" " * 4097)
        with self.assertRaisesRegex(ValueError, "Control policy too large"):
            self.submit()
        self.assert_no_claim_or_switch()
        self.assertEqual(self.control_reads, [])

    def test_approval_rejects_nonprivate_owner_mode_and_file_type(self):
        path = self.approval_path()
        self.approvals.chmod(0o770)
        with self.assertRaisesRegex(ValueError, "root-controlled policy directory"):
            self.submit()
        self.approvals.chmod(0o700)
        path.chmod(0o640)
        with self.assertRaisesRegex(ValueError, "root-controlled control policy"):
            self.submit()
        path.chmod(0o600)
        self.approval_owner_uid = 999
        with self.assertRaisesRegex(ValueError, "root-controlled control policy"):
            self.submit()
        self.approval_owner_uid = 0
        sibling = path.with_suffix(".old")
        path.rename(sibling)
        path.symlink_to(sibling)
        with self.assertRaisesRegex(ValueError, "Expected resolved control policy path"):
            self.submit()
        path.unlink()
        os.mkfifo(path, mode=0o600)
        with self.assertRaisesRegex(ValueError, "root-controlled control policy"):
            self.submit()
        self.assert_no_claim_or_switch()
        self.assertEqual(self.control_reads, [])

    def test_revoked_approval_blocks_replay_but_preserves_historical_receipt(self):
        shell = self.shell_fixture()
        original = self.submit(make_switch=shell.command)
        events = shell.events()
        self.approval_now = self.approval_expiry
        with self.assertRaisesRegex(ValueError, "approval expired"):
            self.submit(make_switch=shell.command)
        self.assertTrue(self.revoke_approval())
        self.assertFalse(self.revoke_approval())
        self.journal = RehearsalJournal(self.lock, self.journal.journal_path)
        with self.assertRaisesRegex(ValueError, "not approved"):
            self.submit(make_switch=shell.command)
        self.assertEqual(self.journal.reconcile(self.claim, lambda _: self.fail("Already settled")), original)
        self.assertEqual(shell.events(), events)
        self.assertEqual(len(self.control_reads), 2)

    def test_approval_publish_fsyncs_before_atomic_link_and_never_overwrites(self):
        request = replace(APPROVED, attempt=str(ATTEMPT + 1))
        path = self.approval_path(request)
        events = []
        real_fsync, real_link = os.fsync, os.link

        def observe_fsync(fd):
            self.assert_lock_held()
            events.append("directory sync" if stat.S_ISDIR(os.fstat(fd).st_mode) else "file sync")
            real_fsync(fd)

        def observe_link(temporary, target, **options):
            self.assert_lock_held()
            self.assertEqual(target, path)
            self.assertFalse(path.exists())
            self.assertEqual(json.loads(Path(temporary).read_text())["attempt"], request.attempt)
            events.append("link")
            real_link(temporary, target, **options)

        with patch("os.fsync", side_effect=observe_fsync), patch("os.link", side_effect=observe_link):
            self.assertEqual(self.stage_approval(request), path)
        self.assertEqual(events, ["file sync", "link", "directory sync"])
        original = path.read_bytes()
        with self.assertRaises(FileExistsError):
            self.stage_approval(request, expires_at=self.approval_expiry + 1)
        self.assertEqual(path.read_bytes(), original)
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)

        competing = replace(request, attempt=str(ATTEMPT + 2))
        competing_path = self.approval_path(competing)

        def collide(temporary, target, **options):
            self.write_record(target, "competing file")
            real_link(temporary, target, **options)

        with patch("os.link", side_effect=collide), self.assertRaises(FileExistsError):
            self.stage_approval(competing)
        self.assertEqual(competing_path.read_text(), "competing file")
        self.assertEqual(list(self.approvals.glob(".rollback-approval-*")), [])

    def test_writer_and_revoker_share_deploy_lock_and_scope_each_attempt(self):
        other = replace(APPROVED, attempt=str(ATTEMPT + 1))
        with self.journal._lock():
            with self.assertRaises(BlockingIOError):
                self.stage_approval(other)
            with self.assertRaises(BlockingIOError):
                self.revoke_approval()
        self.assertFalse(self.approval_path(other).exists())
        self.assertTrue(self.approval_path().exists())
        self.stage_approval(other)
        self.assertTrue(self.revoke_approval())
        self.assertTrue(self.approval_path(other).exists())
        self.assertFalse(self.approval_path().exists())

    def test_approval_expires_before_submission_and_during_preflight(self):
        self.approval_now = self.approval_expiry
        with self.assertRaisesRegex(ValueError, "approval expired"):
            self.submit()
        with self.assertRaisesRegex(ValueError, "approval expired"):
            self.stage_approval(replace(APPROVED, attempt=str(ATTEMPT + 1)))
        self.assertEqual(self.control_reads, [])
        self.assert_no_claim_or_switch()
        self.approval_now -= 1

        def expire(plan):
            self.approval_now = self.approval_expiry
            return plan

        self.change_plan = expire
        with self.assertRaisesRegex(ValueError, "approval expired"):
            self.submit()
        self.assertEqual(len(self.control_reads), 2)
        self.assert_no_claim_or_switch()

    def test_writer_and_revoker_reject_symlinks_and_wrong_ownership(self):
        next_attempt = replace(APPROVED, attempt=str(ATTEMPT + 1))
        path = self.approval_path(next_attempt)
        path.symlink_to(self.approvals / "missing")
        with self.assertRaises(FileExistsError):
            self.stage_approval(next_attempt)
        with self.assertRaises(OSError):
            self.revoke_approval(next_attempt)
        self.assertTrue(path.is_symlink())
        path.unlink()
        self.approval_owner_uid = 999
        with self.assertRaisesRegex(ValueError, "Expected root-owned rollback approval"):
            self.stage_approval(next_attempt)
        with self.assertRaisesRegex(ValueError, "root-controlled control policy"):
            self.revoke_approval()
        self.assertFalse(path.exists())
        self.assertTrue(self.approval_path().exists())
        self.assertEqual(list(self.approvals.glob(".rollback-approval-*")), [])
        self.approval_owner_uid = 0
        self.approvals.chmod(0o770)
        with self.assertRaisesRegex(ValueError, "root-controlled policy directory"):
            self.stage_approval(next_attempt)
        with self.assertRaisesRegex(ValueError, "root-controlled policy directory"):
            self.revoke_approval()
        self.approvals.chmod(0o700)
        alias = self.approvals.with_name("approval-alias")
        alias.symlink_to(self.approvals, target_is_directory=True)
        self.approvals = alias
        with self.assertRaisesRegex(ValueError, "Expected resolved control policy directory"):
            self.stage_approval(next_attempt)
        with self.assertRaisesRegex(ValueError, "Expected resolved control policy directory"):
            self.revoke_approval()

    def test_checks_active_and_release_records_before_inspecting_containers(self):
        for path, contents, error in (
            (self.active, "green\nlegacy\n", "Legacy rollback"),
            (self.active, "legacy\nblue\n", "Legacy rollback"),
            (self.active, "green\n\n", "Previous slot changed"),
            (self.active, "blue\ngreen\n", "Previous slot changed"),
            (self.active, "blue\nblue\n", "Previous slot changed"),
            (self.active, "green\nblue\nextra\n", "Previous slot changed"),
            (self.release, f"{SOURCE_SHA}\n{IMAGE_ID}\n", "Retained release record"),
            (self.release, f"{PRIOR_SHA}\nsha256:{'f' * 64}\n", "Retained release record"),
        ):
            original = path.read_text()
            self.write_record(path, contents)
            with self.subTest(contents=contents), self.assertRaisesRegex(ValueError, error):
                self.submit()
            self.assert_no_claim_or_switch()
            self.write_record(path, original)
        self.assertEqual(self.inspect_count, 0)

    def test_rejects_untrusted_record_and_pending_symlink(self):
        self.owner_uid += 1
        with self.assertRaisesRegex(ValueError, "Untrusted retained slot metadata"):
            self.submit()
        self.owner_uid = os.getuid()
        self.release.chmod(0o622)
        with self.assertRaisesRegex(ValueError, "Untrusted retained slot metadata"):
            self.submit()
        self.release.chmod(0o600)
        self.release.rename(self.state / "other")
        self.release.symlink_to(self.state / "other")
        with self.assertRaises(OSError):
            self.submit()
        self.release.unlink()
        (self.state / "other").rename(self.release)
        self.pending.symlink_to(self.state / "missing")
        with self.assertRaisesRegex(ValueError, "pending recovery"):
            self.submit()
        self.assert_no_claim_or_switch()
        self.assertEqual(self.inspect_count, 0)

    def test_checks_current_source_and_container_images_before_claim(self):
        for service in ("app", "api"):
            name = f"quantself-blue-{service}-1"
            with self.subTest(service=service):
                self.images[name] = "sha256:" + "f" * 64
                with self.assertRaisesRegex(ValueError, "Retained runtime images or container identities"):
                    self.submit()
                self.assert_no_claim_or_switch()
                self.images[name] = IMAGE_ID
        for service in ("api", "gateway"):
            name = f"quantself-blue-{service}-1"
            with self.subTest(missing=service):
                image = self.images.pop(name)
                with self.assertRaisesRegex(ValueError, "Retained runtime images or container identities"):
                    self.submit()
                self.assert_no_claim_or_switch()
                self.images[name] = image
        self.main = CONTROL_SHA
        with self.assertRaisesRegex(ValueError, "canonical main is"):
            self.submit()
        self.assert_no_claim_or_switch()

    def test_rejects_app_api_container_swap_even_with_same_image(self):
        self.swap_after_lookup = True
        with self.assertRaisesRegex(ValueError, "Retained containers or slot changed"):
            self.submit()
        self.assertEqual(self.inspect_count, 2)
        self.assert_no_claim_or_switch()

    def test_rejects_plan_bound_to_different_approval(self):
        self.change_plan = lambda plan: replace(plan, approval=replace(plan.approval, canonical_sha=CONTROL_SHA))
        with self.assertRaisesRegex(ValueError, "Rollback plan differs from approval"):
            self.submit()
        self.assertEqual(self.inspect_count, 1)
        self.assert_no_claim_or_switch()

    def test_rechecks_gateway_image_and_slot_record_before_switch(self):
        def change_gateway(plan):
            self.images["quantself-blue-gateway-1"] = "sha256:" + "f" * 64
            return plan

        self.change_plan = change_gateway
        with self.assertRaisesRegex(ValueError, "Retained containers or slot changed"):
            self.submit()
        self.assertEqual(self.inspect_count, 2)
        self.assert_no_claim_or_switch()

        def change_active(plan):
            self.write_record(self.active, "blue\ngreen\n")
            return plan

        self.change_plan = change_active
        with self.assertRaisesRegex(ValueError, "Previous slot changed"):
            self.submit()
        self.assertEqual(self.inspect_count, 3)
        self.assert_no_claim_or_switch()

    def test_shared_lock_and_unresolved_switch_are_fences(self):
        with self.lock.open("r+") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):
                self.submit()
        self.assert_no_claim_or_switch()
        self.exit_code = 1
        with self.assertRaises(subprocess.CalledProcessError):
            self.submit()
        with self.assertRaises(ReconciliationRequired):
            self.submit()
        self.assertEqual(len(self.switches.read_text().splitlines()), 1)

    def test_interrupted_binding_allows_only_exact_retry(self):
        # Simulate process loss after persisting the tuple and before claiming the switch.
        with self.journal._lock():
            self.journal.bind_rollback(self.claim)
        self.journal = RehearsalJournal(self.lock, self.journal.journal_path)
        with self.assertRaisesRegex(BindingConflict, "bound to"):
            self.journal.submit(self.promotion, lambda _: self.fail("Promotion reached a switch"))
        self.assertFalse(self.switches.exists())
        self.assertEqual(self.submit().outcome, "succeeded")
        self.assertEqual(len(self.switches.read_text().splitlines()), 1)

    def test_verified_shell_switch_starts_exact_ids_under_the_deploy_lock(self):
        shell = self.shell_fixture()
        receipt = self.submit(make_switch=shell.command)
        self.assertEqual(receipt.outcome, "succeeded")
        self.assertEqual(receipt.claim, self.claim)
        self.assertEqual(self.journal.reconcile(self.claim, lambda _: self.fail("Already settled")), receipt)
        prefix = f"/repos/{self.policy.repository}"
        self.assertCountEqual(self.control_reads, [
            f"{prefix}/actions/runs/{RUN_ID}", f"{prefix}/git/ref/heads/main",
        ])
        self.assertEqual(self.source_reads, ["refs/heads/main"])
        events = shell.events()
        self.assertEqual(events[0], ["inspect_names", *self.names])
        self.assertEqual(events[1], ["write", "pending"])
        self.assertEqual([event[1] for event in events if event[0] == "start"], list(self.start_ids))
        self.assertEqual(len([event for event in events if event == ["reload"]]), 1)
        self.assertEqual(self.active.read_text(), "blue\ngreen\n")
        self.assertFalse(self.pending.exists())
        self.assertEqual(self.submit(make_switch=shell.command), receipt)
        self.assertEqual(shell.events(), events)
        self.assertEqual(self.source_reads, ["refs/heads/main"])

    def test_wrong_action_is_rejected_before_the_staged_shell(self):
        shell = self.shell_fixture()
        self.run["display_title"] = run_fixture()["display_title"]
        with self.assertRaisesRegex(ValueError, "Control run identity rejected"):
            self.submit(make_switch=shell.command)
        self.assert_no_claim_or_switch()
        self.assertEqual(self.inspect_count, 0)
        self.assertFalse(shell.events_path.exists())
        self.assertEqual(shell.ingress.read_text(), shell.original_ingress)

    def test_verified_shell_switch_rejects_replacement_without_pending_or_route_change(self):
        shell = self.shell_fixture(replacement=True)
        with self.assertRaises(subprocess.CalledProcessError):
            self.submit(make_switch=shell.command)
        self.assertEqual(shell.events(), [["inspect_names", *self.names]])
        self.assertEqual(shell.ingress.read_text(), shell.original_ingress)
        self.assertEqual(self.active.read_text(), "green\nblue\n")
        self.assertFalse(self.pending.exists())

    def test_original_shell_rollback_still_accepts_its_existing_arguments(self):
        shell = self.shell_fixture()
        receipt = self.journal.submit(self.promotion, lambda _: shell.shell_command("rollback", str(shell.root)))
        self.assertEqual(receipt.outcome, "succeeded")
        self.assertEqual([event[1] for event in shell.events() if event[0] == "start"], list(self.names))

    def test_pinned_local_workflow_dispatches_exact_approved_rollback(self):
        workflow = self.configure_local_workflow()
        shell = self.shell_fixture()
        self.assertEqual(set(workflow.workflow["on"]), {"workflow_dispatch"})
        guard = workflow.workflow["jobs"]["relay"]["if"]
        for condition in ("workflow_dispatch", "refs/heads/main", "github.ref_protected", "repository.fork"):
            self.assertIn(condition, guard)
        self.assertEqual(self.run["display_title"], APPROVED.control_title)
        self.assertEqual(json.loads(self.approval_path().read_text())["control_policy"]["workflow_sha256"],
                         hashlib.sha256(workflow.read_workflow(self.policy.control_sha, WORKFLOW_PATH)).hexdigest())
        dispatch = workflow.dispatch(self.policy, APPROVED)
        receipt = self.submit_envelope(dispatch, shell)
        self.assertEqual(receipt.claim, self.claim)
        self.assertEqual(receipt.outcome, "succeeded")
        self.assertEqual(self.workflow_reads, [(self.policy.control_sha, WORKFLOW_PATH)])
        self.assertEqual([event[1] for event in shell.events() if event[0] == "start"], list(self.start_ids))

        events = shell.events()
        changed_bytes = workflow.read_workflow(self.policy.control_sha, WORKFLOW_PATH) + b"\n# different pin"
        self.assertTrue(self.revoke_approval())
        self.policy = replace(self.policy, workflow_sha256=hashlib.sha256(changed_bytes).hexdigest())
        self.workflow_reader = lambda _commit, _path: changed_bytes
        self.stage_approval()
        with self.assertRaisesRegex(BindingConflict, "bound to"):
            self.submit_envelope(dispatch, shell)
        self.assertEqual(shell.events(), events)
        self.assertEqual(self.journal.reconcile(receipt.claim, lambda _: self.fail("Already settled")), receipt)

    def test_workflow_sender_denies_prs_forks_and_unpinned_context(self):
        workflow = self.configure_local_workflow()
        for context in (
            {"GITHUB_EVENT_NAME": "pull_request"}, {"GITHUB_EVENT_NAME": "pull_request_target"},
            {"EVENT_FORK": "true"}, {"GITHUB_REPOSITORY": "fixture/fork"}, {"GITHUB_REPOSITORY_ID": "43"},
            {"GITHUB_REF_PROTECTED": "false"}, {"GITHUB_REF": "refs/heads/topic"},
            {"GITHUB_ACTOR_ID": "999"}, {"GITHUB_TRIGGERING_ACTOR": "another-user"},
            {"GITHUB_WORKFLOW_SHA": CONTROL_SHA}, {"GITHUB_SHA": CONTROL_SHA},
            {"GITHUB_WORKFLOW_REF": f"{self.policy.repository}/.github/workflows/other.yml@refs/heads/main"},
            {"GITHUB_RUN_ATTEMPT": "0"}, {"PRIOR_SLOT": "legacy"}, {"IMAGE_ID": "wrong"},
        ):
            with self.subTest(context=context):
                result = workflow.dispatch(self.policy, APPROVED, **context)
                self.assertEqual((result.returncode, result.stdout), (1, ""))
        self.assert_no_claim_or_switch()

    def test_broker_denies_changed_bytes_fork_and_pr_after_sender(self):
        workflow = self.configure_local_workflow()
        shell = self.shell_fixture()
        dispatch = workflow.dispatch(self.policy, APPROVED)
        self.assertEqual(dispatch.returncode, 0, dispatch.stderr)
        original = self.run.copy()
        for fields in (
            {"event": "pull_request"}, {"event": "pull_request_target"},
            {"head_repository": {"id": 99, "full_name": "fixture/fork"}},
            {"repository": original["repository"] | {"private": False}},
            {"path": ".github/workflows/other.yml"}, {"workflow_id": self.policy.workflow_id + 1},
            {"run_attempt": ATTEMPT + 1}, {"head_sha": CONTROL_SHA},
        ):
            self.run = original | fields
            with self.subTest(fields=fields), self.assertRaisesRegex(ValueError, "Control run identity rejected"):
                self.submit_envelope(dispatch, shell)
        self.assertEqual(self.workflow_reads, [])
        self.run = original
        self.workflow_reader = lambda commit, path: workflow.read_workflow(commit, path) + b"\n# unreviewed change"
        with self.assertRaisesRegex(ValueError, "Pinned rollback workflow bytes differ"):
            self.submit_envelope(dispatch, shell)
        wrong_action = subprocess.CompletedProcess(dispatch.args, 0, dispatch.stdout.replace("rollback\n", "promote\n", 1))
        with self.assertRaisesRegex(ValueError, "Unexpected rollback dispatch operation"):
            self.submit_envelope(wrong_action, shell)
        moved = workflow.dispatch(self.policy, APPROVED, TARGET_SHA=SOURCE_SHA)
        with self.assertRaisesRegex(ValueError, "not approved"):
            self.submit_envelope(moved, shell)
        self.assert_no_claim_or_switch()
        self.assertEqual(self.inspect_count, 0)
        self.assertFalse(shell.events_path.exists())
