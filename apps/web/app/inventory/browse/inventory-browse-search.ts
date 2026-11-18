import { buildInventorySearchCorpus } from "@/lib/inventory-search";

type InventoryBrowseSearchItem = {
  acquisitionSource: string | null;
  aliases: string[];
  captureText?: string | null;
  category: string | null;
  costCents: number | null;
  costCurrency: string;
  images: Array<{
    caption?: string | null;
    ocrText?: string | null;
    originalName?: string | null;
  }>;
  importance: string;
  kind: string;
  note: string | null;
  searchText: string;
  status: string;
  tags: string[];
  title: string | null;
};

type InventoryBrowseSearchTextBundle = {
  captureText: string | null;
  mediaTexts: Array<{
    ocrLines?: string[] | null;
    ocrText?: string | null;
    transcript?: string | null;
    transcriptSegments?: Array<{ text: string }> | null;
  }>;
};

export function buildInventoryBrowseSearchCorpus(
  item: InventoryBrowseSearchItem,
  textBundle: InventoryBrowseSearchTextBundle | null,
): string {
  const estimatedValue =
    item.costCents === null
      ? null
      : `${item.costCurrency.toUpperCase()} ${(item.costCents / 100).toFixed(2)}`;
  const mediaText =
    textBundle?.mediaTexts.flatMap((entry) => [
      entry.ocrText,
      ...(entry.ocrLines ?? []),
      entry.transcript,
      ...(entry.transcriptSegments?.map((segment) => segment.text) ?? []),
    ]) ?? [];

  return buildInventorySearchCorpus([
    item.title,
    item.note,
    item.captureText,
    item.searchText,
    item.acquisitionSource,
    item.category,
    item.kind,
    item.status,
    item.importance,
    estimatedValue,
    item.costCents === null ? null : String(item.costCents),
    ...item.tags,
    ...item.aliases,
    ...item.images.flatMap((image) => [
      image.originalName,
      image.caption,
      image.ocrText,
    ]),
    textBundle?.captureText,
    ...mediaText,
  ]);
}
