import type {
  ContainerShelf,
  ContainerShelfItem,
} from "./types";

export type FilteredContainerItems = ReadonlyMap<
  ContainerShelf["id"],
  ContainerShelfItem[]
>;

export function filterContainerItems(
  containers: ContainerShelf[],
  query: string,
): FilteredContainerItems {
  const terms = searchTerms(query);

  return new Map(
    containers.map((container) => [
      container.id,
      terms.length === 0
        ? container.items
        : container.items.filter((item) => itemMatches(item, terms)),
    ]),
  );
}

export function countFilteredItems(
  filteredItems: FilteredContainerItems,
): number {
  let count = 0;

  for (const items of filteredItems.values()) {
    count += items.length;
  }

  return count;
}

function searchTerms(query: string): string[] {
  return query
    .trim()
    .toLocaleLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

function itemMatches(
  item: ContainerShelfItem,
  terms: string[],
): boolean {
  const searchable = [
    item.title,
    item.textPreview,
    item.hasAudio ? "audio voice recording" : "",
    item.imageId ? "image photo" : "",
  ]
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase();

  return terms.every((term) => searchable.includes(term));
}
