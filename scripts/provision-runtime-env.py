"""Update allowlisted dotenv assignments without printing credential contents."""
import json
import os
import pathlib
import re
import stat
import sys
import tempfile

ALLOWED = {
    "QUANTSELF_HABITS_REPOSITORY", "QUANTSELF_HABITS_GITHUB_APP_ID",
    "QUANTSELF_HABITS_GITHUB_INSTALLATION_ID", "QUANTSELF_HABITS_GITHUB_PRIVATE_KEY",
    "QUANTSELF_TODO_REPOSITORY", "QUANTSELF_TODO_TEST_REPOSITORY",
    "QUANTSELF_TODO_PROJECT_NUMBER", "QUANTSELF_JARVIS_TOOL_ORIGIN",
    "QUANTSELF_GITHUB_APP_ID", "QUANTSELF_GITHUB_INSTALLATION_ID",
    "QUANTSELF_GITHUB_PRIVATE_KEY", "QUANTSELF_GITHUB_WEBHOOK_SECRET",
    "QUANTSELF_ELEVENLABS_API_KEY", "QUANTSELF_ELEVENLABS_AGENT_ID",
    "QUANTSELF_ELEVENLABS_PHONE_AGENT_ID", "QUANTSELF_TWILIO_ACCOUNT_SID",
    "QUANTSELF_TWILIO_AUTH_TOKEN", "QUANTSELF_TWILIO_PHONE_NUMBER",
    "QUANTSELF_PHONE_OWNER_NUMBER", "QUANTSELF_PHONE_PIN_HASH",
    "QUANTSELF_PHONE_PUBLIC_URL", "QUANTSELF_PHONE_ENABLED", "QUANTSELF_PHONE_API_KEY",
}

JOBS_SECRETS = {"JOBS_RUNNER_SECRET", "JOBS_WORKER_SECRET"}
NATIVE_ANALYTICS_SECRETS = {
    "QUANTSELF_WEBSITE_ANALYTICS_INGEST_TOKEN",
    "QUANTSELF_TRACKED_LINKS_READ_TOKEN",
    "QUANTSELF_TRACKED_LINKS_APPLICATION_TOKEN",
    "QUANTSELF_TRACKED_LINKS_SHARE_TOKEN",
}


def read_private_runtime(path):
    # Never follow a final symlink or block opening a nonregular file.
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)) as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError("Runtime source must be a private owned file")

        def unique_keys(pairs):
            values = dict(pairs)
            if len(values) != len(pairs):
                raise ValueError("Runtime file contains duplicate keys")
            return values

        return json.load(source, object_pairs_hook=unique_keys)

def update(text, values, *, private_keys=None):
    allowed = private_keys if private_keys is not None else ALLOWED
    if not isinstance(values, dict) or not values or set(values) - allowed:
        raise ValueError("Runtime configuration contains unsupported keys")
    if any(not isinstance(v, str) or not v or "\x00" in v or "\r" in v for v in values.values()):
        raise ValueError("Runtime configuration contains invalid values")
    if private_keys == JOBS_SECRETS:
        if values.keys() != JOBS_SECRETS:
            raise ValueError("Both Jobs runtime secrets are required")
        if any(len(value) < 32 or any(char.isspace() or char == "\ufeff" for char in value)
               for value in values.values()):
            raise ValueError("Jobs runtime secrets require at least 32 characters without whitespace")
        if values["JOBS_RUNNER_SECRET"] == values["JOBS_WORKER_SECRET"]:
            raise ValueError("Jobs runtime secrets must be distinct")
    if private_keys == NATIVE_ANALYTICS_SECRETS:
        if values.keys() != NATIVE_ANALYTICS_SECRETS:
            raise ValueError("All four native analytics runtime tokens are required")
        if any(not re.fullmatch(r"[!-~]{32,}", value) for value in values.values()):
            raise ValueError("Native analytics tokens require at least 32 visible ASCII characters")
        if len(set(values.values())) != len(NATIVE_ANALYTICS_SECRETS):
            raise ValueError("Native analytics runtime tokens must be distinct")
    lines = text.splitlines(keepends=True)
    retained = []
    i = 0
    while i < len(lines):
        first = lines[i]
        match = re.match(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)", first)
        chunk = [first]
        i += 1
        if match:
            value = match.group(2)
            if value.startswith(("'", '"')):
                quote = value[0]
                remainder = value[1:]
                closed = False
                while True:
                    escaped = False
                    for char in remainder:
                        if char == quote and not escaped:
                            closed = True
                            break
                        escaped = char == "\\" and not escaped if quote == '"' else False
                    if closed:
                        break
                    if i >= len(lines):
                        raise ValueError("Existing dotenv has an unterminated quoted assignment")
                    remainder = lines[i]
                    chunk.append(remainder)
                    i += 1
        if not match or match.group(1) not in values:
            retained.extend(chunk)
    # Single quotes stop Compose interpolation; literal multiline strings preserve PEM.
    # Apostrophes cannot safely roundtrip both Compose and Bun, so reject before writing.
    if private_keys is None and any("'" in value or "$" in value for value in values.values()):
        raise ValueError("Runtime values cannot contain apostrophes or dollar signs")
    output = "".join(retained).rstrip("\n") + "\n"
    if private_keys is not None:
        # Compose decodes double-quoted escapes and treats doubled dollars literally.
        return output + "".join(
            key + "=" + json.dumps(value, ensure_ascii=False).replace("$", "$$") + "\n"
            for key, value in values.items()
        )
    return output + "".join(key + "='" + value + "'\n" for key, value in values.items())

def main():
    if len(sys.argv) < 2:
        raise ValueError("Provide an explicit runtime dotenv path")
    path = pathlib.Path(sys.argv[1])
    private_runtime_modes = {
        "--jobs-runtime-file": (JOBS_SECRETS, "Jobs"),
        "--native-analytics-runtime-file": (NATIVE_ANALYTICS_SECRETS, "native analytics"),
    }
    mode = private_runtime_modes.get(sys.argv[2]) if len(sys.argv) == 4 else None
    private_keys = None
    if mode is not None:
        private_keys, name = mode
        try:
            values = read_private_runtime(sys.argv[3])
        except (OSError, ValueError):
            raise ValueError(f"Invalid private {name} runtime file") from None
    elif len(sys.argv) == 4 and sys.argv[2] == "--phone-runtime-file":
        source = pathlib.Path(sys.argv[3])
        info = source.lstat()
        if not source.is_file() or source.is_symlink() or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError("Phone runtime source must be a private owned file")
        values = {}
        for line in source.read_text().splitlines():
            match = re.fullmatch(r"(QUANTSELF_PHONE_API_KEY|QUANTSELF_ELEVENLABS_PHONE_AGENT_ID)='([^'\r\n$]+)'", line)
            if not match or match.group(1) in values:
                raise ValueError("Invalid phone runtime file")
            values[match.group(1)] = match.group(2)
        if len(values) != 2:
            raise ValueError("Incomplete phone runtime file")
    elif len(sys.argv) <= 2:
        values = json.load(sys.stdin)
    else:
        raise ValueError("Unsupported provisioning arguments")
    content = update(path.read_text() if path.exists() else "", values, private_keys=private_keys)
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix=".env-provision-")
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w") as output:
            output.write(content)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    print("Runtime settings provisioned; services unchanged")

if __name__ == "__main__":
    main()
