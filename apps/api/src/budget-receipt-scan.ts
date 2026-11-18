import sharp from "sharp";
import { date, printedBudgetCurrency, receiptInput } from "./budgeting";

// End-of-line amounts may use decimal commas, a currency suffix, or OCR whitespace.
const amountPattern = /(?:^|[\s:])((?:CAD|USD|EUR|GBP|CA\$|US\$|\$|€|£)?\s*-?\s*(?:\d{1,3}(?:[ ,.'’]\d{3})+|\d+)\s*[.,]\s*\d{2}\s*(?:CAD|USD|EUR|GBP|CA\$|US\$|\$|€|£)?)(?:\s+[A-Z]{1,2})?\s*$/i;
const monthNames = [
  "jan(?:uary|vier)?", "feb(?:ruary)?|fev(?:r(?:ier)?)?", "mar(?:ch|s)?", "apr(?:il)?|avr(?:il)?",
  "may|mai", "jun(?:e)?|juin", "jul(?:y)?|juil(?:let)?", "aug(?:ust)?|aout", "sep(?:t(?:ember|embre)?)?",
  "oct(?:ober|obre)?", "nov(?:ember|embre)?", "dec(?:ember|embre)?",
];
const namedMonth = monthNames.map(month => `(?:${month})`).join("|");
const monthFirst = new RegExp(`\\b(${namedMonth})[.\\s-]+(\\d{1,2})(?:st|nd|rd|th)?[,.\\s-]+(20\\d{2})\\b`, "i");
const dayFirst = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?[.\\s-]+(${namedMonth})[,.\\s-]+(20\\d{2})\\b`, "i");
const monthLookup = monthNames.map(month => new RegExp(`^(?:${month})$`, "i"));

function isoDate(year: string, month: string | number, day: string) {
  const value = `${year}-${String(month).padStart(2, "0")}-${day.padStart(2, "0")}`;
  const parsed = date.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function parseReceiptDate(text: string) {
  const normalized = text.normalize("NFKD").replace(/\p{Mark}/gu, "");
  for (const match of normalized.matchAll(/\b(20\d\d)\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(\d{1,2})(?=\b|T\d{2}:)/g)) {
    const value = isoDate(match[1], match[2], match[3]);
    if (value) return value;
  }
  const mdy = normalized.match(monthFirst);
  if (mdy) return isoDate(mdy[3], monthLookup.findIndex(month => month.test(mdy[1])) + 1, mdy[2]);
  const dmy = normalized.match(dayFirst);
  if (dmy) return isoDate(dmy[3], monthLookup.findIndex(month => month.test(dmy[2])) + 1, dmy[1]);
  // Numeric month/day order is ambiguous unless one component exceeds 12.
  for (const [, first, second, shortYear] of normalized.matchAll(/\b(\d{1,2})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(20\d{2}|\d{2})\b/g)) {
    const year = shortYear.length === 2 ? "20" + shortYear : shortYear;
    const value = Number(first) > 12 ? isoDate(year, second, first) : Number(second) > 12 ? isoDate(year, first, second) : null;
    if (value) return value;
  }
  return null;
}

function amountCents(value: string) {
  const numeric = value.replace(/[^\d.,-]/g, "");
  const cents = Number(numeric.replace(/[.,]/g, ""));
  return Number.isSafeInteger(cents) && Math.abs(cents) <= 100_000_000 ? cents : null;
}

function totalRank(label: string) {
  if (/\b(?:sub[ -]?total|total (?:tax|items?|savings|discount|quantity)|tax total|change|tendered)\b/i.test(label)) return 0;
  if (/\b(?:grand total|order total|invoice total|total (?:paid|charged)|montant total)\b/i.test(label)) return 4;
  if (/\b(?:amount due|total due|balance due|montant (?:du|à payer))\b/i.test(label)) return 2;
  if (/\btotal\b/i.test(label)) return 3;
  if (/^(?:amount paid|payment (?:amount|total)|debit|credit|visa|mastercard|amex)\s*[:=]?$/i.test(label.trim())) return 1;
  return 0;
}

const identifierLabel = /\b(?:loyalty|member(?:ship)? (?:id|number)|card (?:number|no\.?|ending)|account (?:number|no\.?|id)|auth(?:orization)? (?:code|number)|terminal (?:id|number)|customer (?:name|address|id|number)|(?:bill(?:ed|ing)?|ship(?:ped|ping)?) to|e-?mail|phone(?: number)?)\b/i;
const emailOrMaskedCard = /[\w.+-]+@[\w.-]+\.[a-z]{2,}|(?:[xX*•]{2,}[-\s]*){1,}\d{4}\b/i;
const printedAmountLabel = /^(?:sub[ -]?total|sous[ -]?total|(?:total )?(?:sales )?tax(?: total)?|[gh]st|pst|qst|tps|tv[qp]|discount|savings|change(?: due)?|tender(?:ed)?|cash)\b/i;

export function parseReceiptText(text: string) {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(0, 250);
  const splitRows = lines.map(line => {
    const match = line.match(amountPattern);
    return { text: match ? line.slice(0, match.index).trim() : line, amount: match?.[1].trim() ?? null };
  });
  const rows: typeof splitRows = [];
  for (const [index, row] of splitRows.entries()) {
    if (identifierLabel.test(lines[index]) || emailOrMaskedCard.test(lines[index])) continue;
    const previous = splitRows[index - 1];
    if (!row.text && row.amount !== null && previous?.amount === null && rows.at(-1) === previous
      && (totalRank(previous.text) || printedAmountLabel.test(previous.text))) {
      rows[rows.length - 1] = { ...previous, amount: row.amount };
    } else {
      rows.push(row);
    }
  }
  const totals = new Map<number, Set<number>>();
  for (const row of rows) {
    const rank = totalRank(row.text);
    if (!rank || row.amount === null) continue;
    const value = amountCents(row.amount);
    if (value === null) continue;
    const values = totals.get(rank) ?? new Set<number>();
    values.add(value);
    totals.set(rank, values);
  }
  const bestRank = Math.max(...totals.keys());
  const bestTotals = totals.get(bestRank);
  const printedCurrencies = new Set(lines.flatMap(line => {
    const currency = printedBudgetCurrency(line);
    return currency ? [currency] : [];
  }));
  const currency = printedBudgetCurrency(rows.flatMap(row => totalRank(row.text) === bestRank && row.amount !== null ? [row.text + " " + row.amount] : []).join("\n"))
    ?? printedBudgetCurrency(text);
  const merchant = rows.slice(0, 4).find(row =>
    row.amount === null && /\p{L}{2}/u.test(row.text) &&
    !/^(?:invoice|receipt|sales receipt|tax invoice|welcome|thank you)\b/i.test(row.text) &&
    !parseReceiptDate(row.text)
  )?.text ?? "";
  return receiptInput.parse({
    merchant: merchant.slice(0, 180),
    date: parseReceiptDate(lines.join("\n")),
    totalCents: bestTotals?.size === 1 && (currency !== null || printedCurrencies.size < 2) ? [...bestTotals][0] : null,
    currency,
    lines: rows.map(row => ({ text: row.text.slice(0, 300), amount: row.amount?.slice(0, 30) ?? null })),
  });
}

type WordBox = { text: string; left: number; top: number; right: number; bottom: number; confidence: number };

function lineFromWords(words: WordBox[]) {
  return {
    words,
    left: Math.min(...words.map(word => word.left)),
    right: Math.max(...words.map(word => word.right)),
    top: Math.min(...words.map(word => word.top)),
    bottom: Math.max(...words.map(word => word.bottom)),
  };
}

export function receiptTextFromTsv(tsv: string) {
  const byLine = new Map<string, WordBox[]>();
  for (const row of tsv.split(/\r?\n/)) {
    const cells = row.split("\t");
    if (cells[0] !== "5" || !cells[11]?.trim()) continue;
    const [left, top, width, height, confidence] = cells.slice(6, 11).map(Number);
    if (![left, top, width, height, confidence].every(Number.isFinite) || width <= 0 || height <= 0) continue;
    const key = cells.slice(1, 5).join(":");
    const words = byLine.get(key) ?? [];
    words.push({ text: cells.slice(11).join("\t").trim(), left, top, right: left + width, bottom: top + height, confidence });
    byLine.set(key, words);
  }
  const lines = [...byLine.values()].map(lineFromWords).sort((a, b) => a.top - b.top || a.left - b.left);
  const rows: typeof lines = [];
  for (const line of lines) {
    // Tesseract can emit the price column as a separate block. Rejoin visually aligned segments.
    const neighbor = rows.slice(-3).findLast(row => {
      const overlap = Math.min(row.bottom, line.bottom) - Math.max(row.top, line.top);
      return (row.right <= line.left || line.right <= row.left)
        && overlap >= 0.65 * Math.min(row.bottom - row.top, line.bottom - line.top);
    });
    if (neighbor) Object.assign(neighbor, lineFromWords([...neighbor.words, ...line.words]));
    else rows.push(line);
  }
  const words = [...byLine.values()].flat();
  return {
    text: rows.map(row => row.words.sort((a, b) => a.left - b.left).map(word => word.text).join(" ")).join("\n"),
    confidence: words.length ? words.reduce((total, word) => total + word.confidence, 0) / words.length : 0,
  };
}

async function recognize(input: Uint8Array, segmentation: "3" | "6" | "11") {
  const process = Bun.spawn(["tesseract", "stdin", "stdout", "-l", "eng", "--psm", segmentation, "tsv"], {
    stdin: new Blob([new Uint8Array(input)]), stdout: "pipe", stderr: "ignore", timeout: 7000,
    env: { ...Bun.env, OMP_THREAD_LIMIT: "1" },
  });
  const [tsv, code] = await Promise.all([new Response(process.stdout).text(), process.exited]);
  const result = receiptTextFromTsv(code === 0 ? tsv : "");
  return { ...result, fields: parseReceiptText(result.text) };
}

async function recognizeWithVision(image: Uint8Array) {
  if (process.platform !== "darwin") return null;
  const swift = Bun.which("swift");
  const script = Bun.file(new URL("../scripts/receipt-vision.swift", import.meta.url));
  if (!swift || !await script.exists()) return null;
  try {
    const process = Bun.spawn([swift, script.name!], {
      stdin: new Blob([new Uint8Array(image)]), stdout: "pipe", stderr: "ignore", timeout: 6000,
    });
    const [tsv, code] = await Promise.all([new Response(process.stdout).text(), process.exited]);
    if (code !== 0) return null;
    const result = receiptTextFromTsv(tsv);
    return result.text.trim() ? { ...result, fields: parseReceiptText(result.text) } : null;
  } catch {
    return null;
  }
}

async function receiptRecognition(image: Uint8Array) {
  const vision = await recognizeWithVision(image);
  if (vision?.fields.date && vision.fields.totalCents !== null) return { best: vision, attempts: [vision] };

  const input = await sharp(image, { limitInputPixels: 40_000_000 }).autoOrient().resize({ width: 1800, withoutEnlargement: true }).greyscale().png().toBuffer();
  const first = await recognize(input, "3");
  const attempts = vision ? [vision, first] : [first];
  const needsFields = () => !attempts.some(attempt => attempt.fields.date)
    || !attempts.some(attempt => attempt.fields.totalCents !== null);
  if (needsFields()) {
    const enhanced = await sharp(input).normalise().sharpen().png().toBuffer();
    attempts.push(await recognize(enhanced, "6"));
    if (needsFields()) attempts.push(await recognize(enhanced, "11"));
  }
  const score = (attempt: typeof first) =>
    Number(attempt.fields.date !== null) * 4 + Number(attempt.fields.totalCents !== null) * 5
    + Math.min(attempt.fields.lines.filter(line => line.amount).length, 8) / 8 + attempt.confidence / 100;
  const best = attempts.reduce((prior, attempt) => score(attempt) > score(prior) ? attempt : prior);
  if (!best.text.trim()) throw Error("Could not read receipt.");
  return { best, attempts };
}

export async function extractReceiptText(image: Uint8Array) {
  return (await receiptRecognition(image)).best.text;
}

export async function extractReceipt(image: Uint8Array) {
  const { best, attempts } = await receiptRecognition(image);
  const dates = new Set(attempts.flatMap(attempt => attempt.fields.date === null ? [] : [attempt.fields.date]));
  const totals = new Set(attempts.flatMap(attempt => attempt.fields.totalCents === null ? [] : [attempt.fields.totalCents]));
  const currencies = new Set(attempts.flatMap(attempt => attempt.fields.currency ? [attempt.fields.currency] : []));
  return {
    ...best.fields,
    date: dates.size === 1 ? [...dates][0] : null,
    totalCents: totals.size === 1 && currencies.size < 2 ? [...totals][0] : null,
    currency: currencies.size === 1 ? [...currencies][0] : null,
  };
}
