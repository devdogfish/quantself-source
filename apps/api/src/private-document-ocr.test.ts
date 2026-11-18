import { expect, test } from "bun:test";
import sharp from "sharp";
import { PrivateOcrBusyError, recognizePrivateDocument } from "./private-document-ocr";

test("private OCR preserves resolution, forbids redirects and suppresses service error bodies", async () => {
  const previous = [process.env.GIRKE_API_BASE_URL, process.env.GIRKE_API_TOKEN];
  process.env.GIRKE_API_BASE_URL = "https://ocr.example.test";
  process.env.GIRKE_API_TOKEN = "test-only";
  try {
    const image = await sharp({ create: { width: 1800, height: 20, channels: 3, background: "white" } }).png().toBuffer();
    const request = (async (url: URL, options: RequestInit) => {
      expect(String(url)).toBe("https://ocr.example.test/api/v1/ocr");
      expect(options.redirect).toBe("error");
      const file = (options.body as FormData).get("file") as File;
      expect((await sharp(await file.arrayBuffer()).metadata()).width).toBe(1800);
      return Response.json({ text: "Test total 12.34" });
    });
    expect(await recognizePrivateDocument(image, request)).toBe("Test total 12.34");
    await expect(recognizePrivateDocument(image, async () => new Response("SECRET DOCUMENT", { status: 500 }))).rejects.toThrow("Private OCR failed.");
    await expect(recognizePrivateDocument(image, async () =>
      Response.json({ error: "compute_busy", details: "SECRET DOCUMENT" }, { status: 503 }),
    )).rejects.toBeInstanceOf(PrivateOcrBusyError);
    for (const response of [
      Response.json({ error: "service_unavailable" }, { status: 503 }),
      Response.json({ error: "compute_busy" }, { status: 500 }),
      new Response("SECRET DOCUMENT", { status: 503 }),
    ]) {
      await expect(recognizePrivateDocument(image, async () => response)).rejects.toThrow("Private OCR failed.");
    }
    process.env.GIRKE_API_BASE_URL = "http://ocr.example.test";
    await expect(recognizePrivateDocument(image, request)).rejects.toThrow("requires HTTPS");
  } finally {
    for (const [key, value] of [["GIRKE_API_BASE_URL", previous[0]], ["GIRKE_API_TOKEN", previous[1]]]) {
      if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
    }
  }
});
