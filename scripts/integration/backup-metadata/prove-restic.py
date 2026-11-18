import hashlib, importlib.util, json, os, random, subprocess, tempfile
from pathlib import Path
spec=importlib.util.spec_from_file_location('metadata', str(Path(__file__).resolve().parents[2] / 'infra/keep-storage/backup_inventory.py'))
metadata=importlib.util.module_from_spec(spec); spec.loader.exec_module(metadata)

def run(args, **kwargs):
    p=subprocess.run(args, text=True, capture_output=True, **kwargs)
    if p.returncode: raise RuntimeError(p.stderr)
    return p.stdout

with tempfile.TemporaryDirectory(prefix='restic-proof-') as tmp:
    base=Path(tmp); source=base/'source'; source.mkdir(mode=0o700)
    data=source/'original.bin'; data.write_bytes(random.Random(254).randbytes(16*1024*1024))
    data.chmod(0o640); os.chown(data,1000,1000)
    os.setxattr(data,'user.oc.fileid',b'synthetic-file-id-254')
    os.setxattr(source,'user.oc.spaceid',b'synthetic-space-id-254')
    os.link(data,source/'hardlink.bin'); (source/'symlink').symlink_to('original.bin')
    (source/'readable name.txt').write_text('Synthetic receipt only.\n')
    sparse=source/'sparse.bin'
    with sparse.open('wb') as f: f.seek(64*1024*1024-1); f.write(b'\0')
    manifest=base/'inventory.json'
    metadata.write_inventory(source, manifest)
    repo=base/'repository'
    env=dict(os.environ, RESTIC_PASSWORD='SYNTHETIC-LOCAL-PROOF-NO-PRIVATE-DATA')
    common=['/restic/restic','--repo',str(repo),'--cache-dir',str(base/'cache')]
    run(common+['init'],env=env)
    def backup():
        output=run(common+['backup','--json',str(source)],env=env)
        return next(json.loads(line) for line in output.splitlines() if json.loads(line).get('message_type')=='summary')
    def size(): return sum(p.stat().st_size for p in repo.rglob('*') if p.is_file())
    first=backup(); firstbytes=size()
    run(common+['check','--read-data'],env=env)
    dest=base/'restore'
    run(common+['restore',first['snapshot_id'],'--target',str(dest),'--sparse'],env=env)
    originals=list(dest.rglob('original.bin')); assert len(originals)==1
    restored=originals[0].parent
    metadata.verify_inventory(restored, manifest)
    assert (restored/'original.bin').stat().st_ino==(restored/'hardlink.bin').stat().st_ino
    assert (restored/'sparse.bin').stat().st_blocks*512<1024*1024
    backup(); samebytes=size()
    with data.open('r+b') as f: f.seek(8*1024*1024); f.write(random.Random(255).randbytes(64*1024))
    backup(); changedbytes=size()
    print(json.dumps({'syntheticOnly':True,'resticVersion':run(['/restic/restic','version']).strip(),
        'metadataAndContentsRestored':True,'hardlinkAndSparseRestored':True,
        'initialRepositoryBytes':firstbytes,'unchangedSnapshotAddedBytes':samebytes-firstbytes,
        'changed64KiBAddedBytes':changedbytes-samebytes},indent=2))
