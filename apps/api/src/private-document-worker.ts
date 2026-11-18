import { createTaskDrain } from "./task-drain";
import { readOriginalBytes } from "./original-files";
import { prisma } from "@quantself/db";
import { extractBudgetDocument } from "./budget-document-scan";
import { PrivateOcrBusyError, recognizePrivateDocument } from "./private-document-ocr";
import { extractReceiptText } from "./budget-receipt-scan";
import { reconcileBankReceipts } from "./budget-bank-import";

const OCR_BUSY_RETRY_MS = 30_000;

/** One job per process; durable leases recover after crashes and coordinate replicas. */
export async function processPrivateDocument(db = prisma, extract = extractBudgetDocument, clock = () => new Date()) {
  const now = clock();
  // Pending rows use scanLeaseUntil as their earliest eligible retry time.
  const eligible = { kind: { in: ["receipt", "invoice"] }, OR: [
    { scanStatus: "pending", OR: [{ scanLeaseUntil: null }, { scanLeaseUntil: { lte: now } }] },
    { scanStatus: "processing", scanLeaseUntil: { lte: now } },
  ] };
  const job = await db.budgetReceipt.findFirst({ where: eligible, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { ownerId: true, id: true } });
  if (!job) return false;
  const lease = crypto.randomUUID();
  const claimed = await db.budgetReceipt.updateMany({ where: { ...job, ...eligible }, data: {
    scanStatus: "processing", scanLeaseId: lease, scanLeaseUntil: new Date(now.getTime() + 10 * 60_000),
  } });
  if (!claimed.count) return true;
  const row = await db.budgetReceipt.findUnique({ where: { ownerId_id: job }, select: { image: true, originalKey: true, mime: true, kind: true } });
  let fields: Awaited<ReturnType<typeof extractBudgetDocument>> | null = null;
  let busy = false;
  try {
    const image = row?.originalKey ? await readOriginalBytes(row.originalKey) : row?.image;
    if (image && row?.mime && (row.kind === "receipt" || row.kind === "invoice"))
      fields = await extract(image, row.mime, row.kind,
        process.env.GIRKE_API_BASE_URL || process.env.GIRKE_API_TOKEN ? recognizePrivateDocument : extractReceiptText);
  } catch (error) {
    busy = error instanceof PrivateOcrBusyError;
    // Deliberately no private payload or processor error logging.
  }
  const finishedAt = clock();
  const owned = { ...job, scanStatus: "processing", scanLeaseId: lease, scanLeaseUntil: { gt: finishedAt } };
  if (busy) {
    await db.budgetReceipt.updateMany({ where: owned, data: {
      scanStatus: "pending", scanLeaseId: null, scanLeaseUntil: new Date(finishedAt.getTime() + OCR_BUSY_RETRY_MS),
    } });
    return true;
  }
  await db.$transaction(async tx => {
    const result = await tx.budgetReceipt.updateMany({ where: owned, data: {
      ...(fields ? { ...fields, scanProvenance: "ocr_completed" } : {}),
      scanStatus: fields ? "archived" : "failed", scanLeaseId: null, scanLeaseUntil: null,
    } });
    if (result.count && fields?.totalCents != null) await reconcileBankReceipts(tx, job.ownerId, [fields.totalCents]);
  });
  return true;
}

export function startPrivateDocumentWorker() {
  const drain = createTaskDrain();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  const tick = () => drain.run(async () => {
    let work = false;
    try { work = await processPrivateDocument(); } catch { /* Retry DB outages; lease protects unfinished work. */ }
    if (!stopped) { timer = setTimeout(tick, work ? 250 : 5_000); timer.unref(); }
  });
  timer = setTimeout(tick, 1_000); timer.unref();
  return () => { stopped = true; clearTimeout(timer); return drain.stop(); };
}
