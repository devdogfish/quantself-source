"""Synthetic nested MIME part and fault order shared by the peer and HTTP proof."""

import base64

SECTION = "2.1"
DISPLAY_TEXT = (
    "Bonjour, Montréal · Καλημέρα · 日本語 · مرحبًا\r\n"
    "<script>alert(1)</script><img src=x onerror=alert(2)> & <b>plain</b>\r\n"
    + "Café résumé · 漢字 · Ελληνικά · مرحبًا\r\n" * 80
).encode("utf-8")
DISPLAY_HTML = (b'<html><body><script>alert("html-only")</script>'
                b'<img src="https://example.test/html-only"></body></html>\r\n')
DISPLAY_CASES = (
    "valid", "html", "html-no-source", "html-wrong-uid", "html-epoch", "html-malformed-mime",
    "html-malformed-encoding", "duplicate-type", "attachment-disposition", "wrong-charset", "invalid-utf8",
    "wrong-section", "identity", "epoch", "tagged-no", "oversize-wire", "oversize-decoded", "valid",
)
SOURCE_CASES = (
    "valid", "projection-id", "raw-id", "raw-duplicate", "raw-missing", "oversize-header",
    "epoch", "wrong-uid", "wrong-section", "tagged-no", "truncated", "oversize", "partial-completion",
    "fragmented-completion", "slow-completion", "valid",
)
PAYLOAD = bytes(range(256)) * 2048
ENCODED = base64.encodebytes(PAYLOAD).replace(b"\n", b"\r\n")
TRANSFER_CASES = {
    # Exact MIME header, literal body, expected bytes. None means a closed failure.
    "implicit-7bit": (b"Content-Type: text/plain\r\n\r\n", b"ABCD\r\nlast", b"ABCD\r\nlast"),
    "empty-mime-7bit": (b"\r\n", b"ABCD", b"ABCD"),
    "implicit-nonascii": (b"Content-Type: text/plain\r\n\r\n", b"caf\xe9", None),
    "8bit": ("8bit", b"caf\xe9\r\n" + b"\xff" * 998, b"caf\xe9\r\n" + b"\xff" * 998),
    "8bit-long": ("8bit", b"\xff" * 999, None),
    "8bit-bare-lf": ("8bit", b"\xe9\nend", None),
    "binary": ("binary", b"\x01\xff\rX\n", b"\x01\xff\rX\n"),
    "binary-nul": ("binary", b"abc\x00def", None),
    "binary-literal8": ("binary", b"abc\x00def", None),
    "quoted-printable": (
        "quoted-printable",
        b"field=3Dval=20\r\n" * 8192 + b"price=3D5 \t=\r\nnext=20\t \r\n" + b"A" * 75 + b"=\r\nlast=E9=FF",
        b"field=val \r\n" * 8192 + b"price=5 \tnext \r\n" + b"A" * 75 + b"last\xe9\xff",
    ),
    "qp-binary": ("quoted-printable", b"=00=0D=0A=FF", b"\x00\r\n\xff"),
    "qp-lowercase": ("quoted-printable", b"part=fa", None),
    "qp-truncated-escape": ("quoted-printable", b"good\r\npart=F", None),
    "qp-truncated-soft-break": ("quoted-printable", b"good\r\npart=\r\n", None),
    "qp-overlong": ("quoted-printable", b"A" * 77 + b"\r\n", None),
    "qp-bare-lf": ("quoted-printable", b"good\npart=0A", None),
}
CASES = (
    "valid", "7bit", *TRANSFER_CASES, "duplicate-cte", "folded-spoof", "wrong-mime-section", "missing-mime", "oversize-mime",
    "unsupported-cte",
    "epoch", "wrong-uid", "wrong-section", "identity", "tagged-no", "truncated", "oversize", "valid",
)
