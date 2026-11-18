"""Durable claims for Atlas deploys serialized with Keep maintenance."""

from contextlib import closing, contextmanager
from dataclasses import dataclass, replace
import fcntl
import os
import re
import sqlite3
import stat
import subprocess


class ReconciliationRequired(RuntimeError):
    pass


class BindingConflict(ValueError):
    pass


@dataclass(frozen=True)
class Claim:
    control_repo_id: str
    run_id: str
    attempt: str
    source_sha: str
    image_id: str

    def __post_init__(self):
        fields = (
            (self.control_repo_id, r"[1-9][0-9]{0,19}"), (self.run_id, r"[1-9][0-9]{0,19}"),
            (self.attempt, r"[1-9][0-9]{0,9}"), (self.source_sha, r"[0-9a-f]{40}"),
            (self.image_id, r"sha256:[0-9a-f]{64}"),
        )
        if not all(isinstance(value, str) and re.fullmatch(pattern, value) for value, pattern in fields):
            raise ValueError("Invalid deploy claim identity")

    @property
    def key(self):
        return self.control_repo_id, self.run_id, self.attempt


@dataclass(frozen=True)
class Receipt:
    claim: Claim
    outcome: str
    evidence: str

    def __post_init__(self):
        if self.outcome not in {"succeeded", "never_invoked", "recovered"}:
            raise ValueError("Receipt requires a definitive outcome")
        if not isinstance(self.evidence, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9:/._-]{0,199}", self.evidence):
            raise ValueError("Receipt requires an evidence identifier")


class DeployJournal:
    """Serialize the broker against the configured production lock.

    The caller authenticates requests. Only the broker constructs the command,
    which includes deployment and smoke. Reconciliation uses a trusted read-only
    observer and can close a claim based on authoritative evidence for that claim.
    """

    def __init__(self, lock_path, journal_path):
        self.lock_path = lock_path
        self.journal_path = journal_path

    @contextmanager
    def _lock(self):
        descriptor = os.open(self.lock_path, os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            if not stat.S_ISREG(os.fstat(descriptor).st_mode):
                raise ValueError("Expected a stable regular deploy lock file")
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            yield descriptor
        finally:
            # Closing only our fd preserves the flock while a launched command holds its copy.
            os.close(descriptor)

    @contextmanager
    def _database(self):
        # mode=rw deliberately refuses a missing journal. Initialization is explicit.
        with closing(sqlite3.connect(
            self.journal_path.absolute().as_uri() + "?mode=rw", uri=True, timeout=0, isolation_level=None,
        )) as database:
            if database.execute("PRAGMA journal_mode").fetchone() != ("delete",):
                raise ValueError("Expected SQLite DELETE journal mode")
            database.execute("PRAGMA synchronous = EXTRA")
            if database.execute("PRAGMA synchronous").fetchone() != (3,):
                raise ValueError("Expected SQLite EXTRA synchronization")
            database.execute("PRAGMA foreign_keys = ON")
            yield database

    def initialize(self):
        """Create the journal once. Never replace an existing journal."""
        with self._lock():
            os.close(os.open(self.journal_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600))
            with self._database() as database:
                database.executescript("""
                    BEGIN;
                    CREATE TABLE deploy_claim (
                        repo_id TEXT NOT NULL,
                        run_id TEXT NOT NULL,
                        attempt TEXT NOT NULL,
                        source_sha TEXT NOT NULL,
                        image_id TEXT NOT NULL,
                        outcome TEXT NOT NULL CHECK (
                            outcome IN ('claimed', 'succeeded', 'never_invoked', 'recovered', 'replayed')
                        ),
                        evidence TEXT,
                        replayed_from TEXT,
                        CHECK ((outcome IN ('claimed', 'replayed')) = (evidence IS NULL)),
                        CHECK ((outcome = 'replayed') = (replayed_from IS NOT NULL)),
                        CHECK (replayed_from <> attempt),
                        PRIMARY KEY (repo_id, run_id, attempt),
                        FOREIGN KEY (repo_id, run_id, replayed_from) REFERENCES deploy_claim (repo_id, run_id, attempt)
                    );
                    CREATE UNIQUE INDEX one_unresolved_deploy ON deploy_claim (outcome) WHERE outcome = 'claimed';
                    COMMIT;
                """)
            directory = os.open(self.journal_path.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)

    def _lookup(self, database, claim):
        record = database.execute("""
            SELECT source_sha, image_id, outcome, evidence, replayed_from FROM deploy_claim
            WHERE repo_id = ? AND run_id = ? AND attempt = ?
        """, claim.key).fetchone()
        if record is not None and record[:2] != (claim.source_sha, claim.image_id):
            raise BindingConflict("Attempt is already bound to a different source SHA or image ID")
        return record

    def _terminal_receipt(self, database, claim, record):
        if record[2] == "replayed":
            claim = replace(claim, attempt=record[4])
            record = self._lookup(database, claim)
            if record is None or record[2] != "succeeded":
                raise ReconciliationRequired("Original successful receipt is unavailable")
        return Receipt(claim, *record[2:4])

    def _finish(self, database, receipt):
        result = database.execute("""
            UPDATE deploy_claim SET outcome = ?, evidence = ?
            WHERE repo_id = ? AND run_id = ? AND attempt = ? AND outcome = 'claimed'
        """, (receipt.outcome, receipt.evidence, *receipt.claim.key))
        if result.rowcount != 1:
            raise ReconciliationRequired("Could not persist the definitive outcome")
        return receipt

    def assert_clear(self):
        """Fence another deployment path whose caller already holds the lock."""
        with self._database() as database:
            if database.execute("SELECT 1 FROM deploy_claim WHERE outcome = 'claimed'").fetchone():
                raise ReconciliationRequired("An unresolved deploy fences Keep")

    def submit(self, claim, make_command, *, authorize=None, prepare=None, output=subprocess.DEVNULL):
        """Return a durable receipt or run the exact authorized command once."""
        with self._lock() as lock_fd, self._database() as database:
            if authorize is not None:
                authorize(claim)
            record = self._lookup(database, claim)
            if record is not None and record[2] != "claimed":
                return self._terminal_receipt(database, claim, record)
            if database.execute("SELECT 1 FROM deploy_claim WHERE outcome = 'claimed'").fetchone():
                raise ReconciliationRequired("An unresolved deploy fences Keep")
            success = database.execute("""
                SELECT attempt, source_sha, image_id, evidence FROM deploy_claim
                WHERE repo_id = ? AND run_id = ? AND outcome = 'succeeded'
            """, (claim.control_repo_id, claim.run_id)).fetchone()
            if success is not None:
                attempt, source_sha, image_id, evidence = success
                if (source_sha, image_id) != (claim.source_sha, claim.image_id):
                    raise BindingConflict("Run already succeeded with a different source SHA or image ID")
                original = Claim(claim.control_repo_id, claim.run_id, attempt, source_sha, image_id)
                receipt = Receipt(original, "succeeded", evidence)
                # Commit the exact retry identity before returning its historical receipt.
                database.execute("""
                    INSERT INTO deploy_claim (repo_id, run_id, attempt, source_sha, image_id, outcome, replayed_from)
                    VALUES (?, ?, ?, ?, ?, 'replayed', ?)
                """, (*claim.key, source_sha, image_id, attempt))
                return receipt
            if prepare is not None:
                prepare(claim)
            database.execute("""
                INSERT INTO deploy_claim (repo_id, run_id, attempt, source_sha, image_id, outcome)
                VALUES (?, ?, ?, ?, ?, 'claimed')
            """, (*claim.key, claim.source_sha, claim.image_id))

            # Autocommit made the claim durable. Only the saved receipt acknowledges success.
            subprocess.run(
                make_command(claim), stdin=subprocess.DEVNULL, stdout=output,
                pass_fds=(lock_fd,), check=True,
            )
            return self._finish(database, Receipt(claim, "succeeded", "deploy-and-smoke-exit-zero"))

    def reconcile(self, claim, observe):
        """Read or settle a claim without admitting another deployment."""
        with self._lock(), self._database() as database:
            record = self._lookup(database, claim)
            if record is None:
                raise ReconciliationRequired("No claim found for this attempt")
            if record[2] != "claimed":
                return self._terminal_receipt(database, claim, record)
            receipt = observe(claim)
            if receipt is None:
                raise ReconciliationRequired("Authoritative outcome is still unknown")
            if not isinstance(receipt, Receipt) or receipt.claim != claim:
                raise BindingConflict("Observation is for a different deploy claim")
            return self._finish(database, receipt)
