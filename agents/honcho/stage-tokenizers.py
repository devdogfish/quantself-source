"""Stage and verify the tokenizer cache for Honcho v3.6.1."""

import argparse
import hashlib
import os
from pathlib import Path
import sys
import tempfile
from urllib.request import urlopen


# These are the encoding hashes from tiktoken 0.12.0, pinned by Honcho v3.6.1.
ENCODING_HASHES = {
    "cl100k_base": "223921b76ee99bde995b7ff738513eef100fb51d18c93597a113bcffe865b2a7",
    "o200k_base": "446a9538cb6c348e3516120d7c08b09f57c36495e2acfffe59a5bf8b0cfb1a2d",
}
ENCODING_BASE_URL = "https://openaipublic.blob.core.windows.net/encodings"
MAX_BYTES = 8 * 1024 * 1024


def valid_cache(path, expected):
    if not path.is_file() or path.is_symlink():
        return False
    metadata = path.stat()
    if metadata.st_size > MAX_BYTES or not metadata.st_mode & 0o004:
        return False
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest() == expected


def stage(directory, verify_only):
    if not verify_only:
        try:
            directory.mkdir(mode=0o755, parents=True)
        except FileExistsError:
            pass
        else:
            directory.chmod(0o755)
    if directory.is_symlink() or not directory.is_dir() or directory.stat().st_mode & 0o005 != 0o005:
        raise ValueError("Tokenizer directory must be readable by the container user")
    for name, expected in ENCODING_HASHES.items():
        url = f"{ENCODING_BASE_URL}/{name}.tiktoken"
        # tiktoken looks up the URL's SHA-1. Verify the file bytes with SHA-256.
        target = directory / hashlib.sha1(url.encode(), usedforsecurity=False).hexdigest()
        if valid_cache(target, expected):
            continue
        if verify_only:
            raise ValueError(f"Tokenizer is missing or corrupt: {name}")
        with urlopen(url, timeout=30) as response:
            data = response.read(MAX_BYTES + 1)
        if len(data) > MAX_BYTES or hashlib.sha256(data).hexdigest() != expected:
            raise ValueError(f"Tokenizer download failed the digest check: {name}")
        with tempfile.NamedTemporaryFile(dir=directory, delete=False) as temp:
            temporary_path = Path(temp.name)
            try:
                temp.write(data)
                temp.flush()
                os.fchmod(temp.fileno(), 0o644)
                os.replace(temporary_path, target)
            finally:
                temporary_path.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path, nargs="?", default=Path("/var/lib/honcho/tokenizers"))
    parser.add_argument("--verify-only", action="store_true")
    args = parser.parse_args()
    try:
        stage(args.directory, args.verify_only)
    except (OSError, ValueError) as error:
        print(error, file=sys.stderr)
        return 1
    print(f"Verified {len(ENCODING_HASHES)} Honcho tokenizers")
    return 0


if __name__ == "__main__":
    sys.exit(main())
