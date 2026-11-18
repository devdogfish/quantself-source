import fontkit from "@pdf-lib/fontkit";
import { readFile } from "node:fs/promises";
import { degrees, PDFDocument, rgb, type PDFPage, type PDFFont } from "pdf-lib";
import QRCode from "qrcode";

export const LETTER_WIDTH_POINTS = 612;
export const LETTER_HEIGHT_POINTS = 792;
export const LABEL_WIDTH_POINTS = 4 * 72;
export const LABEL_HEIGHT_POINTS = 6 * 72;
export const FULL_QR_LABEL_HEIGHT_POINTS = 5.4 * 72;
export const QR_QUIET_ZONE_MODULES = 4;
export const EDITORIAL_QR_QUIET_ZONE_MODULES = 3;
export const FULL_WIDTH_QR_QUIET_ZONE_MODULES = 0;
export const LABEL_INK_HEX = "#171717";
const EDITORIAL_WRAPPED_TITLE_MAX_FONT_SIZE = 28;
export const INVENTORY_CONTAINER_LABEL_DESIGNS = [
  "editorial",
  "editorial-title-first",
  "scan-first",
  "equipment-tag",
  "equipment-tag-aligned",
] as const;

export type InventoryContainerLabelDesign =
  (typeof INVENTORY_CONTAINER_LABEL_DESIGNS)[number];

export const DEFAULT_INVENTORY_CONTAINER_LABEL_DESIGN: InventoryContainerLabelDesign =
  "editorial";

const INK = rgb(23 / 255, 23 / 255, 23 / 255);
const MUTED_INK = rgb(92 / 255, 92 / 255, 92 / 255);
const BORDER = rgb(222 / 255, 222 / 255, 222 / 255);
const PAPER = rgb(1, 1, 1);
const EDITORIAL_TITLE_TOP_INSET_POINTS = 38;
const EDITORIAL_FOOTER_RULE_INSET_POINTS = 60;
const EDITORIAL_FOOTER_TEXT_INSET_POINTS = 29;
const EDITORIAL_QR_OPTICAL_OFFSET_POINTS = 1;
const EDITORIAL_QR_BOX_CLEARANCE_POINTS = 3;
const fontPaths = {
  body: new URL("./fonts/inter-latin-500-normal.ttf", import.meta.url),
  heading: new URL(
    "./fonts/ibm-plex-sans-condensed-latin-600-normal.ttf",
    import.meta.url,
  ),
  metadata: new URL("./fonts/geist-mono-latin-500-normal.ttf", import.meta.url),
};
let fontBytesPromise:
  | Promise<{
      body: Uint8Array;
      heading: Uint8Array;
      metadata: Uint8Array;
    }>
  | undefined;

export type InventoryContainerLabelInput = {
  containerName: string;
  design?: InventoryContainerLabelDesign;
  qrUrl: string;
  referenceId: string;
};

type LabelFonts = {
  body: PDFFont;
  heading: PDFFont;
  metadata: PDFFont;
};

type LabelDrawingContext = {
  fonts: LabelFonts;
  headingFace: ReturnType<typeof fontkit.create>;
  input: InventoryContainerLabelInput;
  labelHeight: number;
  labelWidth: number;
  labelX: number;
  labelY: number;
  page: PDFPage;
};

export function buildInventoryContainerReferenceUrl(
  origin: string,
  referenceId: string,
): string {
  return new URL(`/c/${encodeURIComponent(referenceId)}`, origin).toString();
}

export async function generateInventoryContainerLabelPdf(
  input: InventoryContainerLabelInput,
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const page = pdf.addPage([LETTER_WIDTH_POINTS, LETTER_HEIGHT_POINTS]);
  const fontBytes = await loadFontBytes();
  const [body, heading, metadata] = await Promise.all([
    pdf.embedFont(fontBytes.body, { subset: false }),
    pdf.embedFont(fontBytes.heading, { subset: false }),
    pdf.embedFont(fontBytes.metadata, { subset: false }),
  ]);
  const labelX = (LETTER_WIDTH_POINTS - LABEL_WIDTH_POINTS) / 2;
  const labelY = (LETTER_HEIGHT_POINTS - LABEL_HEIGHT_POINTS) / 2;

  pdf.setTitle(`${input.referenceId} container label`);
  pdf.setSubject(input.qrUrl);
  pdf.setCreator("QuantSelf");
  pdf.setProducer("QuantSelf");

  const context: LabelDrawingContext = {
    fonts: { body, heading, metadata },
    headingFace: fontkit.create(fontBytes.heading),
    input,
    labelHeight: LABEL_HEIGHT_POINTS,
    labelWidth: LABEL_WIDTH_POINTS,
    labelX,
    labelY,
    page,
  };

  switch (input.design ?? DEFAULT_INVENTORY_CONTAINER_LABEL_DESIGN) {
    case "editorial-title-first":
      drawEditorialTitleFirstLabel(context);
      break;
    case "scan-first":
      drawScanFirstLabel(context);
      break;
    case "equipment-tag":
      drawEquipmentTagLabel(context);
      break;
    case "equipment-tag-aligned":
      drawEquipmentTagLabel(context, "aligned");
      break;
    default:
      drawEditorialLabel(context);
  }

  return pdf.save({ useObjectStreams: false });
}

function drawEditorialLabel(context: LabelDrawingContext) {
  const {
    fonts: { heading, metadata },
    headingFace,
    input,
    labelHeight,
    labelWidth,
    labelX,
    labelY,
    page,
  } = context;
  const contentInset = 26;
  const footerRuleY = labelY + EDITORIAL_FOOTER_RULE_INSET_POINTS;

  drawLabelSurface(context);
  const name = pdfSafeText(input.containerName);
  const maxNameWidth = labelWidth - contentInset * 2;
  let nameLines = fitContainerName(name, heading, maxNameWidth);
  if (
    nameLines.lines.length > 1 &&
    nameLines.fontSize > EDITORIAL_WRAPPED_TITLE_MAX_FONT_SIZE
  ) {
    nameLines = fitContainerName(
      name,
      heading,
      maxNameWidth,
      EDITORIAL_WRAPPED_TITLE_MAX_FONT_SIZE,
    );
  }
  const lineHeight = nameLines.fontSize * 1.02;
  const { ascent, descent } = measureTitleInkEdges(
    headingFace,
    nameLines.lines,
    nameLines.fontSize,
  );
  const layout = computeEditorialTitleAndQrLayout({
    labelTop: labelY + labelHeight,
    footerRuleY,
    qrSize: labelWidth,
    titleTopInset: EDITORIAL_TITLE_TOP_INSET_POINTS,
    titleInkAscent: ascent,
    titleInkDescent: descent,
    lineCount: nameLines.lines.length,
    lineHeight,
  });
  drawRoundedQr(page, input.qrUrl, {
    x: labelX + (labelWidth - layout.qrSize) / 2,
    y: layout.qrY,
    size: layout.qrSize,
    quietZoneModules: EDITORIAL_QR_QUIET_ZONE_MODULES,
  });
  drawCenteredContainerName(page, nameLines, heading, {
    firstBaseline: layout.firstBaseline,
    labelWidth,
    labelX,
  });

  drawRule(
    page,
    labelX + contentInset,
    labelX + labelWidth - contentInset,
    footerRuleY,
  );
  drawSpacedText(page, "QUANTSELF  /  CONTAINER", metadata, 8.25, {
    color: MUTED_INK,
    spacing: 0.72,
    x: labelX + contentInset,
    y: labelY + EDITORIAL_FOOTER_TEXT_INSET_POINTS,
  });
  drawSpacedText(
    page,
    pdfSafeText(input.referenceId).toUpperCase(),
    metadata,
    8.25,
    {
      align: "right",
      color: INK,
      spacing: 0.72,
      x: labelX + labelWidth - contentInset,
      y: labelY + EDITORIAL_FOOTER_TEXT_INSET_POINTS,
    },
  );
}

function drawEditorialTitleFirstLabel(context: LabelDrawingContext) {
  const {
    fonts: { heading, metadata },
    input,
    labelWidth,
    labelX,
    labelY,
    page,
  } = context;
  const contentInset = 26;
  const qrSize = labelWidth;

  drawLabelSurface(context);
  drawSpacedText(page, "QUANTSELF  /  CONTAINER", metadata, 8.25, {
    color: MUTED_INK,
    spacing: 0.72,
    x: labelX + contentInset,
    y: labelY + 399,
  });
  drawSpacedText(
    page,
    pdfSafeText(input.referenceId).toUpperCase(),
    metadata,
    8.25,
    {
      align: "right",
      color: INK,
      spacing: 0.72,
      x: labelX + labelWidth - contentInset,
      y: labelY + 399,
    },
  );
  drawRule(
    page,
    labelX + contentInset,
    labelX + labelWidth - contentInset,
    labelY + 382,
  );

  drawRoundedQr(page, input.qrUrl, {
    x: labelX,
    y: labelY + 2,
    size: qrSize,
  });

  const nameLines = fitContainerName(
    pdfSafeText(input.containerName),
    heading,
    labelWidth - contentInset * 2,
    34,
  );
  drawCenteredContainerName(page, nameLines, heading, {
    firstBaseline: labelY + 344,
    labelWidth,
    labelX,
  });
}

function drawScanFirstLabel(context: LabelDrawingContext) {
  const {
    fonts: { body, heading, metadata },
    input,
    labelWidth,
    labelX,
    labelY,
    page,
  } = context;
  const inset = 24;
  const qrSize = 228;

  drawLabelSurface(context);
  page.drawRectangle({
    x: labelX,
    y: labelY + 378,
    width: labelWidth,
    height: 54,
    color: INK,
  });
  drawSpacedText(page, "QUANTSELF", metadata, 8.5, {
    color: PAPER,
    spacing: 0.82,
    x: labelX + inset,
    y: labelY + 400,
  });
  drawSpacedText(
    page,
    pdfSafeText(input.referenceId).toUpperCase(),
    metadata,
    8.25,
    {
      align: "right",
      color: PAPER,
      spacing: 0.72,
      x: labelX + labelWidth - inset,
      y: labelY + 400,
    },
  );

  const nameLines = fitContainerName(
    pdfSafeText(input.containerName),
    heading,
    labelWidth - inset * 2,
  );
  drawCenteredContainerName(page, nameLines, heading, {
    firstBaseline: nameLines.lines.length === 1 ? labelY + 339 : labelY + 353,
    labelWidth,
    labelX,
  });

  drawRoundedQr(page, input.qrUrl, {
    x: labelX + (labelWidth - qrSize) / 2,
    y: labelY + 80,
    size: qrSize,
  });

  drawRule(page, labelX + inset, labelX + labelWidth - inset, labelY + 57);
  drawSpacedText(page, "SCAN TO OPEN", metadata, 8.1, {
    color: MUTED_INK,
    spacing: 0.75,
    x: labelX + inset,
    y: labelY + 30,
  });
  drawRightText(
    page,
    "Current contents",
    body,
    8.75,
    labelX + labelWidth - inset,
    labelY + 29,
    MUTED_INK,
  );
}

function drawEquipmentTagLabel(
  context: LabelDrawingContext,
  variant: "aligned" | "balanced" = "balanced",
) {
  const {
    fonts: { heading, metadata },
    input,
    labelHeight,
    labelWidth,
    labelX,
    page,
  } = context;
  const railWidth = 38;
  const stickerHeight =
    variant === "aligned" ? FULL_QR_LABEL_HEIGHT_POINTS : labelHeight;
  const stickerY = (LETTER_HEIGHT_POINTS - stickerHeight) / 2;
  const stickerTop = stickerY + stickerHeight;
  const contentInset = 18;
  const contentX = labelX + railWidth + contentInset;
  const contentRight = labelX + labelWidth - contentInset;
  const contentWidth = contentRight - contentX;
  const qrInset = 18;
  const qrX = labelX + railWidth + qrInset;
  const qrSize = labelX + labelWidth - qrInset - qrX;
  const qrY =
    variant === "aligned" ? stickerY + 53 / 2 : stickerY + 53;

  drawLabelSurface(context, { height: stickerHeight, y: stickerY });
  page.drawRectangle({
    x: labelX,
    y: stickerY,
    width: railWidth,
    height: stickerHeight,
    color: INK,
  });
  page.drawText("QUANTSELF / CONTAINER", {
    x: labelX + 24,
    y: stickerY + 19,
    font: metadata,
    size: 8.25,
    color: PAPER,
    rotate: degrees(90),
  });

  drawSpacedText(
    page,
    pdfSafeText(input.referenceId).toUpperCase(),
    metadata,
    9,
    {
      color: INK,
      spacing: 0.82,
      x: contentX,
      y: stickerTop - 36,
    },
  );
  drawRule(page, contentX, contentRight, stickerTop - 53);

  const nameLines = fitContainerName(
    pdfSafeText(input.containerName),
    heading,
    contentWidth,
  );
  drawLeftContainerName(page, nameLines, heading, {
    firstBaseline: stickerTop - (nameLines.lines.length === 1 ? 102 : 88),
    x: contentX,
  });

  drawRoundedQr(page, input.qrUrl, {
    x: qrX,
    y: qrY,
    size: qrSize,
    ...(variant === "aligned"
      ? { quietZoneModules: FULL_WIDTH_QR_QUIET_ZONE_MODULES }
      : {}),
  });
}

function drawLabelSurface(
  context: LabelDrawingContext,
  options?: { height: number; y: number },
) {
  const { labelHeight, labelWidth, labelX, labelY, page } = context;

  page.drawRectangle({
    x: labelX,
    y: options?.y ?? labelY,
    width: labelWidth,
    height: options?.height ?? labelHeight,
    color: PAPER,
    borderColor: BORDER,
    borderWidth: 0.75,
  });
}

export function buildRoundedQrPaths(value: string): {
  centerPath: string;
  darkPath: string;
  errorCorrectionLevel: "M";
  innerPath: string;
  moduleCount: number;
  quietZoneModules: number;
} {
  const qr = QRCode.create(value, { errorCorrectionLevel: "M" });
  const moduleCount = qr.modules.size;
  const darkParts: string[] = [];
  const outerFinderParts: string[] = [];
  const innerFinderParts: string[] = [];
  const centerFinderParts: string[] = [];

  for (let row = 0; row < moduleCount; row += 1) {
    for (let column = 0; column < moduleCount; column += 1) {
      if (
        !qr.modules.get(row, column) ||
        isFinderModule(row, column, moduleCount)
      ) {
        continue;
      }

      const radius = 0.18;
      darkParts.push(
        roundedRectPath(column, row, 1, 1, {
          bottomLeft:
            !isDark(qr.modules, row + 1, column) &&
            !isDark(qr.modules, row, column - 1)
              ? radius
              : 0,
          bottomRight:
            !isDark(qr.modules, row + 1, column) &&
            !isDark(qr.modules, row, column + 1)
              ? radius
              : 0,
          topLeft:
            !isDark(qr.modules, row - 1, column) &&
            !isDark(qr.modules, row, column - 1)
              ? radius
              : 0,
          topRight:
            !isDark(qr.modules, row - 1, column) &&
            !isDark(qr.modules, row, column + 1)
              ? radius
              : 0,
        }),
      );
    }
  }

  for (const [row, column] of finderPositions(moduleCount)) {
    outerFinderParts.push(
      roundedRectPath(column, row, 7, 7, uniformCorners(1.1)),
    );
    innerFinderParts.push(
      roundedRectPath(column + 1, row + 1, 5, 5, uniformCorners(0.7)),
    );
    centerFinderParts.push(
      roundedRectPath(column + 2, row + 2, 3, 3, uniformCorners(0.58)),
    );
  }

  return {
    centerPath: centerFinderParts.join(" "),
    darkPath: [...darkParts, ...outerFinderParts].join(" "),
    errorCorrectionLevel: "M",
    innerPath: innerFinderParts.join(" "),
    moduleCount,
    quietZoneModules: QR_QUIET_ZONE_MODULES,
  };
}

async function loadFontBytes() {
  fontBytesPromise ??= Promise.all([
    readFile(/* turbopackIgnore: true */ fontPaths.body),
    readFile(/* turbopackIgnore: true */ fontPaths.heading),
    readFile(/* turbopackIgnore: true */ fontPaths.metadata),
  ]).then(([body, heading, metadata]) => ({ body, heading, metadata }));

  return fontBytesPromise;
}

function drawRoundedQr(
  page: PDFPage,
  value: string,
  box: {
    quietZoneModules?: number;
    size: number;
    x: number;
    y: number;
  },
) {
  const paths = buildRoundedQrPaths(value);
  const quietZoneModules = box.quietZoneModules ?? paths.quietZoneModules;
  const totalModules = paths.moduleCount + quietZoneModules * 2;
  const moduleSize = box.size / totalModules;
  const contentX = box.x + quietZoneModules * moduleSize;
  const contentTop = box.y + box.size - quietZoneModules * moduleSize;

  page.drawRectangle({
    x: box.x,
    y: box.y,
    width: box.size,
    height: box.size,
    color: PAPER,
  });
  page.drawSvgPath(paths.darkPath, {
    x: contentX,
    y: contentTop,
    scale: moduleSize,
    color: INK,
  });
  page.drawSvgPath(paths.innerPath, {
    x: contentX,
    y: contentTop,
    scale: moduleSize,
    color: PAPER,
  });
  page.drawSvgPath(paths.centerPath, {
    x: contentX,
    y: contentTop,
    scale: moduleSize,
    color: INK,
  });
}

function fitContainerName(
  value: string,
  font: PDFFont,
  maxWidth: number,
  maxFontSize = 30,
): { fontSize: number; lines: string[] } {
  for (let fontSize = maxFontSize; fontSize >= 17; fontSize -= 1) {
    const lines = wrapText(value, font, fontSize, maxWidth);

    if (
      lines.length <= 2 &&
      lines.every((line) => font.widthOfTextAtSize(line, fontSize) <= maxWidth)
    ) {
      return { fontSize, lines };
    }
  }

  return {
    fontSize: 17,
    lines: fitNameToTwoLines(value, font, 17, maxWidth),
  };
}

function fitNameToTwoLines(
  value: string,
  font: PDFFont,
  fontSize: number,
  maxWidth: number,
) {
  const words = value.split(/\s+/u).filter(Boolean);
  let firstLine = "";
  let nextWordIndex = 0;

  while (nextWordIndex < words.length) {
    const candidate = firstLine
      ? `${firstLine} ${words[nextWordIndex]}`
      : words[nextWordIndex]!;

    if (font.widthOfTextAtSize(candidate, fontSize) > maxWidth) {
      break;
    }

    firstLine = candidate;
    nextWordIndex += 1;
  }

  if (!firstLine) {
    return [truncateText(value, font, fontSize, maxWidth)];
  }

  const remainder = words.slice(nextWordIndex).join(" ");

  return remainder
    ? [firstLine, truncateText(remainder, font, fontSize, maxWidth)]
    : [firstLine];
}

function drawCenteredContainerName(
  page: PDFPage,
  name: { fontSize: number; lines: string[] },
  font: PDFFont,
  options: {
    firstBaseline: number;
    labelWidth: number;
    labelX: number;
  },
) {
  const lineHeight = name.fontSize * 1.02;

  name.lines.forEach((line, index) => {
    drawCenteredText(
      page,
      line,
      font,
      name.fontSize,
      options.firstBaseline - lineHeight * index,
      options.labelX,
      options.labelWidth,
      INK,
    );
  });
}

function measureTitleInkEdges(
  face: ReturnType<typeof fontkit.create>,
  lines: string[],
  fontSize: number,
) {
  const inkY = (line: string, edge: "minY" | "maxY") => {
    const run = face.layout(line);
    const values = run.glyphs
      .map((glyph, index) => glyph.bbox[edge] + run.positions[index]!.yOffset)
      .filter(Number.isFinite);
    return (edge === "maxY" ? Math.max(...values) : Math.min(...values)) *
      (fontSize / face.unitsPerEm);
  };

  return {
    ascent: inkY(lines[0]!, "maxY"),
    descent: inkY(lines.at(-1)!, "minY"),
  };
}

export function computeEditorialTitleAndQrLayout({
  labelTop,
  footerRuleY,
  qrSize,
  titleTopInset,
  titleInkAscent,
  titleInkDescent,
  lineCount,
  lineHeight,
}: {
  labelTop: number;
  footerRuleY: number;
  qrSize: number;
  titleTopInset: number;
  titleInkAscent: number;
  titleInkDescent: number;
  lineCount: number;
  lineHeight: number;
}) {
  const firstBaseline = labelTop - titleTopInset - titleInkAscent;
  const titleInkBottom =
    firstBaseline -
    Math.max(0, lineCount - 1) * lineHeight +
    titleInkDescent;
  // The QR paints its entire white box, so that box must clear the title ink.
  const fittedQrSize = Math.min(
    qrSize,
    titleInkBottom -
      footerRuleY -
      2 *
        (EDITORIAL_QR_BOX_CLEARANCE_POINTS +
          EDITORIAL_QR_OPTICAL_OFFSET_POINTS),
  );

  return {
    firstBaseline,
    qrSize: fittedQrSize,
    qrY:
      (titleInkBottom + footerRuleY - fittedQrSize) / 2 +
      EDITORIAL_QR_OPTICAL_OFFSET_POINTS,
  };
}

function drawLeftContainerName(
  page: PDFPage,
  name: { fontSize: number; lines: string[] },
  font: PDFFont,
  options: {
    firstBaseline: number;
    x: number;
  },
) {
  const lineHeight = name.fontSize * 1.02;

  name.lines.forEach((line, index) => {
    page.drawText(line, {
      x: options.x,
      y: options.firstBaseline - lineHeight * index,
      font,
      size: name.fontSize,
      color: INK,
    });
  });
}

function wrapText(
  value: string,
  font: PDFFont,
  fontSize: number,
  maxWidth: number,
): string[] {
  const words = value.split(/\s+/u).filter(Boolean);
  const lines: string[] = [];

  for (const word of words) {
    const current = lines.at(-1);
    const candidate = current ? `${current} ${word}` : word;

    if (font.widthOfTextAtSize(candidate, fontSize) <= maxWidth) {
      if (current) {
        lines[lines.length - 1] = candidate;
      } else {
        lines.push(candidate);
      }
    } else {
      lines.push(word);
    }
  }

  return lines.length > 0 ? lines : ["UNTITLED CONTAINER"];
}

function truncateText(
  value: string,
  font: PDFFont,
  fontSize: number,
  maxWidth: number,
): string {
  let result = value;

  while (
    result.length > 1 &&
    font.widthOfTextAtSize(`${result}...`, fontSize) > maxWidth
  ) {
    result = result.slice(0, -1);
  }

  return `${result.trimEnd()}...`;
}

function drawCenteredText(
  page: PDFPage,
  text: string,
  font: PDFFont,
  size: number,
  y: number,
  containerX: number,
  containerWidth: number,
  color = INK,
) {
  const width = font.widthOfTextAtSize(text, size);

  page.drawText(text, {
    x: containerX + (containerWidth - width) / 2,
    y,
    font,
    size,
    color,
  });
}

function drawRightText(
  page: PDFPage,
  text: string,
  font: PDFFont,
  size: number,
  right: number,
  y: number,
  color = INK,
) {
  page.drawText(text, {
    x: right - font.widthOfTextAtSize(text, size),
    y,
    font,
    size,
    color,
  });
}

function drawRule(page: PDFPage, startX: number, endX: number, y: number) {
  page.drawLine({
    start: { x: startX, y },
    end: { x: endX, y },
    thickness: 0.75,
    color: BORDER,
  });
}

function drawSpacedText(
  page: PDFPage,
  text: string,
  font: PDFFont,
  size: number,
  options: {
    align?: "left" | "right";
    color: ReturnType<typeof rgb>;
    spacing: number;
    x: number;
    y: number;
  },
) {
  const width = spacedTextWidth(text, font, size, options.spacing);
  let cursor = options.align === "right" ? options.x - width : options.x;

  for (const character of text) {
    page.drawText(character, {
      x: cursor,
      y: options.y,
      font,
      size,
      color: options.color,
    });
    cursor += font.widthOfTextAtSize(character, size) + options.spacing;
  }
}

function spacedTextWidth(
  text: string,
  font: PDFFont,
  size: number,
  spacing: number,
) {
  return (
    [...text].reduce(
      (width, character) => width + font.widthOfTextAtSize(character, size),
      0,
    ) +
    Math.max(0, text.length - 1) * spacing
  );
}

function isDark(
  modules: ReturnType<typeof QRCode.create>["modules"],
  row: number,
  column: number,
) {
  return (
    row >= 0 &&
    column >= 0 &&
    row < modules.size &&
    column < modules.size &&
    Boolean(modules.get(row, column))
  );
}

function isFinderModule(row: number, column: number, moduleCount: number) {
  return finderPositions(moduleCount).some(
    ([finderRow, finderColumn]) =>
      row >= finderRow &&
      row < finderRow + 7 &&
      column >= finderColumn &&
      column < finderColumn + 7,
  );
}

function finderPositions(moduleCount: number): Array<[number, number]> {
  return [
    [0, 0],
    [0, moduleCount - 7],
    [moduleCount - 7, 0],
  ];
}

type CornerRadii = {
  bottomLeft: number;
  bottomRight: number;
  topLeft: number;
  topRight: number;
};

function uniformCorners(radius: number): CornerRadii {
  return {
    bottomLeft: radius,
    bottomRight: radius,
    topLeft: radius,
    topRight: radius,
  };
}

function roundedRectPath(
  x: number,
  y: number,
  width: number,
  height: number,
  radii: CornerRadii,
) {
  const right = x + width;
  const bottom = y + height;

  return [
    `M ${x + radii.topLeft} ${y}`,
    `H ${right - radii.topRight}`,
    radii.topRight > 0
      ? `Q ${right} ${y} ${right} ${y + radii.topRight}`
      : `H ${right} V ${y}`,
    `V ${bottom - radii.bottomRight}`,
    radii.bottomRight > 0
      ? `Q ${right} ${bottom} ${right - radii.bottomRight} ${bottom}`
      : `V ${bottom} H ${right}`,
    `H ${x + radii.bottomLeft}`,
    radii.bottomLeft > 0
      ? `Q ${x} ${bottom} ${x} ${bottom - radii.bottomLeft}`
      : `H ${x} V ${bottom}`,
    `V ${y + radii.topLeft}`,
    radii.topLeft > 0
      ? `Q ${x} ${y} ${x + radii.topLeft} ${y}`
      : `V ${y} H ${x}`,
    "Z",
  ].join(" ");
}

function pdfSafeText(value: string): string {
  return (
    value
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/gu, "")
      .replace(/[^\x20-\x7e]/gu, "?")
      .trim() || "Untitled container"
  );
}
