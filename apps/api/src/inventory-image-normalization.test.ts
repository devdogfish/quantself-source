import { describe, expect, it } from "bun:test";
import sharp from "sharp";
import {
  InventoryImageNormalizationError,
  normalizeInventoryImage,
} from "./inventory-image-normalization";

const sourcePixels = Buffer.from([1, 2, 3, 4, 5, 6]);
const expectedPixelsByOrientation = new Map<number, number[]>([
  [1, [1, 2, 3, 4, 5, 6]],
  [2, [2, 1, 4, 3, 6, 5]],
  [3, [6, 5, 4, 3, 2, 1]],
  [4, [5, 6, 3, 4, 1, 2]],
  [5, [1, 3, 5, 2, 4, 6]],
  [6, [5, 3, 1, 6, 4, 2]],
  [7, [6, 4, 2, 5, 3, 1]],
  [8, [2, 4, 6, 1, 3, 5]],
]);

describe("Inventory image normalization", () => {
  for (const [orientation, expectedPixels] of expectedPixelsByOrientation) {
    it(`physically applies EXIF orientation ${orientation}`, async () => {
      const input = await sourceImage().withMetadata({ orientation }).toBuffer();
      const output = await normalizeInventoryImage(input);
      const normalized = await sharp(output)
        .greyscale()
        .raw()
        .toBuffer({ resolveWithObject: true });

      expect(Array.from(normalized.data)).toEqual(expectedPixels);
      expect(normalized.info.width).toBe(orientation >= 5 ? 3 : 2);
      expect(normalized.info.height).toBe(orientation >= 5 ? 2 : 3);

      if (orientation > 1) {
        const metadata = await sharp(output).metadata();
        expect(metadata.orientation).toBeUndefined();
        expect(metadata.xmp).toBeUndefined();
      }
    });
  }

  it("applies PNG XMP orientation when EXIF orientation is absent", async () => {
    const input = await sourceImage()
      .withXmp(xmpWithOrientation(6))
      .toBuffer();
    const output = await normalizeInventoryImage(input);
    const normalized = await sharp(output)
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const metadata = await sharp(output).metadata();

    expect(Array.from(normalized.data)).toEqual(
      expectedPixelsByOrientation.get(6)!,
    );
    expect(metadata.orientation).toBeUndefined();
    expect(metadata.xmp).toBeUndefined();
  });

  it("rejects conflicting EXIF and XMP orientations", async () => {
    const input = await sourceImage()
      .withMetadata({ orientation: 3 })
      .withXmp(xmpWithOrientation(6))
      .toBuffer();

    await expect(normalizeInventoryImage(input)).rejects.toThrow(
      "Image contains conflicting orientation metadata.",
    );
  });

  it("rejects bytes that Sharp cannot decode", async () => {
    await expect(
      normalizeInventoryImage(Buffer.from("not an image")),
    ).rejects.toBeInstanceOf(InventoryImageNormalizationError);
  });
});

function sourceImage() {
  return sharp(sourcePixels, {
    raw: { channels: 1, height: 3, width: 2 },
  }).png();
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
