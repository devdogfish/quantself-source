import { FilterSelect } from "@/components/shared/filter-select";
import { CheckIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Field, VisuallyHidden, chakra } from "@chakra-ui/react";
import type { Receipt } from "../budgeting-client";
import { documentMoney } from "./document-format";
import { paperAges, receiptPaperStyle, type PaperAge } from "./receipt-paper-edge";
import styles from "./receipt-paper.module.css";

type PrintedLine = Receipt["lines"][number];
type Section = "header" | "items" | "totals" | "payment" | "footer";
type ReceiptBlock = { section: Section; lines: PrintedLine[] };

const subtotal = /^(?:sub[ -]?total|sous[ -]?total|(?:(?:total\s+)?(?:tax(?:es)?|tps|tvq|tva|gst|hst|pst|qst|tps\/tvh|tvh))\b|(?:discount|savings|coupon|rabais|remise|escompte|rounding|arrondi|tip|gratuity|pourboire)\b|(?:total (?:savings|discounts?|tax(?:es)?)|your total savings)\b)/i;
const total = /^(?:(?:grand |order |receipt |montant )?total(?: (?:sale|due|paid|charged|ttc))?|amount due|balance due|montant (?:d[uû]|[àa] payer))\s*[:.=]*\s*$/i;
const payment = /^(?:cash(?: tendered)?|tender(?:ed)?|amount paid|payment(?: (?:amount|method))?|paid by|visa|master\s?card|amex|american express|debit(?: card)?|credit(?: card)?|interac|change(?: due)?|monnaie|comptant|esp[eè]ces|paiement|carte(?: de (?:cr[eé]dit|d[eé]bit))?|gift card)\b/i;
const footer = /^(?:thank(?:s| you)|merci|approved|approuv[eé]|customer copy|merchant copy|copie (?:client|marchand)|keep this receipt|please retain|no signature|refund policy)\b/i;
const itemsHeading = /^(?:items?|description|article|produit)\b.*\b(?:amount|price|prix|montant|qty|quantit[eé])\b/i;
const dateLabel = /\b(?:\d{1,4}\s*[-/.]\s*\d{1,2}\s*[-/.]\s*\d{1,4}|(?:jan|feb|f[eé]v|mar|apr|avr|may|mai|jun|juin|jul|juil|aug|ao[uû]t|sep|oct|nov|d[eé]c)[\p{L}.]*[\s-]+\d{1,2}|\d{1,2}[\s-]+(?:jan|feb|f[eé]v|mar|apr|avr|may|mai|jun|juin|jul|juil|aug|ao[uû]t|sep|oct|nov|d[eé]c)[\p{L}.]*)\b/iu;
const terminalLine = /^(?:aid|tvr|tsi|arc|arqc|cvm|app(?:lication)? id|auth(?:orization)?|ref(?:erence)?|terminal|response|entry|account|customer|patient|card (?:no|number))\b|^A[0-9A-F]{10,}\b/i;
const purchaseTime = /^(?:(?:purchase |transaction )?time\s*[:=]?\s*|(?:\d{2,4}[-/.]\d{1,2}[-/.]\d{1,4})[T\s]+)?((?:[01]?\d|2[0-3]):[0-5]\d)(?::[0-5]\d)?(?:\s*([ap]m))?$/i;
const paymentMethod = /^(visa|master\s?card|amex|american express|interac|debit|credit|cash|gift card)(?:\s+(?:credit|debit|card|payment|tendered))*\s*(?:[-–]\s*thank you)?\s*[:.]*$/i;

const labels = {
  header: "Printed store and transaction details",
  items: "Printed receipt lines",
  totals: "Printed totals and adjustments",
  payment: "Payment details",
  footer: "Receipt notes",
} satisfies Record<Section, string>;

function printedSections(receipt: Receipt) {
  const lines = receipt.lines.filter(line => line.text.trim() || line.amount !== null);
  const merchantIndex = lines.slice(0, 4).findIndex(line =>
    line.amount === null && line.text.trim().toLocaleLowerCase() === receipt.merchant.trim().toLocaleLowerCase());
  const blocks: ReceiptBlock[] = [];
  let section: Section = "header";
  const printedTotals: string[] = [];
  let joinedIndex = -1;

  for (const [index, line] of lines.entries()) {
    if (index === merchantIndex || index === joinedIndex) continue;
    const text = line.text.trim();
    const isTotal = total.test(text);
    const isAdjustment = subtotal.test(text);
    const afterItems = section === "totals" || section === "payment" || section === "footer";
    const tender = text.match(payment);
    const isPayment = tender !== null && (afterItems || /^\s*[:.=]*\s*$/.test(text.slice(tender[0].length)));
    const following = lines[index + 1];
    const detachedAmount = !line.amount && (isTotal || isAdjustment || isPayment) && following && !following.text.trim()
      ? following.amount : null;
    const row = detachedAmount ? { ...line, amount: detachedAmount } : line;
    if (detachedAmount) joinedIndex = index + 1;

    if (isTotal || isAdjustment) section = "totals";
    else if (isPayment && (section !== "header" || row.amount)) section = "payment";
    else if (section !== "header" && footer.test(text)) section = "footer";
    else if (section === "header" && (line.amount || itemsHeading.test(text))) section = "items";

    if (isTotal && row.amount) printedTotals.push(row.amount);
    const current = blocks.at(-1);
    if (current?.section === section) current.lines.push(row);
    else blocks.push({ section, lines: [row] });
  }

  if (printedTotals.length === 0 && receipt.totalCents !== null) {
    const totalBlock = { section: "totals" as const, lines: [{ text: "Total", amount: documentMoney(receipt.totalCents, receipt.currency) }] };
    const paymentStart = blocks.findIndex(block => block.section === "payment" || block.section === "footer");
    if (paymentStart < 0) blocks.push(totalBlock);
    else blocks.splice(paymentStart, 0, totalBlock);
  }
  const differsFromPrinted = receipt.totalCents !== null && printedTotals.length > 0 && !printedTotals.some(amount =>
    /[.,]\s*\d{2}(?!\d)/.test(amount) && Number(amount.replace(/[^\d-]/g, "")) === receipt.totalCents);
  const dateLines = lines.filter(line => dateLabel.test(line.text));
  const hasSavedDate = dateLines.some(({ text }) =>
    [...text.matchAll(/\b(20\d{2})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(\d{1,2})\b/g)].some(([, year, month, day]) =>
      [year, month.padStart(2, "0"), day.padStart(2, "0")].join("-") === receipt.date));
  return { blocks, differsFromPrinted, hasDateLine: dateLines.length > 0, hasSavedDate };
}

export function ReceiptPaper({ receipt }: { receipt: Receipt }) {
  const { blocks, differsFromPrinted, hasDateLine, hasSavedDate } = printedSections(receipt);
  const [detailed, setDetailed] = useState(false);
  const [paperAge, setPaperAge] = useState<PaperAge>("Handled");
  const paperStyle = useMemo(() => receiptPaperStyle(receipt.id, paperAge), [receipt.id, paperAge]);
  const [exporting, setExporting] = useState(false);
  const [exportMessage, setExportMessage] = useState("");
  const copied = exportMessage === "PNG copied.";
  const capture = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setExportMessage(""), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const heading = receipt.title || receipt.merchant || "Receipt";
  const recordedDate = hasDateLine && !hasSavedDate ? receipt.date : null;
  const header = blocks[0]?.section === "header" ? blocks[0].lines : [];
  const times = new Set(header.flatMap(({ text }) => {
    const match = text.trim().match(purchaseTime);
    return match ? [match[1] + (match[2] ? " " + match[2].toUpperCase() : "")] : [];
  }));
  const time = times.size === 1 ? [...times][0] : null;
  const method = [...header, ...blocks.filter(block => block.section === "payment").flatMap(block => block.lines)]
    .map(line => line.text.trim().match(paymentMethod)?.[1])
    .find(Boolean);
  const summary = blocks.flatMap(({ section, lines }) => {
    if (section === "items") return lines.filter(line => line.amount && /\p{L}/u.test(line.text) && !terminalLine.test(line.text));
    if (section === "totals") return lines.filter(line => line.amount && subtotal.test(line.text));
    return [];
  });
  const displayDate = receipt.date && new Intl.DateTimeFormat("en-CA", {
    dateStyle: "medium", timeZone: "UTC",
  }).format(new Date(receipt.date + "T00:00:00Z"));

  async function exportPng(copy: boolean) {
    const node = capture.current;
    if (!node || exporting) return;
    setExporting(true);
    setExportMessage("");
    const png = import("html-to-image").then(async ({ toBlob }) => {
      const expansion = node.querySelector("[data-open]");
      await Promise.allSettled(expansion?.getAnimations().map(animation => animation.finished) ?? []);
      const blob = await toBlob(node, { pixelRatio: 2, skipFonts: true,
        filter: element => !element.matches?.('[data-open="false"], [data-copy-feedback]'),
      });
      if (!blob) throw Error("PNG unavailable");
      return blob;
    });
    try {
      if (copy && typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
        await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
        setExportMessage("PNG copied.");
      } else if (copy) {
        await png;
        setExportMessage("Clipboard unavailable. Use Download PNG.");
      } else {
        const url = URL.createObjectURL(await png);
        const link = document.createElement("a");
        link.href = url;
        link.download = "receipt-" + (receipt.date ?? receipt.id) + ".png";
        link.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
        setExportMessage("PNG ready.");
      }
    } catch {
      setExportMessage(copy ? "Couldn’t copy PNG. Try Download PNG." : "Couldn’t create PNG. Try again.");
    } finally {
      // Clipboard permission can fail before the image promise finishes.
      await png.catch(() => undefined);
      setExporting(false);
    }
  }

  const showExportMessage = !exporting && Boolean(exportMessage) && !copied && exportMessage !== "PNG ready.";
  return <figure className={styles.preview}>
    <div className={styles.controls}>
      <div role="group" aria-label="Receipt view" className={styles.views}>
        <Button size="sm" variant={detailed ? "ghost" : "subtle"} aria-pressed={!detailed} disabled={exporting} onClick={() => { setDetailed(false); setExportMessage(""); }}>Compact</Button>
        <Button size="sm" variant={detailed ? "subtle" : "ghost"} aria-pressed={detailed} aria-controls={receipt.id + "-scan-details"} disabled={exporting} onClick={() => { setDetailed(true); setExportMessage(""); }}>Detailed</Button>
      </div>
      <div className={styles.views}>
        <Button size="sm" variant="outline" disabled={exporting} onClick={() => void exportPng(true)}>Copy PNG</Button>
        <Button size="sm" variant="ghost" disabled={exporting} onClick={() => void exportPng(false)}>Download PNG</Button>
      </div>
    </div>
    <div ref={capture} className={styles.capture}>
      <article aria-label="Receipt reconstruction" className={styles.paper} style={paperStyle}>
        <header className={styles.masthead}>
          <h2>{heading}</h2>
          {(displayDate || time || method) && <p className={styles.meta}>
            {displayDate && <time dateTime={receipt.date ?? undefined}>{displayDate}</time>}
            {time && <span>{time}</span>}
            {method && <span>{method.toUpperCase() === "VISA" ? "Visa" : method}</span>}
          </p>}
        </header>
        <section className={styles.section} data-section="items" aria-label="Purchase breakdown">
          {summary.length ? summary.map((line, index) => <div key={index} className={styles.summaryRow} data-adjustment={subtotal.test(line.text.trim()) || undefined}><span>{line.text}</span><span>{line.amount}</span></div>)
            : <p className={styles.empty}>No itemized amounts captured.</p>}
        </section>
        <div className={styles.grandTotal}><span>Total</span><strong>{receipt.totalCents === null ? "Unreadable" : documentMoney(receipt.totalCents, receipt.currency)}</strong></div>
        <div className={styles.expansion} data-open={detailed} inert={!detailed} aria-hidden={!detailed}>
          <section id={receipt.id + "-scan-details"} className={styles.detail} aria-label="Captured scan details">
            {blocks.map((block, index) => <section key={index} className={styles.section} data-section={block.section}>
              <table className={styles.rows}>
                <VisuallyHidden asChild><caption>{labels[block.section]}</caption></VisuallyHidden>
                <tbody>{block.lines.map((line, lineIndex) => <tr key={lineIndex} data-total={total.test(line.text.trim()) || undefined}>
                  {line.amount ? <>
                    <td>{line.text}</td>
                    <td className={styles.amount}>{line.amount}</td>
                  </> : <td colSpan={2}>{line.text}</td>}
                </tr>)}</tbody>
              </table>
            </section>)}
            {blocks.length === 0 && <p className={styles.empty}>No receipt lines captured.</p>}
            {(recordedDate || differsFromPrinted) && <div className={styles.recordedDetails}>
              {recordedDate && <p>Recorded date <time dateTime={recordedDate}>{recordedDate}</time></p>}
              {differsFromPrinted && receipt.totalCents !== null && <p>Recorded total <strong>{documentMoney(receipt.totalCents, receipt.currency)}</strong></p>}
            </div>}
          </section>
        </div>
      </article>
      {copied && <div className={`${styles.paper} ${styles.copyFeedback}`} style={receiptPaperStyle(receipt.id, paperAge, true)} data-copy-feedback="" aria-hidden="true">
        <CheckIcon size={22} />
        <span>Copied</span>
      </div>}
    </div>
    <chakra.p role="status" className={styles.status} srOnly={!showExportMessage}>
      {exporting ? "Preparing PNG…" : exportMessage}
    </chakra.p>
    <details className={styles.debug}>
      <summary>Debug</summary>
      <Field.Root orientation="horizontal" mt="2" width="fit-content" disabled={exporting}><Field.Label>Paper age</Field.Label>
        <FilterSelect
          label="Paper age"
          size="xs"
          w="auto"
          highlightActive={false}
          disabled={exporting}
          value={paperAge}
          onChange={(value) => setPaperAge(value as PaperAge)}
          items={paperAges.map((age) => ({ value: age, label: age }))}
        />
      </Field.Root>
    </details>
  </figure>;
}
