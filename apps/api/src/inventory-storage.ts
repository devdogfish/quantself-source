import { originalFiles, isOriginalReference } from "./original-files";
import { assertOriginalWritesEnabled } from "./original-storage";
import { unlink } from "node:fs/promises";
import path from "node:path";

export async function deleteInventoryStoredFiles(
  filePaths: Iterable<string>,
  uploadRoots: Iterable<string> = inventoryUploadRoots(),
): Promise<string[]> {
  assertOriginalWritesEnabled();
  const allowedRoots = [...uploadRoots].map((root) => path.resolve(root));
  const uniquePaths = [...new Set(filePaths)];
  const failures: string[] = [];

  const remove = async (filePath: string) => {
      if (isOriginalReference(filePath)) {
        try { await originalFiles.remove(filePath); } catch { failures.push(filePath); }
        return;
      }
      const resolvedPath = path.resolve(filePath);

      if (!allowedRoots.some((root) => isPathWithinRoot(resolvedPath, root))) {
        failures.push(filePath);
        return;
      }

      const cleanupResults = await Promise.allSettled([
        unlinkIfPresent(resolvedPath),
        unlinkIfPresent(imagePreviewRepresentationPath(resolvedPath)),
      ]);

      if (cleanupResults.some((result) => result.status === "rejected")) {
        failures.push(filePath);
      }
  };
  for (let offset = 0; offset < uniquePaths.length; offset += 4) {
    await Promise.all(uniquePaths.slice(offset, offset + 4).map(remove));
  }

  return failures;
}

function imagePreviewRepresentationPath(filePath: string): string {
  return `${filePath}.preview.webp`;
}

async function unlinkIfPresent(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
  }
}

function inventoryUploadRoots(): string[] {
  return [
    getInventoryImageUploadRoot(),
    getInventoryAudioUploadRoot(),
    getInventoryAssetUploadRoot(),
  ];
}

function getInventoryImageUploadRoot(): string {
  return (
    process.env.INVENTORY_UPLOAD_DIR ??
    path.join(process.cwd(), "storage", "inventory-images")
  );
}

function getInventoryAudioUploadRoot(): string {
  return (
    process.env.INVENTORY_AUDIO_UPLOAD_DIR ??
    path.join(process.cwd(), "storage", "inventory-audio")
  );
}

function getInventoryAssetUploadRoot(): string {
  return (
    process.env.INVENTORY_ASSET_UPLOAD_DIR ??
    path.join(process.cwd(), "storage", "inventory-assets")
  );
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function isPathWithinRoot(filePath: string, root: string): boolean {
  const relativePath = path.relative(root, filePath);

  return (
    relativePath.length === 0 ||
    (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  );
}
