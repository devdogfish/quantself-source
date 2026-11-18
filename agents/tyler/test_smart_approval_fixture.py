import hashlib
from http.client import HTTPConnection
import json
from pathlib import Path
import runpy
from threading import Thread
import unittest
from unittest.mock import patch


fixture = runpy.run_path(str(Path(__file__).with_name("smart-approval-fixture.py")))
SYSTEM = "synthetic system prompt"


class SmartApprovalFixtureTest(unittest.TestCase):
    def setUp(self):
        self.server = fixture["Server"](("127.0.0.1", 0))
        self.addCleanup(self.server.server_close)
        digest = hashlib.sha256(SYSTEM.encode()).hexdigest()
        matcher_globals = fixture["matches_guardian"].__globals__
        self.enterContext(patch.dict(matcher_globals, {"SYSTEM_PROMPT_SHA256": digest}))
        self.body = {
            "model": fixture["MODEL"], "temperature": 0, "reasoning_effort": "none",
            "messages": [
                {"role": "system", "content": SYSTEM},
                {"role": "user", "content": fixture["USER_PROMPT"]},
            ],
        }

    def request(self, body=None, *, token=None, method="POST", path=None):
        if body is None:
            body = json.dumps(self.body)
        if token is None:
            token = fixture["TOKEN"]
        self.server.timeout = 2
        handler = Thread(target=self.server.handle_request)
        handler.start()
        client = HTTPConnection("127.0.0.1", self.server.server_port, timeout=2)
        try:
            client.request(method, path or fixture["REQUEST_PATH"], body, {
                "Content-Type": "application/json", "Authorization": f"Bearer {token}",
            })
            response = client.getresponse()
            return response.status, response.read()
        finally:
            client.close()
            handler.join(3)
            self.assertFalse(handler.is_alive())

    def test_exact_guardian_request_gets_chat_completion(self):
        status, body = self.request()
        self.assertEqual(status, 200)
        reply = json.loads(body)
        self.assertEqual(reply["object"], "chat.completion")
        self.assertEqual(reply["model"], fixture["MODEL"])
        self.assertEqual(reply["choices"][0]["message"], {"role": "assistant", "content": "ESCALATE"})
        self.assertEqual((self.server.accepted, self.server.rejected), (1, 0))

    def test_rejects_other_route_auth_command_and_payload(self):
        wrong_command = fixture["USER_PROMPT"].replace("proof.txt", "other.txt")
        wrong_system = self.body | {"messages": [
            {"role": "system", "content": "another prompt"}, self.body["messages"][1],
        ]}
        bad_command = self.body | {"messages": [
            self.body["messages"][0], {"role": "user", "content": wrong_command},
        ]}
        duplicate_key = json.dumps(self.body).replace('{"model":', '{"model":"duplicate","model":', 1)
        for arguments, expected in (
            ({"path": "/v1/models"}, 404),
            ({"method": "GET"}, 501),
            ({"token": "other-token"}, 401),
            ({"body": json.dumps(bad_command)}, 400),
            ({"body": json.dumps(wrong_system)}, 400),
            ({"body": json.dumps(self.body | {"tools": []})}, 400),
            ({"body": duplicate_key}, 400),
            ({"body": "x" * (fixture["MAX_BODY"] + 1)}, 413),
        ):
            with self.subTest(status=expected):
                self.assertEqual(self.request(**arguments), (expected, b""))
        self.assertEqual((self.server.accepted, self.server.rejected), (0, 8))
