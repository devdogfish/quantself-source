# Offline PDF redaction proof

[#213](https://github.com/devdogfish/quantself/issues/213) owns redaction and Owner-approved export. [#155](https://github.com/devdogfish/quantself/issues/155) owns private capture, extraction and reveal, and requires a flattened export. This proof uses invented data and has no app, storage, or service integration.

## Reproduce

Stage Python 3.12, Poppler (`pdftotext`, `pdfinfo`), Tesseract with `eng` trained data, and the pinned Python wheels before going offline. From the repository root:

```sh
proof_env=$(mktemp -d)
uv venv --python 3.12 "$proof_env/venv"
uv pip install --python "$proof_env/venv/bin/python" --only-binary :all: \
  'PyMuPDF==1.27.2.3' 'pypdf==7.1.0'

"$proof_env/venv/bin/python" scripts/proofs/pdf-redaction/proof.py
```

The runner makes one text PDF and one image-only PDF with two pages. It finds the text identifier using PDF text coordinates and the scan identifiers using Tesseract word boxes. It applies PyMuPDF text and image-pixel redactions, then builds new raster-only pages. MuPDF added catalog producer information in both versions tried (1.27.2.3 and 2.1). pypdf copies only the fresh raster pages and writes without an Info dictionary.

Stage Tesseract `deu` trained data and pass `--german` to add one German text page and one German image-only page. Both use German anchors with umlauts and an invented two-word identifier. The scan must match both consecutive words on one OCR line and redact the union of their boxes. The overlay controls must still expose the full identifier through text extraction or the original embedded pixels. Each identifier token must be absent from final OCR, and the independently labeled region must be blank.

The run must find all three markers in the original page OCR and the planted markers in source Info and XMP. Cosmetic white overlays pass rendered OCR but still expose text or embedded image pixels. The applied and flattened exports must pass the applicable checks below:

- Poppler extracts no text from the final PDFs. Applied redaction removes the identifier even before flattening the text PDF.
- The labeled regions are white in the decoded scan image after applied redaction and in all embedded export images. Final embedded pixels equal the redacted working-page pixels. OCR checks both rendered and embedded export images for the markers and requires both unchanged text anchors on every page.
- The final PDFs have one opaque full-page raster per page, no extra PDF objects, and no Info or XMP. Verification exits nonzero on mismatch or tool error.

By default the runner removes the scratch PDFs. For visual inspection, add `--artifacts-dir /path/to/new-directory`. The retained directory includes the original and cosmetic overlay controls with their invented identifiers.

Verified on macOS arm64 with network access denied, Poppler 26.04.0 and Tesseract 5.5.2. The three-page proof took 2.47 seconds after dependency installation. A separate offline CPU check with PaddlePaddle 3.3.1, PaddleOCR 3.7.0 and staged PP-OCRv5 mobile models found both identifiers on the scan input and zero on the export, with both anchors readable on each page. [PaddleOCR model and local directory options](https://www.paddleocr.ai/latest/en/version3.x/pipeline_usage/OCR.html)

## Linux resource baseline

On a Docker host with cgroup v2, stage the public dependencies and synthetic runner in a separate build context. Run from the repository root.

```sh
(
set -eu
proof_build=$(mktemp -d)
trap 'rm -r "$proof_build"' EXIT
cp scripts/proofs/pdf-redaction/proof.py "$proof_build/"
cat > "$proof_build/Dockerfile" <<'EOF'
FROM python@sha256:05a994d2344eb364cc186910f4fc8786a38215f39f00d0acc25bff33a08f4177
RUN apt-get update && apt-get install -y --no-install-recommends \
    poppler-utils=25.03.0-5+deb13u4 tesseract-ocr=5.5.0-1+b1 \
    tesseract-ocr-eng=1:4.1.0-2 tesseract-ocr-deu=1:4.1.0-2 time=1.9-0.2 \
    && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir --only-binary=:all: --no-deps PyMuPDF==1.27.2.3 pypdf==7.1.0
COPY proof.py /proof.py
EOF
docker build --platform linux/amd64 -t qs213-redaction-resource "$proof_build"
)
```

Use a fresh offline container for each sample. The equal memory and swap limits disable swap. The command prints measured wall time, maximum process RSS, and aggregate cgroup peak including subprocesses and cached pages.

```sh
(
set -eu
for cap in 6g 1g; do
  docker run --rm --pull never --platform linux/amd64 --network none \
    --cpus=2 --memory="$cap" --memory-swap="$cap" --read-only \
    --tmpfs /tmp:rw,size=128m --cap-drop=ALL --security-opt=no-new-privileges \
    -e PYTHONDONTWRITEBYTECODE=1 qs213-redaction-resource sh -eu -c '
      for key in memory.max memory.swap.max cpu.max; do
        printf "%s=" "$key"; cat "/sys/fs/cgroup/$key"
      done
      status=0
      timeout 90s /usr/bin/time -f "wall_s=%e max_rss_KiB=%M" \
        python /proof.py --german || status=$?
      printf "cgroup_peak_bytes="; cat /sys/fs/cgroup/memory.peak
      cat /sys/fs/cgroup/memory.events
      exit "$status"
    '
done
)
```

Require all five pages to pass and zero `oom` or `oom_kill` events. On Docker Desktop with emulated Linux/amd64 and 3.83 GiB guest RAM, peak cgroup memory was under 145 MiB. Two runs with the 6 GiB cgroup limit took 10.67–12.37 s. Four runs with the 1 GiB limit took 10.66–10.74 s. A deliberately truncated scan redaction was rejected by the decoded pixel check. [Merged fixture](https://github.com/devdogfish/quantself/pull/431)

This measures the synthetic Tesseract proof. VM qualification still requires measurements on Keep with PaddleOCR, speech-to-text, and the shared job queue.

## Shared queue proof

The existing receipt worker leases receipt jobs, and Girke serializes its async transcription jobs separately. Girke's direct OCR handler does not go through that transcription queue. This proof creates a disposable FIFO with one active child process and two waiting slots. It checks overflow refusal, queued cancellation, termination and reaping of an active blocker, FIFO order, and successful transcription, OCR, and redaction. Each engine exits before the next starts, so model memory can be reclaimed.

Stage the Linux image from the resource baseline above. Add `libgl1=1.7.0-1+b2` and install the extra wheels in the image. For a native macOS fallback, stage the same Python packages in the proof's Python 3.12 virtual environment instead.

```Dockerfile
RUN pip install --no-cache-dir --only-binary=:all: paddlepaddle==3.3.1 \
    paddleocr==3.7.0 faster-whisper==1.2.1 ctranslate2==4.8.1 av==16.0.1
```

faster-whisper 1.2.1 needs the `metadata_errors` argument to decode audio. PyAV 19.0.2 rejected it during the Linux rehearsal.

Stage these inputs in a disposable directory before disconnecting the container.

- Set `whisper_dir` to the [Whisper Small snapshot](https://huggingface.co/Systran/faster-whisper-small/tree/536b0662742c02347bc0e980a01041f333bce120) at revision `536b0662742c02347bc0e980a01041f333bce120`. Include `config.json`, `tokenizer.json`, `vocabulary.txt`, and `model.bin`. The latter's SHA-256 is `3e305921506d8872816023e4c273e75d2419fb89b24da97b4fe7bce14170d671`.
- Set `paddle_dir` to a directory holding the extracted [detection](https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/PP-OCRv5_mobile_det_infer.tar) and [recognition](https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/PP-OCRv5_mobile_rec_infer.tar) PP-OCRv5 mobile model directories. The archive SHA-256 values are `37920f08bc551e4124a9ace4de6cb109f2d441f8d140114b1c8844d756f9be02` and `566b9512b34e34a9f0db54d87b51fa5a0b9ed2cf1ab7e49728cc0b8b5a64f414`, respectively.
- Generate a WAV of “The blue lantern shines. The blue lantern shines.” with local text-to-speech, then set `synthetic_wav` to its absolute path. The measured sample used macOS Samantha and FFmpeg to produce mono 16 kHz PCM. Copy only `proof.py` and `queue_proof.py` into a scratch directory and set `proof_dir` to its absolute path.

If transferring a saved image instead of building on the test host, verify the transfer checksum and the sealed image config before loading. Compare the config's ordered root filesystem layer digests with Docker's loaded layers. Docker Desktop and Atlas reported different image IDs for the same archive. The example uses the exact archive from the native run. For a new staged image, record its archive checksum and config digest at staging time.

```sh
queue_image=qs213-native-offline:6a7eba60
(
  set -eu
  archive=image/qs213-image.tar.gz
  archive_sha=9460fd28aa565d0f2cff05c541e987076e7bd587601af356e6777f63f1ddf67d
  config_sha=035cd6723b34337f671d5d6ec5285c087cbf2e185c01d64299b05b932d8eeb69
  config=$(mktemp)
  trap 'rm -f "$config"' EXIT
  printf '%s  %s\n' "$archive_sha" "$archive" | sha256sum -c -
  tar -xOzf "$archive" "blobs/sha256/$config_sha" > "$config"
  printf '%s  %s\n' "$config_sha" "$config" | sha256sum -c -
  if docker image inspect "$queue_image" >/dev/null 2>&1; then
    echo "Choose a test context without the fixture image tag." >&2
    exit 1
  fi
  docker image load -i "$archive"
  if ! {
    test "$(docker image inspect "$queue_image" --format '{{.Os}}/{{.Architecture}}')" = linux/amd64 &&
    docker image inspect "$queue_image" --format '{{json .RootFS.Layers}}' | python3 -c '
import json
import sys
from pathlib import Path

expected = json.loads(Path(sys.argv[1]).read_text())["rootfs"]["diff_ids"]
actual = json.load(sys.stdin)
if expected != actual:
    raise SystemExit("loaded rootfs differs from the sealed image")
print(f"loaded {len(actual)} layer digests matched the sealed image")
' "$config"
  }; then
    docker image rm "$queue_image"
    exit 1
  fi
)
```

Run on a native amd64 test host with cgroup v2. Use the verified saved image above, or keep the default tag if you built on the test host.

```sh
docker run --rm --pull never --platform linux/amd64 --network none \
  --cpus=2 --memory=6g --memory-swap=6g --read-only --init \
  --tmpfs /tmp:rw,size=256m --cap-drop=ALL --security-opt=no-new-privileges \
  -e HOME=/tmp -e PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=True -e HF_HUB_OFFLINE=1 \
  -e PYTHONDONTWRITEBYTECODE=1 -e OMP_NUM_THREADS=2 -e OPENBLAS_NUM_THREADS=2 \
  -v "$proof_dir:/proof:ro" -v "$whisper_dir:/whisper:ro" \
  -v "$paddle_dir:/paddle:ro" -v "$synthetic_wav:/synthetic.wav:ro" \
  "${queue_image:-qs213-redaction-resource}" sh -eu -c '
    for key in memory.max memory.swap.max cpu.max; do
      printf "%s=" "$key"; cat "/sys/fs/cgroup/$key"
    done
    test "$(cat /sys/fs/cgroup/memory.max)" = 6442450944
    test "$(cat /sys/fs/cgroup/memory.swap.max)" = 0
    test "$(cat /sys/fs/cgroup/cpu.max)" = "200000 100000"
    status=0
    timeout 230s /usr/bin/time -f "wall_s=%e max_rss_KiB=%M" python /proof/queue_proof.py \
      --whisper-model /whisper --paddle-models /paddle --audio /synthetic.wav || status=$?
    printf "cgroup_peak_bytes="; cat /sys/fs/cgroup/memory.peak
    cat /sys/fs/cgroup/memory.events
    awk '"'"'$1 == "oom" || $1 == "oom_kill" {if ($2 != 0) exit 1}'"'"' /sys/fs/cgroup/memory.events
    exit "$status"
  '
```

Remove the fixture image tag after the run if you loaded it for the test.

### Native test result

One offline run of fixture commit `6a7eba60` passed on Atlas coding VM 3362, Linux x86_64 on an Intel Core i7-8700 with rootless Docker 29.9.3. The 6 GiB cgroup cap, zero swap, and two-CPU quota were verified in the container. The bundle was reassembled from 1,276 indexed chunks and verified by SHA-256 before load. All nine loaded layer digests matched the sealed image.

| Check | Result |
| --- | --- |
| FIFO, overflow refusal, queued and active cancellation | Passed |
| Whisper Small int8 | 4.28 s |
| PaddleOCR | 4.98 s |
| Redaction and controls, all five pages | 6.15 s |
| End-to-end wall time | 15.74 s |
| Peak cgroup memory | 1,274,871,808 bytes (1.19 GiB) |
| Maximum process RSS | 1,268,904 KiB |
| Cgroup OOM and OOM kills | 0 |

The test container, image and guest scratch were removed. These timings describe the disposable Atlas test. Service integration, restart recovery, bounds on representative workloads, and measurements on Keep remain open.

### macOS fallback

Docker's amd64 emulation on macOS arm64 returned SIGILL while PaddlePaddle loaded its detector. To run the full engine sequence locally on macOS, use the staged virtual environment with network access denied. Set `proof_env` as in the first example and `scratch_home` to an empty temporary directory.

```sh
HOME="$scratch_home" PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=True HF_HUB_OFFLINE=1 \
  PYTHONDONTWRITEBYTECODE=1 OMP_NUM_THREADS=2 OPENBLAS_NUM_THREADS=2 \
  sandbox-exec -p '(version 1) (allow default) (deny network*)' /usr/bin/time -lp \
  "$proof_env/venv/bin/python" "$proof_dir/queue_proof.py" --whisper-model "$whisper_dir" \
  --paddle-models "$paddle_dir" --audio "$synthetic_wav"
```

Both native macOS runs passed all three jobs and the queue controls in 17.19–50.25 s, with up to 993 MiB maximum RSS. macOS reports maximum RSS without enforcing a memory cap. In the emulated Linux container, Whisper alone passed in 20.74 s at 878 MiB cgroup peak with a 3 GiB cap and swap disabled. The full Linux run stopped at PaddlePaddle's SIGILL with zero OOM events.

## Owner-only validation on a labeled set

1. In a private offline workspace, label each occurrence by document alias, page, identifier type, exact value and expected formatting variants, and visible box if applicable. Include Info and XMP occurrences. Start with text, image-only scans and scans with an OCR layer. Include later pages, repeated identifiers, a low-quality scan, and representative German and English samples. Mark safe content on every page. Keep the labels, originals, OCR text, review overlays, and mapping private.
2. Run the candidate redactor locally. For each detector, count labeled occurrences it covered and missed, then do the same for the union. Count a hit only when the output box covers the full identifier or the correct metadata field is removed. Compare with the original labels and record only aggregate counts externally. An OCR baseline miss belongs in the miss count, even if a second detector found the identifier.
3. Reopen the exact candidate export. Require all pages in order, a fresh image-only PDF with one opaque raster per page, and no source objects, old revisions, annotations, links, forms, attachments, or metadata. Use a structure check for the actual exporter. The fixture's shape check expects its own writer and page dimensions. Independently check with Poppler `pdftotext`, `pdfinfo -meta`, `pdfimages -list` and `pdfdetach -list`. Inspect the Info dictionary as well as XMP.
4. Render every page (`pdftoppm -r 300 -png`) and extract every embedded image (`pdfimages -png`). OCR both locally with the relevant installed languages. Search the output for the labeled spellings and type-specific variants, including punctuation, spaces and line breaks. Compare each labeled box visually against the input and inspect the surrounding safe content. Verify expected safe text or page landmarks so unreadable, blank or wrong pages fail. Compare the decoded embedded pixels with the redacted page pixels before packaging.
5. Reject a candidate with any residual listed identifier, incomplete page or label coverage, unexpected structure, or extraction/OCR error. Keep the highlighted comparison local. If the Owner approves a candidate, bind approval to the verified PDF's SHA-256 and check it again before export.

The redaction proof covers three clean single-word synthetic occurrences and, with `--german`, two clean two-word occurrences using supplied exact matches and Tesseract. Production queues, Keep capacity, real-document accuracy, and Vault/Work export remain open.

[PyMuPDF redaction](https://pymupdf.readthedocs.io/en/latest/page.html#Page.apply_redactions) · [Tesseract TSV output](https://tesseract-ocr.github.io/tessdoc/Command-Line-Usage.html#tsv-output)
