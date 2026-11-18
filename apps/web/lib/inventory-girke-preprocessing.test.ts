import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import {
  createInventoryGirkePreprocessingAdapter,
  resolveInventoryGirkeBaseUrl,
} from "./inventory-girke-preprocessing";
import {
  InventoryPreprocessingStepError,
  InventoryPreprocessingSystemError,
} from "../../api/src/inventory-preprocessing-service";

let server: Bun.Server<unknown> | null = null;
const tempDirs: string[] = [];

afterEach(async () => {
  server?.stop(true);
  server = null;

  while (tempDirs.length > 0) {
    const directory = tempDirs.pop();

    if (directory) {
      await rm(directory, { force: true, recursive: true });
    }
  }
});

describe("inventory Girke preprocessing adapter", () => {
  test("uses bearer auth, overrideable base URL, and Girke OCR/transcription endpoints", async () => {
    const requests: Array<{ authorization: string | null; pathname: string }> = [];
    server = Bun.serve({
      fetch: async (request) => {
        const url = new URL(request.url);
        requests.push({
          authorization: request.headers.get("authorization"),
          pathname: url.pathname,
        });

        if (url.pathname === "/api/v1/ocr" && request.method === "GET") {
          return Response.json({
            accepted_image_formats: ["jpg", "jpeg", "png", "webp", "tif", "tiff", "bmp"],
            max_upload_bytes: 26214400,
            model: "tesseract-latin-psm11-gray",
            timeout_seconds: 20,
          });
        }

        if (url.pathname === "/api/v1/ocr" && request.method === "POST") {
          const form = await request.formData();
          const file = form.get("file");

          expect(file).toBeInstanceOf(File);
          expect((file as File).name).toBe("travel-pouch.jpg");

          return Response.json({
            lines: ["LOT 1234", "Best before 2027"],
            model: "tesseract-latin-psm11-gray",
            processing_seconds: 2.6,
            text: "LOT 1234\nBest before 2027",
          });
        }

        if (url.pathname === "/api/v1/transcription" && request.method === "GET") {
          return Response.json({
            accepted_media: {
              audio: ["wav", "mp3", "m4a", "aac", "ogg", "opus", "flac", "webm"],
              video: ["mp4", "mov", "mkv", "webm", "avi"],
            },
            default_level: "medium",
            language_optional: true,
            languages: [
              { code: "en", name: "English" },
              { code: "de", name: "German" },
            ],
            levels: ["low", "medium", "high"],
          });
        }

        if (
          url.pathname === "/api/v1/transcription/transcribe" &&
          request.method === "POST"
        ) {
          const form = await request.formData();

          expect(form.get("level")).toBe("high");
          expect(form.get("language")).toBe("en");
          expect(form.get("file")).toBeInstanceOf(File);

          return Response.json({
            detected_language: "en",
            duration_seconds: 5.2,
            language: "en",
            level: "high",
            model: "distil-small.en",
            processing_seconds: 0.8,
            segments: [{ end: 5.2, start: 0, text: "passport in front pocket" }],
            text: "passport in front pocket",
          });
        }

        if (url.pathname === "/api/v1/transcription/jobs" && request.method === "POST") {
          return Response.json(
            {
              created_at: "2026-07-11T00:00:00.000Z",
              detected_language: null,
              job_id: "tr_async_1",
              language: "auto",
              level: "medium",
              result_url: "/api/v1/transcription/jobs/tr_async_1/result",
              status: "queued",
              status_url: "/api/v1/transcription/jobs/tr_async_1",
            },
            { status: 202 },
          );
        }

        if (
          url.pathname === "/api/v1/transcription/jobs/tr_async_1" &&
          request.method === "GET"
        ) {
          return Response.json({
            created_at: "2026-07-11T00:00:00.000Z",
            detected_language: "en",
            job_id: "tr_async_1",
            language: "auto",
            level: "medium",
            progress: 1,
            status: "completed",
            updated_at: "2026-07-11T00:05:00.000Z",
          });
        }

        if (
          url.pathname === "/api/v1/transcription/jobs/tr_async_1/result" &&
          request.method === "GET"
        ) {
          return Response.json({
            detected_language: "en",
            duration_seconds: 302.4,
            job_id: "tr_async_1",
            language: "auto",
            level: "medium",
            model: "large-v3-turbo",
            processing_seconds: 30.2,
            segments: [
              {
                chunk_index: 0,
                end: 8.1,
                start: 0,
                text: "garage bin has extension cords and bike lights",
              },
            ],
            status: "completed",
            text: "garage bin has extension cords and bike lights",
          });
        }

        return new Response("Not found", { status: 404 });
      },
      port: 0,
    });

    const directory = await mkdtemp(join(tmpdir(), "girke-preprocessing-"));
    tempDirs.push(directory);
    const imagePath = join(directory, "travel-pouch.jpg");
    const audioPath = join(directory, "travel-note.m4a");
    await sharp({
      create: {
        background: { b: 0, g: 0, r: 0 },
        channels: 3,
        height: 64,
        width: 64,
      },
    })
      .jpeg()
      .toFile(imagePath);
    await writeFile(audioPath, "fake audio bytes");

    const adapter = createInventoryGirkePreprocessingAdapter({
      apiToken: "girke-test-token",
      baseUrl: `http://127.0.0.1:${server.port}`,
    });

    await expect(adapter.getOcrMetadata()).resolves.toEqual({
      acceptedImageFormats: ["jpg", "jpeg", "png", "webp", "tif", "tiff", "bmp"],
      maxUploadBytes: 26214400,
      model: "tesseract-latin-psm11-gray",
      timeoutSeconds: 20,
    });
    await expect(
      adapter.recognizeOcr({
        filePath: imagePath,
        mediaId: "image-1",
        mimeType: "image/jpeg",
        originalName: "travel-pouch.jpg",
        sizeBytes: 1024,
      }),
    ).resolves.toEqual({
      lines: ["LOT 1234", "Best before 2027"],
      model: "tesseract-latin-psm11-gray",
      processingSeconds: 2.6,
      text: "LOT 1234\nBest before 2027",
    });
    await expect(adapter.getTranscriptionMetadata()).resolves.toEqual({
      acceptedAudioFormats: ["wav", "mp3", "m4a", "aac", "ogg", "opus", "flac", "webm"],
      acceptedVideoFormats: ["mp4", "mov", "mkv", "webm", "avi"],
      defaultLevel: "medium",
      languageOptional: true,
      languages: ["en", "de"],
      levels: ["low", "medium", "high"],
    });
    await expect(
      adapter.transcribeSynchronously({
        filePath: audioPath,
        language: "en",
        level: "high",
        mediaId: "audio-1",
        mimeType: "audio/mp4",
        originalName: "travel-note.m4a",
        sizeBytes: 2048,
      }),
    ).resolves.toEqual({
      detectedLanguage: "en",
      durationSeconds: 5.2,
      language: "en",
      level: "high",
      model: "distil-small.en",
      processingSeconds: 0.8,
      segments: [{ end: 5.2, start: 0, text: "passport in front pocket" }],
      text: "passport in front pocket",
    });
    await expect(
      adapter.createTranscriptionJob({
        filePath: audioPath,
        mediaId: "audio-1",
        mimeType: "audio/mp4",
        originalName: "travel-note.m4a",
        sizeBytes: 2048,
      }),
    ).resolves.toEqual({
      createdAt: "2026-07-11T00:00:00.000Z",
      detectedLanguage: null,
      jobId: "tr_async_1",
      language: "auto",
      level: "medium",
      status: "queued",
    });
    await expect(adapter.getTranscriptionJob("tr_async_1")).resolves.toEqual({
      jobId: "tr_async_1",
      status: "completed",
    });
    await expect(adapter.getTranscriptionJobResult("tr_async_1")).resolves.toEqual({
      detectedLanguage: "en",
      durationSeconds: 302.4,
      jobId: "tr_async_1",
      language: "auto",
      level: "medium",
      model: "large-v3-turbo",
      processingSeconds: 30.2,
      segments: [
        {
          chunkIndex: 0,
          end: 8.1,
          start: 0,
          text: "garage bin has extension cords and bike lights",
        },
      ],
      status: "completed",
      text: "garage bin has extension cords and bike lights",
    });

    expect(requests.map((request) => request.pathname)).toEqual([
      "/api/v1/ocr",
      "/api/v1/ocr",
      "/api/v1/transcription",
      "/api/v1/transcription/transcribe",
      "/api/v1/transcription/jobs",
      "/api/v1/transcription/jobs/tr_async_1",
      "/api/v1/transcription/jobs/tr_async_1/result",
    ]);
    expect(
      requests.every(
        (request) => request.authorization === "Bearer girke-test-token",
      ),
    ).toBe(true);
    expect(() => resolveInventoryGirkeBaseUrl(undefined)).toThrow(
      "Girke API base URL is not configured.",
    );
  });

  test("fails clearly when Girke credentials are missing", async () => {
    expect(() =>
      createInventoryGirkePreprocessingAdapter({
        apiToken: "",
        baseUrl: "http://127.0.0.1:1",
      }),
    ).toThrowError(InventoryPreprocessingSystemError);
  });

  test("treats Girke authorization failures as retryable after credentials recover", async () => {
    server = Bun.serve({
      fetch: () => Response.json({ error: "unauthorized" }, { status: 401 }),
      port: 0,
    });

    const adapter = createInventoryGirkePreprocessingAdapter({
      apiToken: "expired-token",
      baseUrl: `http://127.0.0.1:${server.port}`,
    });

    await expect(adapter.getOcrMetadata()).rejects.toMatchObject({
      code: "unauthorized",
      message: "unauthorized",
      retryable: true,
    } satisfies Partial<InventoryPreprocessingStepError>);
  });

  test("bounds OCR image dimensions before sending them to Girke", async () => {
    let receivedDimensions: { height?: number; width?: number } | null = null;
    server = Bun.serve({
      fetch: async (request) => {
        const form = await request.formData();
        const file = form.get("file");

        expect(file).toBeInstanceOf(File);
        receivedDimensions = await sharp(
          Buffer.from(await (file as File).arrayBuffer()),
        ).metadata();

        return Response.json({
          lines: ["bounded"],
          model: "tesseract-latin-psm11-gray",
          processing_seconds: 1,
          text: "bounded",
        });
      },
      port: 0,
    });

    const directory = await mkdtemp(join(tmpdir(), "girke-preprocessing-"));
    tempDirs.push(directory);
    const imagePath = join(directory, "large-label.png");
    await sharp({
      create: {
        background: { alpha: 0, b: 0, g: 0, r: 0 },
        channels: 4,
        height: 3024,
        width: 4032,
      },
    })
      .png()
      .toFile(imagePath);

    const adapter = createInventoryGirkePreprocessingAdapter({
      apiToken: "girke-test-token",
      baseUrl: `http://127.0.0.1:${server.port}`,
    });

    await adapter.recognizeOcr({
      filePath: imagePath,
      mediaId: "image-large",
      mimeType: "image/png",
      originalName: "large-label.png",
      sizeBytes: null,
    });

    expect(receivedDimensions).toMatchObject({ height: 750, width: 1000 });
  });

  test("maps sync Girke transcription HTTP failures to stable preprocessing step errors", async () => {
    server = Bun.serve({
      fetch: async (request) => {
        if (new URL(request.url).pathname === "/api/v1/transcription/transcribe") {
          return Response.json(
            {
              error: "sync_media_too_long",
              jobs_url: "/api/v1/transcription/jobs",
              max_duration_seconds: 300,
            },
            { status: 422 },
          );
        }

        return new Response("Not found", { status: 404 });
      },
      port: 0,
    });

    const directory = await mkdtemp(join(tmpdir(), "girke-preprocessing-"));
    tempDirs.push(directory);
    const audioPath = join(directory, "travel-note.m4a");
    await writeFile(audioPath, "fake audio bytes");

    const adapter = createInventoryGirkePreprocessingAdapter({
      apiToken: "girke-test-token",
      baseUrl: `http://127.0.0.1:${server.port}`,
    });

    await expect(
      adapter.transcribeSynchronously({
        filePath: audioPath,
        mediaId: "audio-1",
        mimeType: "audio/mp4",
        originalName: "travel-note.m4a",
        sizeBytes: 2048,
      }),
    ).rejects.toMatchObject({
      code: "sync_media_too_long",
      message: "sync_media_too_long",
      retryable: false,
    } satisfies Partial<InventoryPreprocessingStepError>);
  });
});
