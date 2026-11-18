import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import Mock, patch

import test_service  # loads the shared read module from the source checkout
from jobs_mail_actions import _mark, _move, apply_action, validate_action


def move():
    return {"action": "move", "command_id": str(uuid.uuid4()), "folder": "INBOX",
            "uid": 9, "uidvalidity": 858089654, "destination": "Archive"}


def undo(receipt):
    return {"action": "undo", "command_id": str(uuid.uuid4()), "undo_id": receipt}


class MailActionTests(unittest.TestCase):
    def test_archive_receipt_replays_and_undo_uses_returned_destination_identity(self):
        request = move()
        mailbox = {"folder": "Archive", "uid": 24, "uidvalidity": 13}
        apply = Mock(side_effect=[
            ({"status": "ok", "message": mailbox}, {**request, **mailbox, "destination": "INBOX"}),
            ({"status": "ok", "message": {"folder": "INBOX", "uid": 41, "uidvalidity": 858089654}}, None),
        ])
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            result = apply_action(state, "fixture", "fixture", request, apply)
            self.assertEqual(result["undo_id"], request["command_id"])
            self.assertEqual(apply_action(state, "fixture", "fixture", request, apply), result)
            self.assertEqual(
                apply_action(state, "fixture", "fixture", {**request, "uid": 12}, apply),
                {"status": "conflict"},
            )
            reverse = undo(result["undo_id"])
            self.assertEqual(apply_action(state, "fixture", "fixture", reverse, apply)["status"], "ok")
            self.assertEqual(
                apply_action(state, "fixture", "fixture", undo(result["undo_id"]), apply),
                {"status": "undo_unavailable"},
            )
        self.assertEqual(apply.call_count, 2)
        self.assertEqual(apply.call_args.args[2], {**request, **mailbox,
                                                 "destination": "INBOX", "command_id": reverse["command_id"]})

    def test_lost_move_acknowledgment_is_preserved_on_replay(self):
        request = move()
        apply = Mock(side_effect=OSError)
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            for _ in range(2):
                self.assertEqual(apply_action(state, "fixture", "fixture", request, apply),
                                 {"status": "outcome_uncertain"})
        apply.assert_called_once()

    def test_move_requires_exact_copy_uid_and_refuses_deleted_destination(self):
        request = move()
        connection = Mock()
        connection.uid.return_value = ("OK", [None])
        connection.response.side_effect = [(None, [None]), ("COPYUID", [b"13 9 24"])]
        result, reverse = _move(connection, request)
        connection.uid.assert_called_once_with("MOVE", "9", "Archive")
        self.assertEqual(result["message"], {"folder": "Archive", "uid": 24, "uidvalidity": 13})
        self.assertEqual((reverse["uid"], reverse["destination"]), (24, "INBOX"))
        with self.assertRaises(ValueError):
            validate_action({**request, "destination": "Trash"})

    def test_mark_undo_conflicts_after_owner_modification_without_store(self):
        connection = Mock()
        request = {**move(), "action": "mark", "flag": "seen", "expected": True,
                   "expected_modseq": "102", "enabled": False}
        result, reverse = _mark(connection, request, frozenset({b"\\SEEN"}), "103")
        self.assertEqual(result, {"status": "conflict"})
        self.assertIsNone(reverse)
        connection.uid.assert_not_called()

    def test_mark_read_only_changes_seen_and_journals_exact_reverse_revision(self):
        connection = Mock()
        connection.uid.return_value = ("OK", [None])
        request = {**move(), "action": "mark", "flag": "seen", "enabled": True}
        with patch("jobs_mail_actions._flags", return_value=(frozenset({b"\\SEEN", b"\\FLAGGED"}), "30")), \
             patch("jobs_mail_actions._uidvalidity", return_value=request["uidvalidity"]):
            result, reverse = _mark(connection, request, frozenset({b"\\FLAGGED"}), "29")
        connection.uid.assert_called_once_with("STORE", "9", "+FLAGS.SILENT", "(\\Seen)")
        self.assertEqual(result["status"], "ok")
        self.assertEqual((reverse["expected_modseq"], reverse["enabled"]), ("30", False))
