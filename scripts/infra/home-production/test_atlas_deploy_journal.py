from dataclasses import replace
import json
from pathlib import Path
import runpy
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest


SCRIPT = Path(__file__).with_name("atlas-deploy-journal.py")
API = runpy.run_path(SCRIPT)
Claim = API["Claim"]
Receipt = API["Receipt"]
DeployJournal = API["DeployJournal"]
ReconciliationRequired = API["ReconciliationRequired"]
BindingConflict = API["BindingConflict"]
REQUEST = Claim("42", "123", "1", "a" * 40, "sha256:" + "b" * 64)

# Both child programs operate on this test's temporary files only.
ACTION = """
import json, os, sys, time
from pathlib import Path

root, mode, *claim = sys.argv[1:]
root = Path(root)
with (root / 'invocations').open('a') as output:
    output.write(json.dumps(claim) + '\\n')
    output.flush()
    os.fsync(output.fileno())
if mode == 'fail':
    sys.exit(19)
if mode == 'pause':
    deadline = time.monotonic() + 10
    while not (root / 'continue').exists():
        if time.monotonic() >= deadline:
            sys.exit(20)
        time.sleep(0.01)
# Synthetic evidence for successful deploy AND smoke, bound to this exact attempt.
(root / 'smoke-complete').write_text(json.dumps(claim))
print('callback complete')
"""

BROKER = """
import os, runpy, sys
from pathlib import Path

script, root, fault, action, *identity = sys.argv[1:]
api = runpy.run_path(script)
root = Path(root)
journal = api['DeployJournal'](root / 'shared.lock', root / 'journal.sqlite')
claim = api['Claim'](*identity)
if fault == 'before-receipt':
    journal._finish = lambda *_: os._exit(72)

def command(bound):
    if fault == 'after-claim':
        os._exit(71)
    mode = 'pause' if fault == 'pause' else 'success'
    return [sys.executable, '-I', '-B', '-c', action, str(root), mode,
            *bound.key, bound.source_sha, bound.image_id]

receipt = journal.submit(claim, command)
if fault == 'lost-reply':
    os._exit(73)
print(receipt.outcome)
"""


class DeployJournalTest(unittest.TestCase):
    def setUp(self):
        temporary = self.enterContext(tempfile.TemporaryDirectory())
        self.root = Path(temporary)
        self.lock = self.root / "shared.lock"
        self.lock.touch(mode=0o600)
        self.path = self.root / "journal.sqlite"
        self.open_journal().initialize()

    def open_journal(self):
        return DeployJournal(self.lock, self.path)

    def command(self, bound, mode="success"):
        return [sys.executable, "-I", "-B", "-c", ACTION, str(self.root), mode,
                *bound.key, bound.source_sha, bound.image_id]

    def should_not_execute(self, _):
        self.fail("A duplicate or unresolved claim reached deployment")

    def broker_args(self, fault, claim=REQUEST):
        return [sys.executable, "-I", "-B", "-c", BROKER, str(SCRIPT), str(self.root), fault, ACTION,
                *claim.key, claim.source_sha, claim.image_id]

    def invocations(self):
        path = self.root / "invocations"
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def wait_for(self, check):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            try:
                if check():
                    return
            except BlockingIOError:
                pass
            time.sleep(0.01)
        self.fail("Timed out waiting for synthetic process")

    def observe_smoke(self, claim):
        path = self.root / "smoke-complete"
        if path.exists() and json.loads(path.read_text()) == [*claim.key, claim.source_sha, claim.image_id]:
            return Receipt(claim, "succeeded", "fixture:exact-smoke-record")
        return None

    def assert_fenced(self):
        for claim in (
            REQUEST, replace(REQUEST, attempt="2"), replace(REQUEST, control_repo_id="43", run_id="456",
                attempt="2", source_sha="3" * 40, image_id="sha256:" + "4" * 64),
        ):
            with self.subTest(claim=claim), self.assertRaises(ReconciliationRequired):
                self.open_journal().submit(claim, self.should_not_execute)

    def test_success_is_idempotent_and_binds_the_source_and_image(self):
        first = self.open_journal().submit(REQUEST, self.command)
        self.assertEqual(first.outcome, "succeeded")
        self.assertEqual(self.open_journal().submit(REQUEST, self.should_not_execute), first)
        self.assertEqual(self.open_journal().reconcile(REQUEST, self.should_not_execute), first)
        self.assertEqual(self.invocations(), [[*REQUEST.key, REQUEST.source_sha, REQUEST.image_id]])
        for changed in (replace(REQUEST, source_sha="c" * 40), replace(REQUEST, image_id="sha256:" + "c" * 64)):
            with self.subTest(changed=changed), self.assertRaises(BindingConflict):
                self.open_journal().submit(changed, self.should_not_execute)

    def test_crash_after_claim_fences_new_attempts_until_authoritative_reconciliation(self):
        result = subprocess.run(self.broker_args("after-claim"), timeout=5, capture_output=True)
        self.assertEqual(result.returncode, 71, result.stderr)
        self.assertEqual(self.invocations(), [])
        self.assert_fenced()
        journal = self.open_journal()
        with self.assertRaises(ReconciliationRequired):
            journal.reconcile(REQUEST, self.observe_smoke)
        with self.assertRaises(BindingConflict):
            journal.reconcile(REQUEST, lambda _: Receipt(replace(REQUEST, attempt="2"), "succeeded", "wrong-attempt"))
        self.assert_fenced()
        recovered = journal.reconcile(REQUEST, lambda claim: Receipt(claim, "never_invoked", "fixture:before-spawn"))
        self.assertEqual(journal.submit(REQUEST, self.should_not_execute), recovered)
        self.assertEqual(self.invocations(), [])
        retry = replace(REQUEST, attempt="2")
        self.assertEqual(self.open_journal().submit(retry, self.command).outcome, "succeeded")
        self.assertEqual(self.invocations(), [[*retry.key, retry.source_sha, retry.image_id]])

    def test_lost_reply_after_success_returns_the_durable_receipt(self):
        result = subprocess.run(self.broker_args("lost-reply"), timeout=5, capture_output=True)
        self.assertEqual(result.returncode, 73, result.stderr)
        self.assertEqual(result.stdout, b"")
        recovered = self.open_journal().submit(REQUEST, self.should_not_execute)
        self.assertEqual(recovered, Receipt(REQUEST, "succeeded", "deploy-and-smoke-exit-zero"))
        next_attempt = replace(REQUEST, attempt="2")
        self.assertEqual(self.open_journal().submit(next_attempt, self.should_not_execute), recovered)
        with self.assertRaises(BindingConflict):
            self.open_journal().submit(replace(next_attempt, source_sha="3" * 40), self.should_not_execute)
        self.assertEqual(len(self.invocations()), 1)

    def test_lost_reply_for_later_attempt_reconciles_using_its_exact_identity(self):
        original = self.open_journal().submit(REQUEST, self.command)
        later = replace(REQUEST, attempt="2")
        result = subprocess.run(self.broker_args("lost-reply", later), timeout=5, capture_output=True)
        self.assertEqual(result.returncode, 73, result.stderr)
        self.assertEqual(result.stdout, b"")

        journal = self.open_journal()
        self.assertEqual(journal.reconcile(later, self.should_not_execute), original)
        self.assertEqual(journal.submit(later, self.should_not_execute), original)
        self.assertEqual(journal.reconcile(REQUEST, self.should_not_execute), original)
        for changed in (replace(later, source_sha="c" * 40), replace(later, image_id="sha256:" + "c" * 64)):
            with self.subTest(changed=changed), self.assertRaises(BindingConflict):
                journal.reconcile(changed, self.should_not_execute)
        with self.assertRaisesRegex(ReconciliationRequired, "No claim found"):
            journal.reconcile(replace(later, attempt="3"), self.should_not_execute)
        self.assertEqual(self.invocations(), [[*REQUEST.key, REQUEST.source_sha, REQUEST.image_id]])

    def test_failed_replay_write_cannot_acknowledge_a_later_attempt(self):
        journal = self.open_journal()
        original = journal.submit(REQUEST, self.command)
        fixture = sqlite3.connect(self.path, isolation_level=None)
        try:
            fixture.execute("""
                CREATE TRIGGER deny_replay BEFORE INSERT ON deploy_claim WHEN NEW.outcome = 'replayed'
                BEGIN SELECT RAISE(ABORT, 'synthetic replay write failure'); END
            """)
        finally:
            fixture.close()
        later = replace(REQUEST, attempt="2")
        with self.assertRaisesRegex(sqlite3.DatabaseError, "synthetic replay write failure"):
            journal.submit(later, self.should_not_execute)
        with self.assertRaisesRegex(ReconciliationRequired, "No claim found"):
            journal.reconcile(later, self.should_not_execute)
        self.assertEqual(journal.reconcile(REQUEST, self.should_not_execute), original)
        self.assertEqual(len(self.invocations()), 1)

    def test_success_before_receipt_is_reconciled_from_exact_smoke_evidence(self):
        result = subprocess.run(self.broker_args("before-receipt"), timeout=5, capture_output=True)
        self.assertEqual(result.returncode, 72, result.stderr)
        self.assert_fenced()
        recovered = self.open_journal().reconcile(REQUEST, self.observe_smoke)
        self.assertEqual(recovered, Receipt(REQUEST, "succeeded", "fixture:exact-smoke-record"))
        self.assertEqual(self.open_journal().submit(REQUEST, self.should_not_execute), recovered)
        self.assertEqual(len(self.invocations()), 1)

    def test_failed_callback_leaves_an_unresolved_claim_even_if_it_already_mutated(self):
        with self.assertRaises(subprocess.CalledProcessError) as error:
            self.open_journal().submit(REQUEST, lambda claim: self.command(claim, "fail"))
        self.assertEqual(error.exception.returncode, 19)
        self.assertEqual(len(self.invocations()), 1)
        (self.root / "checkout-head").write_text(REQUEST.source_sha)
        (self.root / "mutable-image-tag").write_text(REQUEST.image_id)
        with self.assertRaises(ReconciliationRequired):
            self.open_journal().reconcile(REQUEST, self.observe_smoke)
        self.assert_fenced()

    def test_verified_recovery_closes_failed_attempt_without_relaunching_it(self):
        journal = self.open_journal()
        with self.assertRaises(subprocess.CalledProcessError):
            journal.submit(REQUEST, lambda claim: self.command(claim, "fail"))
        self.assert_fenced()
        marker = self.root / "recovery-complete"

        def observe_recovery(claim):
            if marker.exists() and json.loads(marker.read_text()) == [*claim.key, claim.source_sha, claim.image_id]:
                return Receipt(claim, "recovered", "fixture:prior-state-verified")
            return None

        with self.assertRaises(ReconciliationRequired):
            journal.reconcile(REQUEST, observe_recovery)
        marker.write_text(json.dumps([*REQUEST.key, REQUEST.source_sha, REQUEST.image_id]))
        recovered = journal.reconcile(REQUEST, observe_recovery)
        self.assertEqual(recovered.outcome, "recovered")
        self.assertEqual(journal.submit(REQUEST, self.should_not_execute), recovered)
        retry = replace(REQUEST, attempt="2")
        self.assertEqual(journal.submit(retry, self.command).outcome, "succeeded")
        self.assertEqual(journal.reconcile(REQUEST, self.should_not_execute), recovered)
        self.assertEqual(self.invocations(), [
            [*claim.key, claim.source_sha, claim.image_id] for claim in (REQUEST, retry)
        ])

    def test_shared_lock_prevents_concurrent_duplicate_and_new_attempts(self):
        with subprocess.Popen(self.broker_args("pause"), stdout=subprocess.PIPE, stderr=subprocess.PIPE) as broker:
            try:
                self.wait_for(self.invocations)
                for claim in (REQUEST, replace(REQUEST, attempt="2")):
                    with self.subTest(claim=claim), self.assertRaises(BlockingIOError):
                        self.open_journal().submit(claim, self.should_not_execute)
                with self.assertRaises(BlockingIOError):
                    self.open_journal().reconcile(REQUEST, self.should_not_execute)
            finally:
                (self.root / "continue").touch()
                stdout, stderr = broker.communicate(timeout=5)
        self.assertEqual(broker.returncode, 0, stderr)
        self.assertEqual(stdout, b"succeeded\n")
        self.assertEqual(len(self.invocations()), 1)

    def test_killed_broker_cannot_free_the_lock_held_by_the_running_command(self):
        with subprocess.Popen(self.broker_args("pause"), stdout=subprocess.PIPE, stderr=subprocess.PIPE) as broker:
            try:
                self.wait_for(self.invocations)
                broker.kill()
                broker.wait(timeout=5)
                with self.assertRaises(BlockingIOError):
                    self.open_journal().submit(replace(REQUEST, attempt="2"), self.should_not_execute)
            finally:
                (self.root / "continue").touch()
                broker.communicate(timeout=5)
        self.assert_fenced()
        self.assertEqual(self.open_journal().reconcile(REQUEST, self.observe_smoke).outcome, "succeeded")
        self.assertEqual(len(self.invocations()), 1)

    def test_missing_and_corrupt_journals_fail_closed(self):
        self.path.unlink()
        with self.assertRaises(sqlite3.DatabaseError):
            self.open_journal().submit(REQUEST, self.should_not_execute)
        self.assertFalse(self.path.exists())
        self.path.write_bytes(b"corrupt journal")
        with self.assertRaises(sqlite3.DatabaseError):
            self.open_journal().submit(REQUEST, self.should_not_execute)
        with self.assertRaises(FileExistsError):
            self.open_journal().initialize()

    def test_failed_claim_write_never_reaches_the_deploy_command(self):
        with sqlite3.connect(self.path, isolation_level=None) as fixture:
            fixture.execute("""
                CREATE TRIGGER deny_claim BEFORE INSERT ON deploy_claim
                BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END
            """)
        fixture.close()
        with self.assertRaisesRegex(sqlite3.DatabaseError, "synthetic write failure"):
            self.open_journal().submit(REQUEST, self.should_not_execute)
        self.assertEqual(self.invocations(), [])


if __name__ == "__main__":
    unittest.main()
