# Disposable B2 recovery test

Status **synthetic damage and recovery verified**. The Owner approved
the exact disposable scope under #217. Six encrypted objects were uploaded.
An initial HTTP 403 `download_cap_exceeded` blocked the baseline; no damage
was attempted then. The Owner saved a payment card and approved a $0.10/day
download cap. The dashboard showed storage at $0/10 GB, downloads at $0.10/11 GB,
and email cap alerts enabled. Read access then recovered, and the baseline and
independent version map were verified before the approved hide and overwrite.

After damage, the ordinary restic restore failed as expected. B2 pagination
returned eight rows over four pages. The hidden pack's original version and
its delete marker both reported `IsLatest=true` in the paged listing. One
explicitly untruncated listing with `max-keys=32` returned the same eight
object/version identities and marked only the delete marker latest. The first
helper stopped before reconstruction. The read-only continuation compares both
identity sets and checks current object reads against the intended damage. It
uses the saved map to fetch the six original versions by exact ID, verify their
hashes, and reconstruct locally. The complete-page check applies only to this
fixed, eight-row fixture. The continuation rebuilt 1,853 encrypted bytes
from six versions. Local restic check and restore verified the fixture bytes
and extended attribute. Full application recovery remains pending.
[Recovery proof](hidden-version-proof.json).

Purpose: prove that hidden/replaced cloud versions can reconstruct a damaged backup repository. The fixture contains one synthetic sentence and one synthetic filesystem attribute.

Destination: the approved private Toronto bucket, exclusively under `vault/_verify/hidden-20261114-7f3d9a8c/hidden-recovery/`.

The reviewed test will:

1. Upload six locally prepared encrypted objects and verify a normal restore.
2. Preserve their exact version IDs, sizes and ciphertext hashes in a private independent map. Force multiple listing pages to test pagination.
3. Hide the synthetic pack below and overwrite the synthetic index below with fixture bytes. Verify that ordinary restoration fails.
4. Read the saved versions into a new local repository, check every pack, and restore the original fixture bytes and extended attribute.

Exact objects affected in step 3, relative to the destination prefix:

- Hide: `data/69/69c93a3dd5fbe92a31d850f43fcb4ffca12e83abb3ae26591cf4798dba3d82ab`
- Overwrite: `index/69ab08c22bd22ab6f54d9ff38becdbb63d9c2b4515cd8a06277d70c11682e1ff`

Local fixture-plan SHA-256: `46e08c083dba8755a102b77875e64e92e96e7cdca9240758625c84a3c649804d`.

Scope excludes permanent version deletion and the two primary backup repositories. Test objects remain afterward for separately authorized cleanup. No private user files are uploaded by this drill.
