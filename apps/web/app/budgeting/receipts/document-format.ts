import { currencies, minorDigits, type Currency } from "@quantself/budgeting";
export const documentKinds = {
  receipt: "Receipt",
  invoice: "Invoice",
  contract: "Contract",
  msa: "Master services agreement",
  sow: "Statement of work",
  other: "Other document",
} as const;

export type DocumentKind = keyof typeof documentKinds;
export type ScanProvenance = "upload_only" | "ocr_completed" | null | undefined;

export function documentScanProvenanceLabel(provenance: ScanProvenance) {
  if (provenance === "upload_only") return "Upload only";
  if (provenance === "ocr_completed") return "OCR completed";
}

export function documentScanStatus(status: string, provenance: ScanProvenance) {
  return status === "archived" ? documentScanProvenanceLabel(provenance) ?? status : status;
}

export function isPurchaseDocument(kind: DocumentKind) {
  return kind === "receipt" || kind === "invoice";
}

export function documentMoney(cents: number, currency: string | null | undefined) {
  return new Intl.NumberFormat("en-CA", { style: "currency", currency: currency ?? "CAD" }).format(cents / 10 ** (currencies.includes(currency as Currency) ? minorDigits(currency as Currency) : 2));
}

export function amazonProductId(value: string) {
  const input = value.trim();
  if (!input) return null;
  if (/^[A-Z0-9]{10}$/i.test(input)) return input.toUpperCase();
  const url = URL.canParse(input) ? new URL(input) : null;
  const asin = url?.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:\/|$)/i)?.[1];
  if (url?.protocol === "https:" && /^(?:www\.)?amazon\.(?:ca|com)$/.test(url.hostname) && asin) return asin.toUpperCase();
  throw Error("Enter an Amazon.ca or Amazon.com product link, or a 10-character ASIN.");
}
