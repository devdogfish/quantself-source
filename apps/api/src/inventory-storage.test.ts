import { afterEach, describe, expect, it } from "bun:test";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deleteInventoryStoredFiles } from "./inventory-storage";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("Inventory stored-file deletion", () => {
  it("deletes unique files inside upload roots and ignores missing files", async () => {
    const root = await createTemporaryDirectory();
    const nestedDirectory = path.join(root, "nested");
    const storedFile = path.join(nestedDirectory, "image.jpg");
    const missingFile = path.join(root, "missing.jpg");
    await mkdir(nestedDirectory);
    await writeFile(storedFile, "stored image");

    const failures = await deleteInventoryStoredFiles(
      [storedFile, missingFile, storedFile],
      [root],
    );

    expect(failures).toEqual([]);
    await expect(access(storedFile)).rejects.toThrow();
  });

  it("removes persisted image preview representations with their source", async () => {
    const root = await createTemporaryDirectory();
    const storedFile = path.join(root, "image.jpg");
    const previewFile = `${storedFile}.preview.webp`;
    await writeFile(storedFile, "source image");
    await writeFile(previewFile, "preview image");

    const failures = await deleteInventoryStoredFiles([storedFile], [root]);

    expect(failures).toEqual([]);
    await expect(access(previewFile)).rejects.toThrow();
  });

  it("removes a persisted preview when its source is already missing", async () => {
    const root = await createTemporaryDirectory();
    const storedFile = path.join(root, "missing-image.jpg");
    const previewFile = `${storedFile}.preview.webp`;
    await writeFile(previewFile, "preview image");

    const failures = await deleteInventoryStoredFiles([storedFile], [root]);

    expect(failures).toEqual([]);
    await expect(access(previewFile)).rejects.toThrow();
  });

  it("refuses to delete paths outside configured upload roots", async () => {
    const root = await createTemporaryDirectory();
    const outsideRoot = await createTemporaryDirectory();
    const outsideFile = path.join(outsideRoot, "keep.txt");
    await writeFile(outsideFile, "keep");

    const failures = await deleteInventoryStoredFiles([outsideFile], [root]);

    expect(failures).toEqual([outsideFile]);
    await access(outsideFile);
  });

  it("reports filesystem cleanup failures without hiding them", async () => {
    const root = await createTemporaryDirectory();
    const directoryPath = path.join(root, "not-a-file");
    await mkdir(directoryPath);

    const failures = await deleteInventoryStoredFiles([directoryPath], [root]);

    expect(failures).toEqual([directoryPath]);
  });
});

describe("Inventory storage runtime wiring", () => {
  it("mounts every shared inventory upload volume into the API container", async () => {
    const compose = await Bun.file(
      new URL("../../../compose.yaml", import.meta.url),
    ).text();
    const apiService = /\n  api:\n[\s\S]*?\n  gateway:/u.exec(compose)?.[0];

    expect(apiService).toContain(
      "INVENTORY_UPLOAD_DIR: /app/storage/inventory-images",
    );
    expect(apiService).toContain(
      "INVENTORY_AUDIO_UPLOAD_DIR: /app/storage/inventory-audio",
    );
    expect(apiService).toContain(
      "INVENTORY_ASSET_UPLOAD_DIR: /app/storage/inventory-assets",
    );
    expect(apiService).toContain(
      "quantself_inventory_uploads:/app/storage/inventory-images",
    );
    expect(apiService).toContain(
      "quantself_inventory_audio_uploads:/app/storage/inventory-audio",
    );
    expect(apiService).toContain(
      "quantself_inventory_asset_uploads:/app/storage/inventory-assets",
    );
  });
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "quantself-inventory-storage-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}
