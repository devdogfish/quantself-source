"""Version census tests use provider-shaped synthetic pages."""
import unittest
from unittest.mock import Mock

import backup_growth as growth


def item(name, action, size):
    return {"fileName": name, "action": action, "contentLength": size, "bucketId": "fixture"}


class GrowthTest(unittest.TestCase):
    def test_pages_count_replaced_versions_hidden_versions_and_multipart_parts(self):
        b2 = Mock(bucket_id="fixture")
        b2.call.side_effect = [
            {"files": [item("vault/test", "hide", 0), item("vault/test", "upload", 60)],
             "nextFileName": "vault/test", "nextFileId": "older"},
            {"files": [item("vault/test", "upload", 40), item("vault/pending", "start", 0)],
             "nextFileName": None, "nextFileId": None},
            {"files": [{**item("vault/pending", "start", 0), "fileId": "unfinished"}]},
            {"parts": [{"fileId": "unfinished", "contentLength": 30}], "nextPartNumber": 2},
            {"parts": [{"fileId": "unfinished", "contentLength": 20}], "nextPartNumber": None},
        ]
        self.assertEqual(growth.census(b2, "vault"),
                         {"retained_bytes": 100, "retained_versions": 2,
                          "unfinished_bytes": 50, "unfinished_uploads": 1})
        calls = b2.call.call_args_list
        self.assertEqual(calls[1].kwargs["startFileName"], "vault/test")
        self.assertEqual(calls[1].kwargs["startFileId"], "older")
        self.assertEqual(calls[0].kwargs["prefix"], "vault/")
        self.assertEqual(calls[2].kwargs["namePrefix"], "vault/")
        self.assertEqual(calls[4].kwargs["startPartNumber"], 2)

    def test_transient_retry_same_page_and_no_retry_for_denial(self):
        pause = Mock()
        b2 = Mock(bucket_id="fixture")
        b2.call.side_effect = [growth.ApiError("list", 503, "service_unavailable"),
                               {"files": []}, growth.ApiError("list", 401, "unauthorized")]
        with self.assertRaises(growth.ApiError):
            growth.census(b2, "vault", pause=pause)
        self.assertEqual(b2.call.call_args_list[0], b2.call.call_args_list[1])
        self.assertEqual(b2.call.call_count, 3)
        pause.assert_called_once_with(1)

    def test_loop_or_out_of_scope_page_fails_without_totals(self):
        b2 = Mock(bucket_id="fixture")
        b2.call.return_value = {"files": [], "nextFileName": "vault/file", "nextFileId": "same"}
        with self.assertRaisesRegex(Exception, "pagination"):
            growth.census(b2, "vault")
        b2.call.return_value = {"files": [item("vault-unrelated/object", "upload", 1)]}
        with self.assertRaisesRegex(Exception, "outside expected scope"):
            growth.census(b2, "vault")


if __name__ == "__main__":
    unittest.main()
