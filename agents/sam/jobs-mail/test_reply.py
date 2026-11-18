import json
from io import BytesIO
import tempfile
import unittest
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import Mock, patch

import test_service  # exposes the checkout's shared IMAP module
import jobs_mail_reply as reply


DIRECT = (
    b"X-Pm-Original-To: luigi.v6qy@luigigirke.com\r\n"
    b"Authentication-Results: purelymail.com; spf=pass; dkim=pass; "
    b"dmarc=pass (p=reject) header.from=recruiter@employer.example\r\n"
    b"Received: from mail.employer.example (EHLO mail.employer.example) ([192.0.2.20]) "
    b"by smtp.purelymail.com (Purelymail SMTP) with ESMTPS id -112111539 "
    b"for <luigi.v6qy@luigigirke.com> (version=TLSv1.3 cipher=TLS_AES_256_GCM_SHA384); "
    b"Tue, 17 Nov 2026 12:06:48 +0000 (UTC)\r\n"
    b"From: Hiring <recruiter@employer.example>\r\n"
    b"Subject: Interview\r\n"
    b"Message-ID: <reply-42@employer.example>\r\n\r\n"
)
PACKET = {"from": "luigi.v6qy@luigigirke.com", "to": "recruiter@employer.example",
          "subject": "Re: Interview", "inReplyTo": "<reply-42@employer.example>"}
APPLICATION = "368aea93-b4c5-45f5-95e6-0fe15d35cc08"


def request():
    return {"action": "reply", "uid": 9, "uidvalidity": 12, "command_id": str(uuid.uuid4()),
            "body": "Thank you for confirming.", "api_key": "fixture-scoped-key"}


class ReplyEvidenceTests(unittest.TestCase):
    def test_reply_only_uses_a_single_authenticated_sender(self):
        self.assertEqual(reply.reply_evidence(DIRECT), PACKET)
        for raw in [
            DIRECT.replace(b"dmarc=pass", b"dmarc=fail"),
            DIRECT.replace(b"header.from=recruiter@employer.example", b"header.from=attacker.example"),
            DIRECT.replace(b"From: Hiring", b"Reply-To: other@elsewhere.example\r\nFrom: Hiring"),
            DIRECT.replace(b"From: Hiring", b"Auto-Submitted: auto-replied\r\nFrom: Hiring"),
            DIRECT.replace(b"From: Hiring", b"From: impostor@example.org\r\nFrom: Hiring"),
            DIRECT.replace(b"luigi.v6qy@luigigirke.com", b"luigi@luigigirke.com"),
            DIRECT[:-2],
        ]:
            with self.subTest(raw=raw):
                self.assertIsNone(reply.reply_evidence(raw))

    def test_existing_ses_reference_is_used_for_jobs_lookup_but_never_replaces_reply_message_id(self):
        reference = "<submitted-1@email.amazonses.com>"
        raw = DIRECT.replace(b"Message-ID:", f"In-Reply-To: {reference}\r\nMessage-ID:".encode())
        self.assertEqual(reply.reply_evidence(raw), {**PACKET, "application_reference": reference})
        mixed = raw.replace(b"Message-ID:", b"In-Reply-To: <another@email.amazonses.com>\r\nMessage-ID:")
        self.assertIsNone(reply.reply_evidence(mixed))

    def test_owner_edit_hold_and_unsubmitted_records_fail_closed(self):
        now = datetime.now(timezone.utc)
        cases = [
            (None, now - timedelta(minutes=10), "application_not_submitted"),
            (now.isoformat(), now - timedelta(seconds=20), "application_edit_hold"),
            (now.isoformat(), now - timedelta(minutes=5), None),
        ]
        for applied, updated, error in cases:
            with self.subTest(error=error):
                responses = [json.dumps({"id": APPLICATION}).encode(), json.dumps({"application": {
                    "id": APPLICATION, "appliedAt": applied, "updatedAt": updated.isoformat(),
                }}).encode()]
                opener = Mock()
                opener.open.side_effect = [BytesIO(result) for result in responses]
                with patch.object(reply, "build_opener", return_value=opener):
                    result = reply.jobs_application("https://qs.example.test", "fixture-key", PACKET["from"],
                                                    "<submitted-1@email.amazonses.com>")
                self.assertEqual(result, {"status": error} if error else {"application_id": APPLICATION})
                self.assertEqual(opener.open.call_count, 2)
                self.assertEqual(json.loads(opener.open.call_args_list[0].args[0].data), {
                    "address": PACKET["from"], "inReplyTo": "<submitted-1@email.amazonses.com>",
                })


class ReplyDispatchTests(unittest.TestCase):
    def exercise(self, outcome):
        command = request()
        evidence = Mock(side_effect=lambda *_: {**PACKET, "application_reference": "<submitted-1@email.amazonses.com>"})
        lookup = Mock(return_value={"application_id": APPLICATION})
        send = Mock(return_value=outcome)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            credential = root / "mock-credential"
            credential.touch()
            with patch.object(reply, "TRANSPORT", credential):
                def invoke(data):
                    return reply.send_reply(root, "fixture", data, "https://qs.example.test", credential,
                                            evidence=evidence, lookup=lookup, transport=send)
                self.assertEqual(invoke(command), outcome)
                self.assertEqual(invoke(command), outcome)
                self.assertEqual(invoke({**command, "body": "different"}), {"status": "conflict"})
                replay = invoke({**command, "command_id": str(uuid.uuid4()), "uid": 22})
                self.assertEqual(replay, {"status": "already_sent", "message_id": "receipt"} if
                                 outcome["status"] == "sent" else reply.UNCERTAIN)
            raw = (root / "actions.db").read_bytes()
            self.assertNotIn(command["api_key"].encode(), raw)
            self.assertNotIn(command["body"].encode(), raw)
            send.assert_called_once_with({**PACKET, "body": command["body"]}, credential)
            lookup.assert_called_once_with("https://qs.example.test", command["api_key"], PACKET["from"],
                                           "<submitted-1@email.amazonses.com>")

    def test_receipt_prevents_a_new_id_or_relocated_uid_from_resending(self):
        self.exercise({"status": "sent", "message_id": "receipt"})

    def test_ambiguous_ses_ack_prevents_a_new_id_from_resending(self):
        self.exercise(reply.UNCERTAIN)

    def test_caller_cannot_supply_recipients(self):
        with self.assertRaises(ValueError):
            reply.validate_reply({**request(), "to": "injected@example.test"})
