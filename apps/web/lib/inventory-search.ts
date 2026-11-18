export type InventorySearchValue = string | null | undefined;

export function normalizeInventorySearchText(
  value: InventorySearchValue,
): string {
  return (
    value
      ?.toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim() ?? ""
  );
}

export function inventorySearchTerms(query: InventorySearchValue): string[] {
  const normalized = normalizeInventorySearchText(query);

  return normalized ? [...new Set(normalized.split(/\s+/))] : [];
}

export function buildInventorySearchCorpus(
  values: InventorySearchValue[],
): string {
  return values
    .filter((value): value is string => Boolean(value?.trim()))
    .join(" ");
}

export function matchesInventorySearchQuery(
  searchable: InventorySearchValue,
  query: InventorySearchValue,
): boolean {
  const corpus = normalizeInventorySearchText(searchable);

  return inventorySearchTerms(query).every((term) => corpus.includes(term));
}
