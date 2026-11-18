#!/usr/bin/env python3
"""Private, independent restore inventory for a stopped/frozen Linux tree.

Run on the frozen source before backup and on the isolated restored tree. This
does not make a changing tree consistent. Inventory files contain sensitive
filenames; keep them inside the encrypted recovery set, outside the scanned tree.
No file contents or xattr values are written to the inventory or standard output.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
import tempfile


class InventoryError(Exception):
    pass


def fingerprint(info):
    # ctime detects rewrites that preserve mtime during capture. It is deliberately
    # absent from the portable inventory: restoring an inode changes its ctime.
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid,
            info.st_size, info.st_mtime_ns, info.st_ctime_ns, info.st_nlink)


def attributes(path):
    return {name: hashlib.sha256(os.getxattr(path, name, follow_symlinks=False)).hexdigest()
            for name in sorted(os.listxattr(path, follow_symlinks=False))}


def scan(root):
    root = Path(os.path.abspath(root))
    if root.is_symlink() or not root.is_dir():
        raise InventoryError("Source must be a real directory")
    entries = []
    links = {}
    link_counts = {}

    def visit(path, relative):
        before = path.lstat()
        if before.st_dev != root_device:
            raise InventoryError("Nested filesystem: inventory each filesystem separately")
        entry = {"path": relative, "mode": stat.S_IMODE(before.st_mode),
                 "uid": before.st_uid, "gid": before.st_gid,
                 "mtime_ns": before.st_mtime_ns, "xattrs": attributes(path)}
        entries.append(entry)
        if stat.S_ISDIR(before.st_mode):
            entry["type"] = "directory"
            with os.scandir(path) as children:
                names = sorted(child.name for child in children)
            for name in names:
                visit(path / name, name if relative == "." else relative + "/" + name)
        elif stat.S_ISREG(before.st_mode):
            entry.update(type="file", size=before.st_size)
            identity = (before.st_dev, before.st_ino)
            if identity in links:
                entry["hardlink"] = links[identity]["path"]
                entry["sha256"] = links[identity]["sha256"]
            else:
                # O_NOFOLLOW prevents a final-component symlink swap from reading
                # outside the source. Offline/frozen input is still mandatory.
                fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
                with os.fdopen(fd, "rb") as stream:
                    if fingerprint(os.fstat(stream.fileno())) != fingerprint(before):
                        raise InventoryError("Source changed during inventory")
                    entry["sha256"] = hashlib.file_digest(stream, "sha256").hexdigest()
                links[identity] = entry
            count, _ = link_counts.get(identity, (0, before.st_nlink))
            link_counts[identity] = (count + 1, before.st_nlink)
        elif stat.S_ISLNK(before.st_mode):
            entry.update(type="symlink", target=os.readlink(path))
        else:
            raise InventoryError("Unsupported special file in recovery tree")
        if fingerprint(path.lstat()) != fingerprint(before) or attributes(path) != entry["xattrs"]:
            raise InventoryError("Source changed during inventory")

    root_device = root.lstat().st_dev
    visit(root, ".")
    if any(actual != expected for actual, expected in link_counts.values()):
        raise InventoryError("Hardlink crosses the recovery tree boundary")
    return {"format": 1, "entries": entries}


def write_inventory(root, destination):
    destination = Path(os.path.abspath(destination))
    resolved_root = Path(root).resolve()
    if destination.resolve().is_relative_to(resolved_root):
        raise InventoryError("Inventory must be outside the source tree")
    if destination.exists() or destination.is_symlink():
        raise InventoryError("Refusing to overwrite an existing inventory")
    inventory = scan(root)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", dir=destination.parent,
                                         prefix=".inventory-", delete=False) as stream:
            temporary = Path(stream.name)
            os.fchmod(stream.fileno(), 0o600)
            json.dump(inventory, stream, sort_keys=True, separators=(",", ":"))
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        # Publish atomically without replacing a concurrent writer's inventory.
        os.link(temporary, destination)
        directory = os.open(destination.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if temporary is not None:
            temporary.unlink()
    return inventory


def verify_inventory(root, source):
    with open(source) as stream:
        expected = json.load(stream)
    if not isinstance(expected, dict) or expected.get("format") != 1:
        raise InventoryError("Unsupported inventory format")
    actual = scan(root)
    if expected != actual:
        # Do not emit filenames, symlink targets, hashes or attribute data.
        raise InventoryError("Restored contents or filesystem metadata differ")
    return actual


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("capture", "verify"))
    parser.add_argument("root", type=Path)
    parser.add_argument("inventory", type=Path)
    args = parser.parse_args()
    try:
        result = (write_inventory if args.action == "capture" else verify_inventory)(
            args.root, args.inventory)
    except InventoryError as error:
        print(str(error), file=sys.stderr)
        return 1
    except (OSError, ValueError):
        # OS exception messages can contain sensitive paths. Fail closed, without
        # logging them. Operators can investigate locally in the recovery host.
        print("Inventory I/O or data error; inspect privately on the recovery host", file=sys.stderr)
        return 1
    print(json.dumps({"action": args.action, "verified_entries": len(result["entries"])}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
