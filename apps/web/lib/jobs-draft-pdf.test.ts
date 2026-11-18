import { expect, test } from "bun:test";
import { PDFDocument } from "pdf-lib";
import { renderJobsDraftPdf } from "./jobs-draft-pdf";

test("a saved résumé yields a deterministic, paginated PDF", async () => {
  const font = await Bun.file(new URL("./fonts/inter-latin-500-normal.ttf", import.meta.url)).bytes();
  const header = "# {{fullName}}\n\n{{contact}}\n\n## Summary\n\n";
  const bullets = Array.from({ length: 70 }, (_, index) =>
    `- Improved café listings and made updates 3–5× faster for project ${index + 1}\n`).join("");
  const source = header + bullets;
  const first = await renderJobsDraftPdf(source, font);
  expect(await renderJobsDraftPdf(source, font)).toEqual(first);
  expect(await renderJobsDraftPdf(source + "- Added a new result\n", font)).not.toEqual(first);
  expect((await PDFDocument.load(first)).getPageCount()).toBeGreaterThan(1);
});
