import fontkit from "@pdf-lib/fontkit";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { PDFDocument } from "pdf-lib";
import {
  buildRoundedQrPaths,
  buildInventoryContainerReferenceUrl,
  computeEditorialTitleAndQrLayout,
  DEFAULT_INVENTORY_CONTAINER_LABEL_DESIGN,
  EDITORIAL_QR_QUIET_ZONE_MODULES,
  FULL_QR_LABEL_HEIGHT_POINTS,
  FULL_WIDTH_QR_QUIET_ZONE_MODULES,
  generateInventoryContainerLabelPdf,
  INVENTORY_CONTAINER_LABEL_DESIGNS,
  LABEL_INK_HEX,
  LABEL_HEIGHT_POINTS,
  LABEL_WIDTH_POINTS,
  LETTER_HEIGHT_POINTS,
  LETTER_WIDTH_POINTS,
  QR_QUIET_ZONE_MODULES,
} from "./inventory-container-label";

describe("inventory container printable label", () => {
  test("uses the selected A1 design by default", () => {
    expect(DEFAULT_INVENTORY_CONTAINER_LABEL_DESIGN).toBe("editorial");
  });

  test("builds a stable, encoded container reference URL", () => {
    expect(
      buildInventoryContainerReferenceUrl(
        "https://inventory.example",
        "BIN / 0042",
      ),
    ).toBe("https://inventory.example/c/BIN%20%2F%200042");
  });

  test("generates one Letter page with one centered 4x6 portrait label", async () => {
    const qrUrl = "https://inventory.example/c/BIN-0042";
    const bytes = await generateInventoryContainerLabelPdf({
      containerName: "Basement winter equipment",
      qrUrl,
      referenceId: "BIN-0042",
    });
    const pdf = await PDFDocument.load(bytes);
    const pages = pdf.getPages();

    expect(pages).toHaveLength(1);
    expect(pages[0]?.getWidth()).toBe(LETTER_WIDTH_POINTS);
    expect(pages[0]?.getHeight()).toBe(LETTER_HEIGHT_POINTS);
    expect(LABEL_WIDTH_POINTS).toBe(4 * 72);
    expect(LABEL_HEIGHT_POINTS).toBe(6 * 72);
    expect(FULL_QR_LABEL_HEIGHT_POINTS).toBe(5.4 * 72);
    expect(LABEL_HEIGHT_POINTS).toBeGreaterThan(LABEL_WIDTH_POINTS);
    expect(pdf.getTitle()).toBe("BIN-0042 container label");
    expect(pdf.getSubject()).toBe(qrUrl);
    expect(bytes.byteLength).toBeGreaterThan(50_000);
    const pdfSource = Buffer.from(bytes).toString("latin1");
    expect(pdfSource).toContain("Inter-Medium");
    expect(pdfSource).toContain("IBMPlexSansCond-SemiBold");
    expect(pdfSource).toContain("GeistMono-Medium");
  });

  test("builds a compact, solid QR with rounded modules and finders", () => {
    const qr = buildRoundedQrPaths("https://inventory.example/c/BIN-0042");

    expect(qr.errorCorrectionLevel).toBe("M");
    expect(qr.quietZoneModules).toBe(QR_QUIET_ZONE_MODULES);
    expect(qr.quietZoneModules).toBe(4);
    expect(FULL_WIDTH_QR_QUIET_ZONE_MODULES).toBe(0);
    expect(qr.moduleCount).toBe(29);
    expect(qr.darkPath).toContain("Q");
    expect(qr.innerPath.match(/\bM\b/gu)).toHaveLength(3);
    expect(qr.centerPath.match(/\bM\b/gu)).toHaveLength(3);
    expect(LABEL_INK_HEX).toBe("#171717");
  });

  test("pins the title and footer while centering the QR", () => {
    const heading = fontkit.create(
      readFileSync(
        new URL(
          "./fonts/ibm-plex-sans-condensed-latin-600-normal.ttf",
          import.meta.url,
        ),
      ),
    );
    const labelTop = (LETTER_HEIGHT_POINTS + LABEL_HEIGHT_POINTS) / 2;
    const footerRuleY =
      (LETTER_HEIGHT_POINTS - LABEL_HEIGHT_POINTS) / 2 +
      60;
    const qrModuleCount = buildRoundedQrPaths(
      "https://inventory.example/c/BIN-0042",
    ).moduleCount;
    for (const { fontSize, lines } of [
      { fontSize: 30, lines: ["L02 - CLOTHING"] },
      { fontSize: 28, lines: ["L08 - BOOKS &", "ARCHIVE"] },
    ]) {
      const scale = fontSize / heading.unitsPerEm;
      const firstLine = heading.layout(lines[0]!);
      const lastLine = heading.layout(lines.at(-1)!);
      const ascent = Math.max(
        ...firstLine.glyphs.map(
          (glyph, index) =>
            glyph.bbox.maxY + firstLine.positions[index]!.yOffset,
        ).filter(Number.isFinite),
      ) * scale;
      const descent = Math.min(
        ...lastLine.glyphs.map(
          (glyph, index) =>
            glyph.bbox.minY + lastLine.positions[index]!.yOffset,
        ).filter(Number.isFinite),
      ) * scale;
      const lineHeight = fontSize * 1.02;
      const layout = computeEditorialTitleAndQrLayout({
        labelTop,
        footerRuleY,
        qrSize: LABEL_WIDTH_POINTS,
        titleTopInset: 38,
        titleInkAscent: ascent,
        titleInkDescent: descent,
        lineCount: lines.length,
        lineHeight,
      });
      const titleTop = layout.firstBaseline + ascent;
      const titleInkBottom =
        layout.firstBaseline - (lines.length - 1) * lineHeight + descent;
      const editorialQuietZoneSize =
        (layout.qrSize * EDITORIAL_QR_QUIET_ZONE_MODULES) /
        (qrModuleCount + EDITORIAL_QR_QUIET_ZONE_MODULES * 2);
      const gapAboveQr =
        titleInkBottom -
        (layout.qrY + layout.qrSize - editorialQuietZoneSize);
      const gapBelowQr =
        layout.qrY + editorialQuietZoneSize - footerRuleY;

      expect(labelTop - titleTop).toBeCloseTo(38);
      expect(titleInkBottom - (layout.qrY + layout.qrSize)).toBeGreaterThanOrEqual(3);
      expect(Math.abs(gapAboveQr - gapBelowQr)).toBeLessThanOrEqual(2.1);
      expect(gapAboveQr).toBeGreaterThan(18);
      expect(layout.qrSize).toBeGreaterThan(270);
    }
  });

  test("renders all comparison designs as distinct PDFs", async () => {
    const variants = await Promise.all(
      INVENTORY_CONTAINER_LABEL_DESIGNS.map(async (design) => {
        const bytes = await generateInventoryContainerLabelPdf({
          containerName: "Basement winter equipment",
          design,
          qrUrl: "https://inventory.example/c/BIN-0042",
          referenceId: "BIN-0042",
        });

        expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
        return Buffer.from(bytes).toString("latin1");
      }),
    );

    expect(INVENTORY_CONTAINER_LABEL_DESIGNS).toHaveLength(5);
    expect(new Set(variants).size).toBe(5);
  });

  test("keeps only durable fields on the physical label", () => {
    const source = readFileSync(
      new URL("./inventory-container-label.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain("input.qrUrl");
    expect(source).toContain("input.containerName");
    expect(source).toContain("input.referenceId");
    expect(source).not.toContain("Scan to view current contents");
    expect(source).not.toContain("itemCount");
    expect(source).not.toContain("locationName");
    expect(source).not.toContain("input.contents");
    expect(source).not.toContain("gradient");
  });
});
