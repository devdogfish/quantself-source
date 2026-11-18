#!/usr/bin/env bash
# Capture an already-quiesced tree for Kopia. Kopia does not preserve all Linux
# filesystem metadata itself. GNU tar carries that metadata inside its payload.
# Caller must stop writers and keep them stopped until this command succeeds.
set -euo pipefail
umask 077
export LC_ALL=C

if [[ $# != 2 ]]; then
  echo 'Usage: archive-tree.sh ABSOLUTE_SOURCE_DIRECTORY ABSOLUTE_OUTPUT.tar' >&2
  exit 2
fi
source_dir=$1
archive=$2
[[ $source_dir == /* && $archive == /* && -d $source_dir && ! -L $source_dir ]] || exit 2
[[ $archive == *.tar && ! -e $archive && ! -L $archive ]] || exit 2
tar --version | head -1 | grep -q 'GNU tar' || {
  echo 'GNU tar is required for Linux metadata preservation.' >&2
  exit 2
}
source_dir=$(cd -- "$source_dir" && pwd -P)
[[ $source_dir != / ]] || exit 2
archive_parent=$(cd -- "$(dirname -- "$archive")" && pwd -P)
archive="$archive_parent/$(basename -- "$archive")"
case "$archive/" in "$source_dir/"*) echo 'Archive must be outside the source tree.' >&2; exit 2;; esac

# Never overwrite a prior capture. A failed .partial is retained for inspection;
# it must not be uploaded or treated as a completed restore point.
partial="$archive.partial"
(set -o noclobber; : > "$partial")
# Keep original ownership, modes, mtimes, links, ACLs and every xattr namespace.
# Stable ordering and omission of access/change timestamps reduce irrelevant
# archive churn. Do not gzip: Kopia compresses after content-defined chunking.
tar --create --file="$partial" --directory="$source_dir" \
  --format=pax --sort=name --numeric-owner --sparse --acls \
  --xattrs --xattrs-include='*' \
  --pax-option='exthdr.name=%d/PaxHeaders/%f,delete=atime,delete=ctime' .
# Publish atomically without replacing another capture, even if it appeared
# during tar. Both names reside in the same private staging directory.
ln -- "$partial" "$archive"
rm -- "$partial"
sha256sum -- "$archive"
