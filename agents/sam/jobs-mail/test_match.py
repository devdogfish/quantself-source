import importlib.util
import unittest
from pathlib import Path
from unittest.mock import AsyncMock

spec = importlib.util.spec_from_file_location("jobs_mail_plugin", Path(__file__).parent / "plugin" / "__init__.py")
plugin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plugin)

ADDRESS = "luigi.z8wx@luigigirke.com"
REFERENCE = "<test-1@email.amazonses.com>"
APPLICATION = "368aea93-b4c5-45f5-95e6-0fe15d35cc08"


class ReplyMatchTests(unittest.IsolatedAsyncioTestCase):
    async def test_verified_recipient_makes_one_exact_lookup_even_with_a_forged_alias(self):
        lookup = AsyncMock(return_value=(APPLICATION, None))
        result = await plugin.match_reply({
            "recipient_evidence": {"kind": "application_address", "address": ADDRESS},
            "reply_header_hints": {
                "x-pm-original-to": ["luigi.v6qy@luigigirke.com"],
                "in-reply-to": [REFERENCE],
            },
        }, lookup)
        self.assertEqual(result, {"status": "matched", "application_id": APPLICATION, "source": "smtp_recipient"})
        lookup.assert_awaited_once_with({"address": ADDRESS, "inReplyTo": REFERENCE})

    async def test_bare_mailbox_thread_is_a_candidate_and_a_forged_alias_is_ignored(self):
        lookup = AsyncMock(return_value=(APPLICATION, None))
        base = {"recipient_evidence": {"kind": "bare_mailbox"}, "reply_header_hints": {
            "x-pm-original-to": [ADDRESS],
        }}
        self.assertEqual(await plugin.match_reply(base, lookup),
                         {"status": "needs_review", "reason": "no_verified_match"})
        lookup.assert_not_awaited()
        base["reply_header_hints"]["references"] = ["<older@email.amazonses.com> " + REFERENCE]
        self.assertEqual(await plugin.match_reply(base, lookup),
                         {"status": "candidate", "application_id": APPLICATION, "source": "ses_reference"})
        lookup.assert_awaited_once_with({"inReplyTo": REFERENCE})

    async def test_unissued_address_does_not_enter_follow_up(self):
        lookup = AsyncMock(return_value=(None, "no_match"))
        message = {"recipient_evidence": {"kind": "application_address", "address": ADDRESS}}
        self.assertEqual(await plugin.match_reply(message, lookup),
                         {"status": "ignored", "reason": "unissued_address"})
        lookup.assert_awaited_once_with({"address": ADDRESS})

    async def test_conflicting_or_unavailable_lookup_does_not_fall_back_to_guessing(self):
        message = {"recipient_evidence": {"kind": "application_address", "address": ADDRESS},
                   "reply_header_hints": {"in-reply-to": [REFERENCE]}}
        for reason in ("conflicting_match", "lookup_unavailable", "no_match"):
            with self.subTest(reason=reason):
                lookup = AsyncMock(return_value=(None, reason))
                self.assertEqual(await plugin.match_reply(message, lookup),
                                 {"status": "needs_review", "reason": reason})
                lookup.assert_awaited_once_with({"address": ADDRESS, "inReplyTo": REFERENCE})
