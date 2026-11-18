#!/usr/bin/python3 -I
"""Generate an unsent written draft with Anthropic Sonnet 5.5."""
import json
import subprocess
import sys
from pathlib import Path
from urllib.error import URLError
from urllib.request import HTTPRedirectHandler, Request, build_opener

# Python's isolated mode excludes the executable's directory.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from vault import fetch_keys

MODEL = "claude-sonnet-5-5"
MAX_INPUT = 128 * 1024


class NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def draft(prompt, api_key):
    request = Request(
        "https://api.anthropic.com/v1/messages",
        data=json.dumps({
            "model": MODEL,
            "max_tokens": 4096,
            "system": "Write the requested draft for human review. Output only the draft.",
            "messages": [{"role": "user", "content": prompt}],
        }).encode(),
        headers={
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
    )
    with build_opener(NoRedirects()).open(request, timeout=90) as response:
        message = json.load(response)
    if message.get("stop_reason") != "end_turn":
        raise ValueError("Incomplete draft")
    return "\n".join(block["text"] for block in message["content"] if block["type"] == "text")


def main():
    data = sys.stdin.buffer.read(MAX_INPUT + 1)
    if not data.strip() or len(data) > MAX_INPUT:
        sys.exit("Provide a non-empty draft brief of at most 128 KiB on stdin")
    try:
        key = fetch_keys(("ANTHROPIC_API_KEY",))["ANTHROPIC_API_KEY"]
        result = draft(data.decode(), key).strip()
        if not result:
            raise ValueError("Empty draft")
    except (OSError, URLError, subprocess.SubprocessError, ValueError, KeyError, TypeError):
        sys.exit("Sonnet draft unavailable")
    print(result)


if __name__ == "__main__":
    main()
