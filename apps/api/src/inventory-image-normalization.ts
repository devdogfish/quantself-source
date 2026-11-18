import sharp, { type Sharp } from "sharp";

const supportedFormats = new Set(["gif", "jpeg", "png", "webp"]);

type ImageOrientation = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

class InventoryImageNormalizationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InventoryImageNormalizationError";
  }
}

async function normalizeInventoryImage(input: Buffer): Promise<Buffer> {
  try {
    const metadata = await sharp(input, { animated: true }).metadata();

    if (!metadata.format || !supportedFormats.has(metadata.format)) {
      throw new InventoryImageNormalizationError(
        "Image format cannot be normalized.",
      );
    }

    const exifOrientation = parseOrientation(metadata.orientation);
    const xmpOrientation = parseXmpOrientation(metadata.xmp);

    if (
      exifOrientation !== null &&
      xmpOrientation !== null &&
      exifOrientation !== xmpOrientation
    ) {
      throw new InventoryImageNormalizationError(
        "Image contains conflicting orientation metadata.",
      );
    }

    const orientation = exifOrientation ?? xmpOrientation;

    if (orientation === null || orientation === 1) {
      return input;
    }

    return await applyOrientation(
      sharp(input, { animated: true }),
      orientation,
    ).toBuffer();
  } catch (error) {
    if (error instanceof InventoryImageNormalizationError) {
      throw error;
    }

    throw new InventoryImageNormalizationError(
      "Image could not be normalized.",
      { cause: error },
    );
  }
}

function applyOrientation(
  pipeline: Sharp,
  orientation: Exclude<ImageOrientation, 1>,
): Sharp {
  switch (orientation) {
    case 2:
      return pipeline.flop();
    case 3:
      return pipeline.rotate(180);
    case 4:
      return pipeline.flip();
    case 5:
      return pipeline.flip().rotate(90);
    case 6:
      return pipeline.rotate(90);
    case 7:
      return pipeline.flip().rotate(270);
    case 8:
      return pipeline.rotate(270);
  }
}

function parseOrientation(value: number | undefined): ImageOrientation | null {
  if (value === undefined) {
    return null;
  }

  if (Number.isInteger(value) && value >= 1 && value <= 8) {
    return value as ImageOrientation;
  }

  throw new InventoryImageNormalizationError(
    "Image contains invalid orientation metadata.",
  );
}

function parseXmpOrientation(xmp: Buffer | undefined): ImageOrientation | null {
  if (!xmp) {
    return null;
  }

  const source = xmp.toString("utf8");
  const attribute = source.match(
    /\b(?:[A-Za-z_][\w.-]*:)?Orientation\s*=\s*["']([1-8])["']/i,
  );
  const element = source.match(
    /<(?:[A-Za-z_][\w.-]*:)?Orientation\b[^>]*>\s*([1-8])\s*<\//i,
  );
  const value = attribute?.[1] ?? element?.[1];

  return value ? (Number(value) as ImageOrientation) : null;
}

export { InventoryImageNormalizationError, normalizeInventoryImage };
