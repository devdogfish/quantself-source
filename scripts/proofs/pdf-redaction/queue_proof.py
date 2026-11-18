"""Run one disposable FIFO through STT, OCR, and the synthetic redaction proof."""

import argparse
import os
import re
import signal
import subprocess
import sys
from collections import deque
from pathlib import Path
from tempfile import TemporaryDirectory
from time import monotonic, sleep

from proof import ANCHORS, MARKERS, Fixture, make_source, raster, require

SCRIPT = Path(__file__).resolve()
JOB_TIMEOUT = 120


class ProofQueue:
    """One active process and at most two waiting commands, for this proof only."""

    def __init__(self):
        self.waiting = deque()
        self.active = None

    def submit(self, name, command):
        if len(self.waiting) == 2:
            return False
        self.waiting.append((name, command))
        self.start_if_idle()
        return True

    def start_if_idle(self):
        if self.active is None and self.waiting:
            name, command = self.waiting.popleft()
            process = subprocess.Popen(command, start_new_session=True)
            self.active = (name, process, monotonic())

    def cancel_waiting(self, name):
        for entry in self.waiting:
            if entry[0] == name:
                self.waiting.remove(entry)
                return True
        return False

    def stop_active(self):
        if self.active is None:
            raise RuntimeError("no active job")
        _, process, _ = self.active
        os.killpg(process.pid, signal.SIGKILL)
        result = process.wait(timeout=5)
        self.active = None
        return result

    def cancel_active(self):
        require(self.stop_active() == -signal.SIGKILL, "active cancellation did not kill the worker")
        self.start_if_idle()

    def finish_active(self):
        name, process, started = self.active
        status = process.wait(timeout=JOB_TIMEOUT)
        self.active = None
        require(status == 0, f"{name} failed with status {status}")
        print(f"PASS {name} wall_s={monotonic() - started:.2f}", flush=True)
        self.start_if_idle()
        return name


def check_stt(model_dir, audio):
    from faster_whisper import WhisperModel

    model = WhisperModel(model_dir, device="cpu", compute_type="int8",
                         cpu_threads=2, num_workers=1, local_files_only=True)
    segments, _ = model.transcribe(audio, language="en", beam_size=1,
                                  condition_on_previous_text=False)
    words = re.findall(r"[a-z]+", " ".join(segment.text for segment in segments).lower())
    require("the blue lantern shines" in " ".join(words), "synthetic phrase missing")


def check_ocr(models):
    import pymupdf
    from paddleocr import PaddleOCR

    detection = "PP-OCRv5_mobile_det"
    recognition = "PP-OCRv5_mobile_rec"
    engine = PaddleOCR(
        device="cpu", cpu_threads=2, enable_mkldnn=False,
        text_detection_model_name=detection,
        text_detection_model_dir=str(models / (detection + "_infer")),
        text_recognition_model_name=recognition,
        text_recognition_model_dir=str(models / (recognition + "_infer")),
        use_doc_orientation_classify=False, use_doc_unwarping=False,
        use_textline_orientation=False,
    )
    with TemporaryDirectory(prefix="qs-213-paddle-") as scratch:
        source = Path(scratch) / "invented.pdf"
        image = source.with_suffix(".png")
        make_source(source, Fixture((MARKERS[1],), scanned=True))
        with pymupdf.open(source) as pdf:
            raster(pdf[0]).save(image)
        words = engine.predict(str(image))[0]["rec_texts"]
    require(words == [ANCHORS[0], MARKERS[1], ANCHORS[1]], "PaddleOCR missed fixture text")


def exercise(args):
    with TemporaryDirectory(prefix="qs-213-queue-") as scratch:
        run_queue(args, Path(scratch))


def run_queue(args, scratch):
    queue = ProofQueue()
    ready = scratch / "ready"
    unexpected = scratch / "unexpected"
    marker = "import sys; from pathlib import Path; Path(sys.argv[1]).touch()"
    never_run = [sys.executable, "-c", marker, str(unexpected)]
    blocker = [sys.executable, "-c", marker + "; import time; time.sleep(120)", str(ready)]
    stt = [sys.executable, str(SCRIPT), "_stt", args.whisper_model, args.audio]
    ocr = [sys.executable, str(SCRIPT), "_ocr", args.paddle_models]
    redaction = [sys.executable, str(SCRIPT.with_name("proof.py")), "--german"]
    try:
        require(queue.submit("blocker", blocker), "blocker was refused")
        deadline = monotonic() + 5
        while not ready.exists() and monotonic() < deadline:
            sleep(0.01)
        require(ready.exists() and queue.active[1].poll() is None, "blocker did not start")
        require(queue.submit("faster-whisper", stt), "STT was refused")
        require(queue.submit("queued-cancel", never_run), "waiting job was refused")
        require(not queue.submit("overflow", never_run), "queue admitted an overflow")
        require(queue.active[0] == "blocker", "queued job displaced the active worker")
        require(queue.cancel_waiting("queued-cancel"), "queued cancellation did not free capacity")
        require(queue.submit("PaddleOCR", ocr), "OCR could not use the freed capacity")
        queue.cancel_active()
        require(queue.active[0] == "faster-whisper", "oldest waiting job did not start")
        require(queue.submit("redaction", redaction), "redaction was refused")
        print("PASS contention, overflow refusal, queued cancellation, active cancellation", flush=True)
        order = [queue.finish_active() for _ in range(3)]
        require(order == ["faster-whisper", "PaddleOCR", "redaction"], "wrong completion order")
        require(queue.active is None and not queue.waiting, "queue did not drain")
        require(not unexpected.exists(), "cancelled or rejected job ran")
    finally:
        if queue.active is not None:
            queue.stop_active()


def main():
    if sys.argv[1:2] == ["_stt"]:
        check_stt(*sys.argv[2:])
        return
    if sys.argv[1:2] == ["_ocr"]:
        check_ocr(Path(sys.argv[2]))
        return
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--whisper-model", required=True, help="local faster-whisper Small model")
    parser.add_argument("--paddle-models", required=True, help="local PP-OCRv5 mobile model directory")
    parser.add_argument("--audio", required=True, help='synthetic WAV with "The blue lantern shines"')
    exercise(parser.parse_args())


if __name__ == "__main__":
    main()
