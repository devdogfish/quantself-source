import type { Route } from "next";

export const INVENTORY_ITEM_BACK_FALLBACK = "/inventory/browse";

type SearchParamValue = string | string[] | undefined;

export function sanitizeInventoryItemReturnTo(
  value: SearchParamValue,
): Route {
  const candidate = Array.isArray(value) ? value[0] : value;

  if (
    !candidate ||
    !candidate.startsWith("/") ||
    candidate.startsWith("//") ||
    candidate.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(candidate)
  ) {
    return INVENTORY_ITEM_BACK_FALLBACK;
  }

  try {
    const url = new URL(candidate, "http://inventory.local");

    if (
      url.origin !== "http://inventory.local" ||
      !isAllowedInventoryReturnPath(url.pathname)
    ) {
      return INVENTORY_ITEM_BACK_FALLBACK;
    }

    return `${url.pathname}${url.search}${url.hash}` as Route;
  } catch {
    return INVENTORY_ITEM_BACK_FALLBACK;
  }
}

export function buildInventoryItemHref(
  itemId: string,
  returnTo: string,
): Route {
  const safeReturnTo = sanitizeInventoryItemReturnTo(returnTo);
  const search = new URLSearchParams({ returnTo: safeReturnTo });

  return `/inventory/items/${encodeURIComponent(itemId)}?${search}` as Route;
}

function isAllowedInventoryReturnPath(pathname: string): boolean {
  return (
    pathname === "/inventory" ||
    pathname === "/inventory/archive" ||
    pathname === "/inventory/browse" ||
    pathname === "/inventory/clothing" ||
    pathname === "/inventory/food" ||
    pathname === "/inventory/history" ||
    pathname === "/inventory/processing" ||
    pathname === "/inventory/remedies" ||
    pathname === "/inventory/supplements" ||
    pathname === "/inventory/containers" ||
    /^\/inventory\/containers\/[^/]+$/u.test(pathname)
  );
}
