import { extractReceiptText, parseReceiptDate, parseReceiptText } from "./budget-receipt-scan";
import { printedBudgetCurrency, receiptInput } from "./budgeting";

const money = /(?:^|\s)([−-]?\s*(?:(?:CA|US|C)?\$\s*)?(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2})(?=\s|$)/g;
const summaryLabel = /^(?:subtotal|invoice subtotal|shipping(?: charges)?|discount|tax|GST|HST|PST|QST|grand total|invoice total|amount due|total due|amount paid|total)\b/i;
const sensitiveLabel = /^(?:bill(?:ing)? to|ship(?:ping)? to|recipient|customer|address|phone|e-?mail|payment|account|card)\b/i;

function totalRank(line: string) {
  if (/^(?:grand total|invoice total|total amount due)\b/i.test(line)) return 4;
  if (/^total\b/i.test(line) && !/^total\s+(?:tax|discount|shipping|savings|items|due)\b/i.test(line)) return 3;
  if (/^amount paid\b/i.test(line)) return 2;
  if (/^(?:amount due|total due)\b/i.test(line)) return 1;
  return 0;
}

export function parseBudgetInvoiceText(text: string) {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const amazon = /\bamazon(?:\.com)?\.ca\b/i.test(text);
  const firstLine = lines[0] ?? "";
  const issuer = lines.find(line => /^(?:seller|supplier|vendor|sold by):/i.test(line));
  const merchant = (amazon ? "Amazon" : issuer?.replace(/^[^:]+:\s*/, "") ??
    (/^(?:invoice|facture)\b/i.test(firstLine) || sensitiveLabel.test(firstLine) ? "" : firstLine)).slice(0, 180);
  const labeledDate = (...labels: RegExp[]) => {
    for (const label of labels) {
      for (const line of lines.filter(line => label.test(line))) {
        const parsed = parseReceiptDate(line);
        if (parsed) return parsed;
      }
    }
    return null;
  };
  const printedDate = labeledDate(/^(?:invoice date|date de facturation|issued)\b/i, /^date\s*:/i, /^shipment date\b/i, /^order date\b/i);
  const dueDate = labeledDate(/^(?:due date|payment due|date d[’']échéance)\b/i);
  const invoiceNumber = text.match(/^[\t ]*invoice\s*(?:#|no\.?\s*[:#]?|number\s*[:#]?)\s*(?:\/\s*#\s*de\s*facture\s*)?[:#]?\s*([\w][\w.-]{0,79})[\t ]*$/im)?.[1] ?? null;
  const asins = amazon
    ? new Set([...text.matchAll(/\bASIN\s*:\s*([A-Z0-9]{10})\b/gi)].map(match => match[1].toUpperCase()))
    : new Set<string>();
  const amazonAsin = asins.size === 1 ? [...asins][0] : null;
  const totals = new Map<number, Set<number>>();
  const itemHeading = lines.findIndex(line => /^(?:description|item description|article)\b/i.test(line) && /\b(?:quantity|qty|quantité|price|prix)\b/i.test(line));
  const itemEnd = itemHeading === -1 ? -1 : lines.findIndex((line, index) => index > itemHeading && /^(?:invoice subtotal|subtotal|grand total|total)\b/i.test(line));
  const printableLines = lines.flatMap((line, index) => {
    const inItemTable = itemHeading !== -1 && index > itemHeading && (itemEnd === -1 || index < itemEnd);
    const isSummary = summaryLabel.test(line);
    if ((!inItemTable && !isSummary) || sensitiveLabel.test(line)) return [];
    const amounts = [...line.matchAll(money)];
    const amount = amounts.at(-1)?.[1].trim();
    if (!amount) return [];
    const rank = totalRank(line);
    if (rank) {
      const cents = Math.round(Number(amount.replace("−", "-").replace(/[^\d.-]/g, "")) * 100);
      if (Number.isFinite(cents) && Math.abs(cents) <= 100_000_000) {
        const values = totals.get(rank) ?? new Set<number>();
        values.add(cents);
        totals.set(rank, values);
      }
    }
    return [{ text: line.slice(0, amounts[0].index).trim().slice(0, 300), amount: amount.slice(0, 30) }];
  }).slice(0, 250);

  const best = totals.get(Math.max(...totals.keys()));
  return receiptInput.parse({
    merchant, date: printedDate, totalCents: best?.size === 1 ? [...best][0] : null, lines: printableLines,
    currency: printedBudgetCurrency(text), invoiceNumber, dueDate, amazonAsin,
  });
}

async function poppler(command: string[], file: Uint8Array) {
  const process = Bun.spawn(command, {
    stdin: new Blob([new Uint8Array(file)]),
    stdout: "pipe", stderr: "ignore", timeout: 15_000,
  });
  const [output, code] = await Promise.all([new Response(process.stdout).arrayBuffer(), process.exited]);
  if (code !== 0) throw Error("Could not read PDF.");
  return new Uint8Array(output);
}

export async function extractBudgetDocument(file: Uint8Array, mime: string, kind: "receipt" | "invoice", recognize: (image: Uint8Array) => Promise<string> = extractReceiptText) {
  let text: string;
  if (mime === "application/pdf") {
    const info = new TextDecoder().decode(await poppler(["pdfinfo", "-"], file));
    const pages = Number(info.match(/^Pages:\s+(\d+)/m)?.[1]);
    if (!Number.isInteger(pages) || pages < 1 || pages > 8) throw Error("PDF processing supports up to eight pages; original remains saved.");
    const parts: string[] = [];
    for (let page = 1; page <= pages; page++) {
      const n = String(page);
      const bytes = await poppler(["pdftotext", "-f", n, "-l", n, "-layout", "-", "-"], file);
      let pageText = new TextDecoder().decode(bytes).trim();
      if (!pageText) {
        const image = await poppler(["pdftoppm", "-gray", "-png", "-f", n, "-l", n, "-singlefile", "-scale-to", "3200", "-"], file);
        pageText = await recognize(image);
      }
      parts.push(pageText);
    }
    text = parts.join("\n\n");
  } else {
    text = await recognize(file);
  }
  return kind === "invoice" ? parseBudgetInvoiceText(text) : parseReceiptText(text);
}
