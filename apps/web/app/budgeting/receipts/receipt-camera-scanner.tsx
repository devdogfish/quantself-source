"use client";

import { Button } from "@chakra-ui/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createReceiptCaptureGate, findReceiptFrame, type ReceiptFrame } from "./receipt-scanner-vision";
import "./receipt-camera-scanner.css";

type Props = {
  onCapture: (photo: File) => void | Promise<void>;
  autoSubmit?: boolean;
};

type Upload = { file: File; state: "sending" | "saved" | "failed" };

function stopTracks(stream: MediaStream | null) {
  stream?.getTracks().forEach(track => track.stop());
}

function makePhoto(video: HTMLVideoElement, frame: ReceiptFrame | null): Promise<File> {
  const width = video.videoWidth;
  const height = video.videoHeight;
  const margin = 0.025;
  const left = frame ? Math.max(0, frame.left - margin) : 0;
  const top = frame ? Math.max(0, frame.top - margin) : 0;
  const right = frame ? Math.min(1, frame.right + margin) : 1;
  const bottom = frame ? Math.min(1, frame.bottom + margin) : 1;
  const cropWidth = (right - left) * width;
  const cropHeight = (bottom - top) * height;
  const scale = Math.min(1, 2400 / Math.max(cropWidth, cropHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(cropWidth * scale);
  canvas.height = Math.round(cropHeight * scale);
  const context = canvas.getContext("2d");
  if (!context || !canvas.width || !canvas.height) return Promise.reject(Error("Camera preview is not ready."));
  context.drawImage(video, left * width, top * height, cropWidth, cropHeight, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (!blob) return reject(Error("Could not capture the photo."));
      const id = crypto.randomUUID();
      resolve(new File([blob], `receipt-${id}.jpg`, { type: "image/jpeg" }));
    }, "image/jpeg", 0.92);
  });
}

export function ReceiptCameraScanner({ onCapture, autoSubmit = false }: Props) {
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const captureGeneration = useRef(0);
  const busy = useRef(false);
  const mounted = useRef(false);
  const gate = useRef(createReceiptCaptureGate());
  const submit = useRef(onCapture);
  const activeUploads = useRef(new Set<File>());
  const [camera, setCamera] = useState<"closed" | "opening" | "open">("closed");
  const [frame, setFrame] = useState<ReceiptFrame | null>(null);
  const [hint, setHint] = useState("");
  const [error, setError] = useState("");
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [preview, setPreview] = useState<{ file: File; url: string } | null>(null);
  const [savingPreview, setSavingPreview] = useState(false);

  useEffect(() => { submit.current = onCapture; }, [onCapture]);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview.url); }, [preview]);

  const close = useCallback(() => {
    captureGeneration.current++;
    busy.current = false;
    stopTracks(stream.current);
    stream.current = null;
    if (video.current) video.current.srcObject = null;
    setCamera("closed");
    setFrame(null);
    setHint("");
  }, []);

  useEffect(() => {
    mounted.current = true;
    const onHidden = () => { if (document.hidden) close(); };
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      mounted.current = false;
      captureGeneration.current++;
      stopTracks(stream.current);
      document.removeEventListener("visibilitychange", onHidden);
    };
  }, [close]);

  async function start() {
    if (!navigator.mediaDevices?.getUserMedia) {
      setError("Camera unavailable here. Open this page over HTTPS or use the photo upload.");
      return;
    }
    setError("");
    setHint("Position one receipt on a contrasting background.");
    setCamera("opening");
    const generation = ++captureGeneration.current;
    gate.current = createReceiptCaptureGate();
    try {
      const next = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1920 } },
      });
      if (generation !== captureGeneration.current) {
        stopTracks(next);
        return;
      }
      stream.current = next;
      const element = video.current;
      if (!element) throw Error("Camera preview unavailable.");
      element.srcObject = next;
      await element.play();
      if (generation === captureGeneration.current) setCamera("open");
    } catch {
      if (generation === captureGeneration.current) {
        close();
        setError("Could not open the camera. Check permission or use the photo upload.");
      }
    }
  }

  const send = useCallback(async (file: File) => {
    if (activeUploads.current.has(file) || activeUploads.current.size >= 2) return;
    activeUploads.current.add(file);
    setUploads(items => [{ file, state: "sending" }, ...items.filter(item => item.file !== file)]);
    let state: Upload["state"] = "saved";
    try {
      await submit.current(file);
    } catch {
      state = "failed";
    } finally {
      activeUploads.current.delete(file);
      if (mounted.current) setUploads(items =>
        items.map(item => item.file === file ? { file, state } : item)
          .filter((item, index) => item.state !== "saved" || index < 3));
    }
  }, []);

  const capture = useCallback(async (bounds: ReceiptFrame | null) => {
    const element = video.current;
    if (!element?.videoWidth || busy.current || activeUploads.current.size >= 2) return;
    const generation = captureGeneration.current;
    busy.current = true;
    try {
      const file = await makePhoto(element, bounds);
      if (generation !== captureGeneration.current) return;
      gate.current.captured();
      setHint("Scanned. Move the receipt out of view.");
      if (autoSubmit) {
        void send(file);
      } else {
        setPreview({ file, url: URL.createObjectURL(file) });
        close();
      }
    } catch {
      if (generation === captureGeneration.current) setError("Could not capture the photo. Try the shutter again.");
    } finally {
      if (generation === captureGeneration.current) busy.current = false;
    }
  }, [autoSubmit, close, send]);

  useEffect(() => {
    if (camera !== "open") return;
    const sample = document.createElement("canvas");
    const context = sample.getContext("2d", { willReadFrequently: true });
    if (!context) return;
    let previous: Uint8Array | null = null;
    const timer = window.setInterval(() => {
      const element = video.current;
      if (!element?.videoWidth || element.readyState < 2 || busy.current) return;
      const ratio = 144 / Math.max(element.videoWidth, element.videoHeight);
      const width = Math.max(1, Math.round(element.videoWidth * ratio));
      const height = Math.max(1, Math.round(element.videoHeight * ratio));
      if (sample.width !== width || sample.height !== height) {
        sample.width = width;
        sample.height = height;
        previous = null;
      }
      context.drawImage(element, 0, 0, width, height);
      const rgba = context.getImageData(0, 0, width, height).data;
      const pixels = new Uint8Array(width * height);
      let delta = 0;
      for (let i = 0; i < pixels.length; i++) {
        const rgb = i * 4;
        pixels[i] = (rgba[rgb] * 3 + rgba[rgb + 1] * 6 + rgba[rgb + 2]) / 10;
        if (previous) delta += Math.abs(pixels[i] - previous[i]);
      }
      const bounds = findReceiptFrame({ width, height, pixels });
      const decision = gate.current.observe(bounds, previous ? delta / pixels.length : Infinity);
      previous = pixels;
      setFrame(bounds);
      setHint(decision.waitingForRemoval ? "Scanned. Move the receipt out of view." :
        activeUploads.current.size >= 2 ? "Saving recent scans…" :
          bounds ? "Receipt detected. Hold steady." : "Position one receipt on a contrasting background.");
      if (decision.ready) void capture(bounds);
    }, 130);
    return () => window.clearInterval(timer);
  }, [camera, capture]);

  async function savePreview() {
    if (!preview || savingPreview) return;
    setSavingPreview(true);
    setError("");
    try {
      await submit.current(preview.file);
      setPreview(null);
      setHint("Scan saved.");
    } catch {
      setError("Could not save this scan. Try again.");
    } finally {
      setSavingPreview(false);
    }
  }

  return <section className="qs-receipt-scanner" aria-label="Receipt scanner">
    {camera === "closed" && !preview && <Button variant="solid" type="button" onClick={() => void start()}>{autoSubmit ? "Start auto scan" : "Scan with camera"}</Button>}
    {camera !== "closed" && <>
      {autoSubmit && <p>Auto-saves each steady scan. Move the receipt away before scanning the next one.</p>}
      <div className="qs-scanner-frame" data-captured={hint.startsWith("Scanned.")}>
        <video ref={video} autoPlay playsInline muted aria-label="Live receipt preview" />
        {frame && <div className="qs-scanner-outline" aria-hidden="true" style={{
          left: `${frame.left * 100}%`, top: `${frame.top * 100}%`,
          width: `${(frame.right - frame.left) * 100}%`, height: `${(frame.bottom - frame.top) * 100}%`,
        }} />}
      </div>
      <div className="qs-scanner-controls">
        <Button variant="outline" type="button" disabled={camera !== "open" || activeUploads.current.size >= 2} onClick={() => void capture(frame)}>Capture photo</Button>
        <Button variant="outline" type="button" onClick={close}>Stop camera</Button>
      </div>
    </>}
    {preview && <>
      {/* Local object URL generated from the camera frame. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="qs-scanner-photo" src={preview.url} alt="Captured receipt preview" />
      <div className="qs-scanner-controls">
        <Button variant="solid" type="button" disabled={savingPreview} onClick={() => void savePreview()}>{savingPreview ? "Saving…" : "Use scan"}</Button>
        <Button variant="outline" type="button" disabled={savingPreview} onClick={() => { setPreview(null); void start(); }}>Retake</Button>
        <Button variant="outline" type="button" disabled={savingPreview} onClick={() => { setPreview(null); setHint(""); setError(""); }}>Discard</Button>
      </div>
    </>}
    <p role="status">{camera === "opening" ? "Opening camera…" : preview ? "Receipt captured. Check that the full receipt is visible." : hint}</p>
    {error && <p role="alert">{error}</p>}
    {uploads.length > 0 && <ul aria-label="Recent scans">
      {uploads.map(({ file, state }, index) => <li key={file.name}>
        {state === "sending" ? "Saving scan…" : state === "saved" ? "Scan saved." : "Scan could not be saved."}
        {state === "failed" && <> <Button variant="outline" type="button" aria-label={`Retry scan ${index + 1}`} disabled={activeUploads.current.size >= 2} onClick={() => void send(file)}>Retry</Button>{" "}
          <Button variant="outline" type="button" aria-label={`Discard scan ${index + 1}`} onClick={() => setUploads(items => items.filter(item => item.file !== file))}>Discard</Button></>}
      </li>)}
    </ul>}
  </section>;
}
