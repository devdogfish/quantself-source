import { cp, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const requirePdf = createRequire(import.meta.resolve("react-pdf"));
const pdfRoot = dirname(requirePdf.resolve("pdfjs-dist/package.json"));
const { version } = await Bun.file(join(pdfRoot, "package.json")).json() as { version: string };
const target = join(import.meta.dir, "../public/pdfjs", version);
await mkdir(target, { recursive: true });
await Promise.all([
  cp(join(pdfRoot, "build/pdf.worker.min.mjs"), join(target, "pdf.worker.min.mjs")),
  ...["cmaps", "standard_fonts", "wasm", "iccs"].map(folder =>
    cp(join(pdfRoot, folder), join(target, folder), { recursive: true })),
]);
