import {
  access,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import sharp from "sharp";
import { createApp } from "./app";
import { InventoryImageNormalizationError } from "./inventory-image-normalization";
import { storeInventoryItemMediaFiles } from "./inventory-item-media-route";

describe("Inventory Item media routes", () => {
  it("mints a short-lived primary image URL for GPT rendering", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "item-media-gpt-preview-"));
    const filePath = path.join(root, "source.png");
    const source = await sharp({
      create: { background: "#335577", channels: 3, height: 1800, width: 1200 },
    })
      .png()
      .toBuffer();
    await writeFile(filePath, source);

    try {
      const app = createApp({
        emitAccessLog: () => {},
        inventoryItemMedia: {
          deleteMedia: async () => null,
          getMediaFile: async (itemId, mediaId) =>
            itemId === "item-1" && mediaId === "image-1"
              ? {
                  filePath,
                  kind: "image",
                  mimeType: "image/png",
                  originalName: "source.png",
                }
              : null,
          listMedia: async () => [
            {
              contentType: "image/png",
              id: "image-1",
              kind: "image",
              originalName: "source.png",
              position: 0,
              sizeBytes: source.byteLength,
            },
          ],
          reorderImages: async () => null,
          uploadMedia: async () => [],
        },
        resolveAccessContext: readAccessContext,
        unsafeSkipContractValidationForTests: true,
      });

      const mint = await app.request(
        "http://localhost/api/v1/inventory-items/item-1/primary-image",
      );
      expect(mint.status).toBe(200);
      const { imageUrl } = (await mint.json()) as { imageUrl: string };
      const preview = await app.request(new URL(imageUrl).pathname);

      expect(preview.status).toBe(200);
      expect(preview.headers.get("Content-Type")).toBe("image/webp");
      expect(await sharp(Buffer.from(await preview.arrayBuffer())).metadata()).toMatchObject({
        height: 640,
        width: 427,
      });
      expect((await app.request("/api/v1/inventory-item-media-preview/invalid")).status).toBe(404);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("delivers a persistent, privately cached preview representation with ETag revalidation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "item-media-preview-"));
    const filePath = path.join(root, "source.png");
    const previewPath = `${filePath}.preview.webp`;
    const source = await sharp({
      create: { background: "#335577", channels: 3, height: 1800, width: 1200 },
    })
      .png()
      .toBuffer();
    await writeFile(filePath, source);

    try {
      const app = createApp({
        emitAccessLog: () => {},
        inventoryItemMedia: {
          deleteMedia: async () => null,
          getMediaFile: async () => ({
            filePath,
            kind: "image",
            mimeType: "image/png",
            originalName: "source.png",
          }),
          listMedia: async () => [],
          reorderImages: async () => null,
          uploadMedia: async () => [],
        },
        resolveAccessContext: readAccessContext,
        unsafeSkipContractValidationForTests: true,
      });

      const first = await app.request(
        "/api/v1/inventory-items/item-1/media/image-1?representation=preview",
      );
      expect(first.status).toBe(200);
      const preview = Buffer.from(await first.arrayBuffer());
      const metadata = await sharp(preview).metadata();
      const etag = first.headers.get("ETag");

      expect(first.headers.get("Cache-Control")).toBe(
        "private, max-age=604800",
      );
      expect(first.headers.get("Content-Type")).toBe("image/webp");
      expect(etag).toBeTruthy();
      expect(metadata.width).toBeLessThanOrEqual(640);
      expect(metadata.height).toBeLessThanOrEqual(640);
      expect(preview.byteLength).toBeLessThan(source.byteLength);
      expect(await readdir(root)).toContain("source.png.preview.webp");

      const original = await app.request(
        "/api/v1/inventory-items/item-1/media/image-1",
      );
      const originalMetadata = await sharp(
        Buffer.from(await original.arrayBuffer()),
      ).metadata();

      expect(original.headers.get("Content-Type")).toBe("image/png");
      expect(originalMetadata).toMatchObject({ height: 1800, width: 1200 });

      const persistedAt = new Date(Date.now() + 60_000);
      await utimes(previewPath, persistedAt, persistedAt);

      const revalidated = await app.request(
        "/api/v1/inventory-items/item-1/media/image-1?representation=preview",
        { headers: { "If-None-Match": etag ?? "" } },
      );

      expect(revalidated.status).toBe(304);
      expect(revalidated.headers.get("ETag")).toBe(etag);
      expect((await stat(previewPath)).mtimeMs).toBe(persistedAt.getTime());
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("invalidates persisted previews and removes them when their source disappears", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "item-media-preview-"));
    const filePath = path.join(root, "source.png");
    const previewPath = `${filePath}.preview.webp`;
    const firstSource = await sharp({
      create: { background: "#335577", channels: 3, height: 900, width: 1200 },
    })
      .png()
      .toBuffer();
    await writeFile(filePath, firstSource);

    try {
      const app = createApp({
        emitAccessLog: () => {},
        inventoryItemMedia: {
          deleteMedia: async () => null,
          getMediaFile: async () => ({
            filePath,
            kind: "image",
            mimeType: "image/png",
            originalName: "source.png",
          }),
          listMedia: async () => [],
          reorderImages: async () => null,
          uploadMedia: async () => [],
        },
        resolveAccessContext: readAccessContext,
        unsafeSkipContractValidationForTests: true,
      });
      const contentPath =
        "/api/v1/inventory-items/item-1/media/image-1?representation=preview";
      const first = await app.request(contentPath);
      const firstEtag = first.headers.get("ETag");
      const secondSource = await sharp({
        create: { background: "#773355", channels: 3, height: 1200, width: 600 },
      })
        .png()
        .toBuffer();
      await utimes(previewPath, new Date(0), new Date(0));
      await writeFile(filePath, secondSource);

      const changed = await app.request(contentPath, {
        headers: { "If-None-Match": firstEtag ?? "" },
      });
      const changedMetadata = await sharp(
        Buffer.from(await changed.arrayBuffer()),
      ).metadata();

      expect(changed.status).toBe(200);
      expect(changed.headers.get("ETag")).not.toBe(firstEtag);
      expect(changedMetadata).toMatchObject({ height: 640, width: 320 });

      await unlink(filePath);
      const missing = await app.request(contentPath);

      expect(missing.status).toBe(404);
      await expect(access(previewPath)).rejects.toThrow();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("serves authorized media bytes through the parent item route", async () => {
    const app = createApp({
      emitAccessLog: () => {},
      inventoryItemMedia: {
        deleteMedia: async () => ({
          deletedMediaId: "unused",
        }),
        getMediaFile: async () => null,
        listMedia: async () => [],
        reorderImages: async () => ({
          imageIds: ["image-1"],
          itemId: "unused",
        }),
        uploadMedia: async () => [],
      },
      resolveAccessContext: async () => ({
        owner: {
          email: "owner@example.com",
          id: "owner-1",
          name: "Owner",
        },
        client: {
          id: "read-client",
          kind: "api-key",
          name: "Read client",
        },
        permissions: ["inventory:read"],
      }),
      unsafeSkipContractValidationForTests: true,
    });

    const response = await app.request(
      "/api/v1/inventory-items/item-1/media/image-1",
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      code: "NOT_FOUND",
      message: "Inventory Item Media not found.",
    });
  });

  it("preserves content headers and byte ranges for authorized media", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "item-media-route-"));
    const filePath = path.join(root, "note.webm");
    await writeFile(filePath, "abcdef");

    try {
      const app = createApp({
        emitAccessLog: () => {},
        inventoryItemMedia: {
          deleteMedia: async () => null,
          getMediaFile: async (itemId, mediaId) =>
            itemId === "item-1" && mediaId === "audio-1"
              ? {
                  filePath,
                  kind: "audio",
                  mimeType: "audio/webm",
                  originalName: "voice note.webm",
                }
              : null,
          listMedia: async () => [],
          reorderImages: async () => null,
          uploadMedia: async () => [],
        },
        resolveAccessContext: readAccessContext,
        unsafeSkipContractValidationForTests: true,
      });

      const response = await app.request(
        "/api/v1/inventory-items/item-1/media/audio-1",
        { headers: { Range: "bytes=1-3" } },
      );

      expect(response.status).toBe(206);
      expect(response.headers.get("Accept-Ranges")).toBe("bytes");
      expect(response.headers.get("Cache-Control")).toBe(
        "private, max-age=3600",
      );
      expect(response.headers.get("Content-Range")).toBe("bytes 1-3/6");
      expect(response.headers.get("Content-Type")).toBe("audio/webm");
      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(response.headers.get("Content-Disposition")).toBe(
        'inline; filename="voice_note.webm"',
      );
      expect(await response.text()).toBe("bcd");

      const invalidRange = await app.request(
        "/api/v1/inventory-items/item-1/media/audio-1",
        { headers: { Range: "bytes=99-100" } },
      );

      expect(invalidRange.status).toBe(416);
      expect(invalidRange.headers.get("Content-Range")).toBe("bytes */6");
      expect(invalidRange.headers.get("Content-Type")).toContain(
        "application/json",
      );
      expect(await invalidRange.json()).toEqual({
        code: "RANGE_NOT_SATISFIABLE",
        message: "Requested byte range is not satisfiable.",
      });

      const unsupportedPreview = await app.request(
        "/api/v1/inventory-items/item-1/media/audio-1?representation=preview",
      );
      expect(unsupportedPreview.status).toBe(404);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("lists authorized item media metadata through the API seam", async () => {
    const app = createApp({
      emitAccessLog: () => {},
      inventoryItemMedia: {
        deleteMedia: async () => ({
          deletedMediaId: "unused",
        }),
        getMediaFile: async () => null,
        listMedia: async () => [
          {
            contentType: "image/jpeg",
            id: "image-1",
            kind: "image",
            originalName: "front.jpg",
            position: 0,
            sizeBytes: 4,
          },
          {
            contentType: "audio/webm",
            id: "audio-1",
            kind: "audio",
            originalName: "note.webm",
            position: null,
            sizeBytes: 8,
          },
        ],
        reorderImages: async () => ({
          imageIds: ["image-1"],
          itemId: "unused",
        }),
        uploadMedia: async () => [],
      },
      resolveAccessContext: async () => ({
        owner: {
          email: "owner@example.com",
          id: "owner-1",
          name: "Owner",
        },
        client: {
          id: "read-client",
          kind: "api-key",
          name: "Read client",
        },
        permissions: ["inventory:read"],
      }),
      unsafeSkipContractValidationForTests: true,
    });

    const response = await app.request("/api/v1/inventory-items/item-1/media");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      media: [
        {
          contentType: "image/jpeg",
          id: "image-1",
          kind: "image",
          originalName: "front.jpg",
          position: 0,
          sizeBytes: 4,
        },
        {
          contentType: "audio/webm",
          id: "audio-1",
          kind: "audio",
          originalName: "note.webm",
          position: null,
          sizeBytes: 8,
        },
      ],
    });
  });

  it("returns not found when the parent item does not exist", async () => {
    const app = createApp({
      emitAccessLog: () => {},
      inventoryItemMedia: {
        deleteMedia: async () => null,
        getMediaFile: async () => null,
        listMedia: async () => null,
        reorderImages: async () => null,
        uploadMedia: async () => null,
      },
      resolveAccessContext: readAccessContext,
      unsafeSkipContractValidationForTests: true,
    });

    const response = await app.request(
      "/api/v1/inventory-items/missing/media",
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      code: "NOT_FOUND",
      message: "Inventory Item Media not found.",
    });
  });

  it("accepts direct multipart upload for item media", async () => {
    const uploadedFiles: File[] = [];
    const app = createApp({
      emitAccessLog: () => {},
      inventoryItemMedia: {
        deleteMedia: async () => ({
          deletedMediaId: "unused",
        }),
        getMediaFile: async () => null,
        listMedia: async () => [],
        reorderImages: async () => ({
          imageIds: ["image-1"],
          itemId: "unused",
        }),
        uploadMedia: async (_itemId, files) => {
          uploadedFiles.push(...files);
          return [
            {
              contentType: "image/jpeg",
              id: "image-1",
              kind: "image",
              originalName: files[0]?.name ?? null,
              position: 0,
              sizeBytes: files[0]?.size ?? null,
            },
          ];
        },
      },
      resolveAccessContext: async () => ({
        owner: {
          email: "owner@example.com",
          id: "owner-1",
          name: "Owner",
        },
        client: {
          id: "write-client",
          kind: "api-key",
          name: "Write client",
        },
        permissions: ["inventory:write"],
      }),
      unsafeSkipContractValidationForTests: true,
    });
    const formData = new FormData();

    formData.append(
      "files",
      new File(["front"], "front.jpg", { type: "image/jpeg" }),
    );

    const response = await app.request("/api/v1/inventory-items/item-1/media", {
      body: formData,
      headers: {
        "Idempotency-Key": "upload-media-1",
      },
      method: "POST",
    });

    expect(response.status).toBe(201);
    expect(uploadedFiles.map((file) => file.name)).toEqual(["front.jpg"]);
    expect(await response.json()).toEqual({
      media: [
        {
          contentType: "image/jpeg",
          id: "image-1",
          kind: "image",
          originalName: "front.jpg",
          position: 0,
          sizeBytes: 5,
        },
      ],
    });
  });

  it("returns a stable validation error when direct upload normalization fails", async () => {
    const app = createApp({
      emitAccessLog: () => {},
      inventoryItemMedia: {
        deleteMedia: async () => null,
        getMediaFile: async () => null,
        listMedia: async () => [],
        reorderImages: async () => null,
        uploadMedia: async () => {
          throw new InventoryImageNormalizationError(
            "Image could not be normalized.",
          );
        },
      },
      resolveAccessContext: writeAccessContext,
      unsafeSkipContractValidationForTests: true,
    });
    const body = new FormData();
    body.append(
      "files",
      new File(["broken"], "broken.png", { type: "image/png" }),
    );

    const response = await app.request(
      "/api/v1/inventory-items/item-1/media",
      {
        body,
        headers: { "Idempotency-Key": "broken-image-upload" },
        method: "POST",
      },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      code: "INVALID_REQUEST",
      message: "Image could not be normalized.",
    });
  });

  it("physically normalizes image orientation at the shared storage boundary", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "item-media-store-"));
    const previousUploadRoot = process.env.INVENTORY_UPLOAD_DIR;
    process.env.INVENTORY_UPLOAD_DIR = path.join(root, "images");

    try {
      const input = await sharp(Buffer.from([1, 2, 3, 4, 5, 6]), {
        raw: { channels: 1, height: 3, width: 2 },
      })
        .png()
        .withXmp(xmpWithOrientation(6))
        .toBuffer();
      const [stored] = await storeInventoryItemMediaFiles([
        new File([input], "oriented.png", { type: "image/png" }),
      ]);

      expect(stored).toBeDefined();
      const output = await readFile(stored!.filePath);
      const normalized = await sharp(output)
        .greyscale()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const metadata = await sharp(output).metadata();

      expect(Array.from(normalized.data)).toEqual([5, 3, 1, 6, 4, 2]);
      expect(normalized.info).toMatchObject({ height: 2, width: 3 });
      expect(metadata.orientation).toBeUndefined();
      expect(metadata.xmp).toBeUndefined();
      expect(stored!.sizeBytes).toBe(output.byteLength);
    } finally {
      restoreEnvironmentVariable("INVENTORY_UPLOAD_DIR", previousUploadRoot);
      await rm(root, { force: true, recursive: true });
    }
  });

  it("cleans previously stored media when image normalization fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "item-media-store-"));
    const previousAssetRoot = process.env.INVENTORY_ASSET_UPLOAD_DIR;
    const previousUploadRoot = process.env.INVENTORY_UPLOAD_DIR;
    const assetRoot = path.join(root, "assets");
    process.env.INVENTORY_ASSET_UPLOAD_DIR = assetRoot;
    process.env.INVENTORY_UPLOAD_DIR = path.join(root, "images");

    try {
      await expect(
        storeInventoryItemMediaFiles([
          new File(["manual"], "manual.txt", { type: "text/plain" }),
          new File(["broken"], "broken.png", { type: "image/png" }),
        ]),
      ).rejects.toThrow("Image could not be normalized.");
      expect(await readdir(assetRoot)).toEqual([]);
    } finally {
      restoreEnvironmentVariable(
        "INVENTORY_ASSET_UPLOAD_DIR",
        previousAssetRoot,
      );
      restoreEnvironmentVariable("INVENTORY_UPLOAD_DIR", previousUploadRoot);
      await rm(root, { force: true, recursive: true });
    }
  });

  it("enforces distinct Inventory Read and Inventory Write permissions", async () => {
    let calls = 0;
    const handlers = {
      deleteMedia: async () => {
        calls += 1;
        return null;
      },
      getMediaFile: async () => {
        calls += 1;
        return null;
      },
      listMedia: async () => {
        calls += 1;
        return [];
      },
      reorderImages: async () => {
        calls += 1;
        return null;
      },
      uploadMedia: async () => {
        calls += 1;
        return [];
      },
    };
    const readApp = createApp({
      emitAccessLog: () => {},
      inventoryItemMedia: handlers,
      resolveAccessContext: readAccessContext,
      unsafeSkipContractValidationForTests: true,
    });
    const writeApp = createApp({
      emitAccessLog: () => {},
      inventoryItemMedia: handlers,
      resolveAccessContext: writeAccessContext,
      unsafeSkipContractValidationForTests: true,
    });
    const formData = new FormData();
    formData.append(
      "files",
      new File(["front"], "front.jpg", { type: "image/jpeg" }),
    );

    const writeWithReadOnly = await readApp.request(
      "/api/v1/inventory-items/item-1/media",
      {
        body: formData,
        headers: { "Idempotency-Key": "forbidden-upload" },
        method: "POST",
      },
    );
    const readWithWriteOnly = await writeApp.request(
      "/api/v1/inventory-items/item-1/media/image-1?representation=preview",
    );

    expect(writeWithReadOnly.status).toBe(403);
    expect(readWithWriteOnly.status).toBe(403);
    expect(calls).toBe(0);
  });

  it("rejects empty and oversized multipart batches before persistence", async () => {
    let uploadCalls = 0;
    const app = createApp({
      emitAccessLog: () => {},
      inventoryItemMedia: {
        deleteMedia: async () => null,
        getMediaFile: async () => null,
        listMedia: async () => [],
        reorderImages: async () => null,
        uploadMedia: async () => {
          uploadCalls += 1;
          return [];
        },
      },
      resolveAccessContext: writeAccessContext,
      unsafeSkipContractValidationForTests: true,
    });
    const empty = new FormData();
    empty.append("note", "missing files");
    const emptyResponse = await app.request(
      "/api/v1/inventory-items/item-1/media",
      {
        body: empty,
        headers: { "Idempotency-Key": "empty-upload" },
        method: "POST",
      },
    );
    const tooMany = new FormData();

    for (let index = 0; index < 21; index += 1) {
      tooMany.append(
        "files",
        new File(["x"], `${index}.txt`, { type: "text/plain" }),
      );
    }

    const tooManyResponse = await app.request(
      "/api/v1/inventory-items/item-1/media",
      {
        body: tooMany,
        headers: { "Idempotency-Key": "large-batch" },
        method: "POST",
      },
    );
    const heic = new FormData();
    heic.append(
      "files",
      new File(["image"], "photo.heic", { type: "image/heic" }),
    );
    const heicResponse = await app.request(
      "/api/v1/inventory-items/item-1/media",
      {
        body: heic,
        headers: { "Idempotency-Key": "heic-upload" },
        method: "POST",
      },
    );
    const tooLargeResponse = await app.request(
      new Request(
        "http://localhost/api/v1/inventory-items/item-1/media",
        {
          body: "x",
          headers: {
            "Content-Length": "105906177",
            "Content-Type": "multipart/form-data; boundary=test",
            "Idempotency-Key": "oversized-transport",
          },
          method: "POST",
        },
      ),
    );

    expect(emptyResponse.status).toBe(400);
    expect(await emptyResponse.json()).toEqual({
      code: "INVALID_REQUEST",
      message: "Choose at least one non-empty Item Media file.",
    });
    expect(tooManyResponse.status).toBe(400);
    expect(await tooManyResponse.json()).toEqual({
      code: "INVALID_REQUEST",
      message: "Upload at most 20 Item Media files at once.",
    });
    expect(heicResponse.status).toBe(400);
    expect(await heicResponse.json()).toEqual({
      code: "INVALID_REQUEST",
      message: "HEIC and HEIF images are not supported.",
    });
    expect(tooLargeResponse.status).toBe(413);
    expect(await tooLargeResponse.json()).toEqual({
      code: "PAYLOAD_TOO_LARGE",
      message: "Item Media requests must be at most 105906176 bytes.",
    });
    expect(uploadCalls).toBe(0);
  });

  it("reorders item images through the API seam", async () => {
    const reorderCalls: Array<{ imageIds: string[]; itemId: string }> = [];
    const app = createApp({
      emitAccessLog: () => {},
      inventoryItemMedia: {
        deleteMedia: async () => ({
          deletedMediaId: "unused",
        }),
        getMediaFile: async () => null,
        listMedia: async () => [],
        reorderImages: async (itemId, imageIds) => {
          reorderCalls.push({ imageIds, itemId });
          return { imageIds, itemId };
        },
        uploadMedia: async () => [],
      },
      resolveAccessContext: async () => ({
        owner: {
          email: "owner@example.com",
          id: "owner-1",
          name: "Owner",
        },
        client: {
          id: "write-client",
          kind: "api-key",
          name: "Write client",
        },
        permissions: ["inventory:write"],
      }),
      unsafeSkipContractValidationForTests: true,
    });

    const response = await app.request(
      "/api/v1/inventory-items/item-1/media/image-order",
      {
        body: JSON.stringify({ imageIds: ["image-2", "image-1"] }),
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "image-order-1",
        },
        method: "PUT",
      },
    );

    expect(response.status).toBe(200);
    expect(reorderCalls).toEqual([
      { imageIds: ["image-2", "image-1"], itemId: "item-1" },
    ]);
    expect(await response.json()).toEqual({
      imageIds: ["image-2", "image-1"],
      itemId: "item-1",
    });
  });

  it("deletes item media through the parent item route", async () => {
    const deleteCalls: Array<{ mediaId: string; itemId: string }> = [];
    const app = createApp({
      emitAccessLog: () => {},
      inventoryItemMedia: {
        deleteMedia: async (itemId, mediaId) => {
          deleteCalls.push({ mediaId, itemId });
          return {
            deletedMediaId: mediaId,
          };
        },
        getMediaFile: async () => null,
        listMedia: async () => [],
        reorderImages: async () => ({
          imageIds: ["image-1"],
          itemId: "unused",
        }),
        uploadMedia: async () => [],
      },
      resolveAccessContext: async () => ({
        owner: {
          email: "owner@example.com",
          id: "owner-1",
          name: "Owner",
        },
        client: {
          id: "write-client",
          kind: "api-key",
          name: "Write client",
        },
        permissions: ["inventory:write"],
      }),
      unsafeSkipContractValidationForTests: true,
    });

    const response = await app.request(
      "/api/v1/inventory-items/item-1/media/image-1",
      {
        headers: {
          "Idempotency-Key": "delete-media-1",
        },
        method: "DELETE",
      },
    );

    expect(response.status).toBe(200);
    expect(deleteCalls).toEqual([
      { mediaId: "image-1", itemId: "item-1" },
    ]);
    expect(await response.json()).toEqual({
      deletedMediaId: "image-1",
    });
  });
});

function restoreEnvironmentVariable(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}

function xmpWithOrientation(orientation: number): string {
  return `<?xpacket begin=""?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description xmlns:tiff="http://ns.adobe.com/tiff/1.0/" tiff:Orientation="${orientation}" />
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

async function readAccessContext() {
  return {
    owner: {
      email: "owner@example.com",
      id: "owner-1",
      name: "Owner",
    },
    client: {
      id: "read-client",
      kind: "api-key" as const,
      name: "Read client",
    },
    permissions: ["inventory:read" as const],
  };
}

async function writeAccessContext() {
  return {
    owner: {
      email: "owner@example.com",
      id: "owner-1",
      name: "Owner",
    },
    client: {
      id: "write-client",
      kind: "api-key" as const,
      name: "Write client",
    },
    permissions: ["inventory:write" as const],
  };
}
