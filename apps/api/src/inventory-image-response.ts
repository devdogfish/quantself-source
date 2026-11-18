import { originalFiles, isOriginalReference } from "./original-files";
import { readFile } from "node:fs/promises";
import path from "node:path";

interface InventoryImageFile {
  filePath: string;
  mimeType: string | null;
  originalName: string | null;
}

export async function inventoryImageFileResponse(
  image: InventoryImageFile,
  input: { cacheControl: string },
): Promise<Response> {
  if (isOriginalReference(image.filePath)) return originalFiles.open(image.filePath);
  const bytes = await readFile(image.filePath);

  return new Response(bytes, {
    headers: {
      "Cache-Control": input.cacheControl,
      "Content-Disposition": `inline; filename="${safeFilename(
        image.originalName ?? path.basename(image.filePath),
      )}"`,
      "Content-Type": image.mimeType ?? "application/octet-stream",
    },
  });
}

function safeFilename(filename: string): string {
  return filename.replace(/[^a-zA-Z0-9._-]/g, "_");
}
