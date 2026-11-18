import sharp from "sharp";

export class PrivateOcrBusyError extends Error {
  constructor() {
    super("Private OCR compute is busy.");
  }
}

/** Dedicated private-document adapter. Never invokes Inventory enrichment or a hosted model. */
export async function recognizePrivateDocument(image: Uint8Array, request: (url: URL, options: RequestInit) => Promise<Response> = fetch) {
  const base = process.env.GIRKE_API_BASE_URL;
  const token = process.env.GIRKE_API_TOKEN;
  if (!base || !token) throw Error("Private OCR is not configured.");
  const url = new URL("api/v1/ocr", base.replace(/\/+$/, "") + "/");
  if (url.protocol !== "https:") throw Error("Private OCR requires HTTPS.");
  // Preserve small print; unlike Inventory, do not reduce images to 1,000px.
  const bytes = await sharp(image, { limitInputPixels: 40_000_000 }).rotate().png().toBuffer();
  if (bytes.length > 25 * 1024 * 1024) throw Error("OCR image exceeds processing limit.");
  const form = new FormData();
  form.set("file", new File([new Uint8Array(bytes)], "document.png", { type: "image/png" }));
  const response = await request(url, {
    method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form,
    redirect: "error", signal: AbortSignal.timeout(30_000),
  });
  // Never include service response bodies (possibly document text) in errors/logs.
  if (response.status === 503) {
    const problem = await response.json().catch(() => null);
    if (problem && typeof problem === "object" && "error" in problem && problem.error === "compute_busy")
      throw new PrivateOcrBusyError();
  }
  if (!response.ok) throw Error("Private OCR failed.");
  const result = await response.json() as { text?: unknown };
  if (typeof result.text !== "string" || !result.text.trim() || result.text.length > 500_000)
    throw Error("Private OCR returned no usable text.");
  return result.text;
}
