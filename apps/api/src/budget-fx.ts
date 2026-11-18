import { currencies, convertMoney, type Currency, type Money, type FxQuote, type Conversion } from "@quantself/budgeting";
import { z } from "@hono/zod-openapi";
import type { prisma } from "@quantself/db";

export const currencyCode = z.enum(currencies);
export const fxQuoteSchema = z.object({ base: currencyCode, quote: currencyCode, rate: z.string(), requestedDate: z.iso.date(), rateDate: z.iso.date(), fetchedAt: z.iso.datetime(), source: z.literal("frankfurter-v2"), provider: z.enum(["ecb", "blended"]).optional() });
export const moneySchema = z.object({ amountMinor: z.number().int().min(-100_000_000).max(100_000_000), currency: currencyCode });
export const conversionSchema = z.object({ original: moneySchema, converted: moneySchema, quote: fxQuoteSchema.nullable(), estimated: z.boolean() });
export class FxUnavailable extends Error { constructor(message = "Exchange rate unavailable. Nothing was saved; try again later.") { super(message); } }
type Request = { money: Money; target: Currency; date: string };
type RateRow = { base: Currency; quote: Currency; date: string; rate: number };
const responseSchema = z.array(z.object({ base: currencyCode, quote: currencyCode, date: z.iso.date(), rate: z.number().positive().finite() }));
const providerFor = (base: string, quote: string) => [base, quote].some(code => code === "KWD" || code === "BHD") ? "blended" as const : "ecb" as const;
const key = (base: string, quote: string, date: string) => `${providerFor(base, quote)}:${base}:${quote}:${date}`;
const todayLocal = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Halifax" }).format(new Date());
/** Only currency codes and dates leave the application. No amount or identifying data. */
export function createCurrencyConverter(db: Pick<typeof prisma, "budgetFxRate">, fetcher: typeof fetch = fetch, today: () => string = todayLocal) {
  const inflight = new Map<string, Promise<FxQuote[]>>();
  let running = 0;
  const waiting: (() => void)[] = [];
  async function bounded<T>(work: () => Promise<T>) {
    if (running >= 4) await new Promise<void>(resolve => waiting.push(resolve));
    else running++;
    try { return await work(); } finally { const next = waiting.shift(); if (next) next(); else running--; }
  }
  async function load(base: Currency, requested: { quote: Currency; date: string }[]) {
    const quotes = [...new Set(requested.map(row => row.quote))].sort();
    const dates = [...new Set(requested.map(row => row.date))].sort();
    const provider = providerFor(base, quotes[0]);
    const requestKey = JSON.stringify([base, provider, requested]);
    let pending = inflight.get(requestKey);
    if (!pending) {
      pending = bounded(async () => {
        const url = new URL("https://api.frankfurter.dev/v2/rates");
        const range: Record<string, string> = dates.length === 1 ? { date: dates[0] } : {
          from: new Date(Date.parse(dates[0]) - 10 * 86_400_000).toISOString().slice(0, 10), to: dates.at(-1)!,
        };
        url.search = new URLSearchParams({ base, quotes: quotes.join(","), ...(provider === "ecb" ? { providers: "ecb" } : {}), ...range }).toString();
        let rows: RateRow[];
        try {
          const response = await fetcher(url, { signal: AbortSignal.timeout(8_000), headers: { accept: "application/json" } });
          if (!response.ok) throw new FxUnavailable();
          rows = responseSchema.parse(await response.json());
        } catch { throw new FxUnavailable(); }
        const fetchedAt = new Date().toISOString();
        const byQuote = new Map<Currency, RateRow[]>();
        for (const row of rows) if (row.base === base) {
          const bucket = byQuote.get(row.quote) ?? []; bucket.push(row); byQuote.set(row.quote, bucket);
        }
        for (const bucket of byQuote.values()) bucket.sort((a, b) => a.date.localeCompare(b.date));
        const result = requested.map(({ quote, date }) => {
          const matches = byQuote.get(quote) ?? [];
          let low = 0, high = matches.length;
          while (low < high) { const mid = (low + high) >>> 1; if (matches[mid].date <= date) low = mid + 1; else high = mid; }
          const row = matches[low - 1];
          if (!row) throw new FxUnavailable(`No ${base}/${quote} rate available for ${date}. Nothing was saved.`);
          // Reject unexpectedly stale data; ordinary weekends and holiday closures fit within 10 days.
          if (Date.parse(date) - Date.parse(row.date) > 10 * 86_400_000) throw new FxUnavailable("The available exchange rate is too old. Nothing was saved.");
          return { base, quote, rate: String(row.rate), requestedDate: date, rateDate: row.date, fetchedAt, source: "frankfurter-v2" as const, provider };
        });
        await db.budgetFxRate.createMany({ data: result.map(row => ({ key: key(base, row.quote, row.requestedDate), data: row })), skipDuplicates: true });
        // Today's reference rates can be revised; historical cached snapshots remain stable.
        await Promise.all(result.filter(row => row.requestedDate === today()).map(row => db.budgetFxRate.update({ where: { key: key(base, row.quote, row.requestedDate) }, data: { data: row } })));
        return result;
      }).finally(() => inflight.delete(requestKey));
      inflight.set(requestKey, pending);
    }
    return pending;
  }
  return {
    async convertMany(requests: Request[]): Promise<Conversion[]> {
      const effectiveDates = requests.map(request => request.date > today() ? today() : request.date);
      const wanted = new Map<string, { base: Currency; quote: Currency; date: string }>();
      requests.forEach((request, i) => { if (request.money.currency !== request.target && request.money.amountMinor !== 0) wanted.set(key(request.money.currency, request.target, effectiveDates[i]), { base: request.money.currency, quote: request.target, date: effectiveDates[i] }); });
      const cached = wanted.size ? await db.budgetFxRate.findMany({ where: { key: { in: [...wanted.keys()] } }, select: { key: true, data: true } }) : [];
      const quotes = new Map<string, FxQuote>();
      for (const row of cached) {
        const parsed = fxQuoteSchema.safeParse(row.data);
        if (parsed.success && (parsed.data.requestedDate !== today() || Date.now() - Date.parse(parsed.data.fetchedAt) < 6 * 3_600_000)) quotes.set(row.key, parsed.data);
      }
      const groups = new Map<string, { base: Currency; requested: { quote: Currency; date: string }[] }>();
      for (const [k, item] of wanted) if (!quotes.has(k)) {
        const groupKey = `${providerFor(item.base, item.quote)}:${item.base}`;
        const group = groups.get(groupKey) ?? { base: item.base, requested: [] };
        group.requested.push({ quote: item.quote, date: item.date }); groups.set(groupKey, group);
      }
      await Promise.all([...groups.values()].map(async group => { for (const row of await load(group.base, group.requested)) quotes.set(key(row.base, row.quote, row.requestedDate), row); }));
      return requests.map((request, i) => {
        if (request.money.currency === request.target || request.money.amountMinor === 0) return { original: request.money, converted: { ...request.money, currency: request.target }, quote: null, estimated: false };
        const quote = quotes.get(key(request.money.currency, request.target, effectiveDates[i]));
        if (!quote) throw new FxUnavailable();
        return { original: request.money, converted: convertMoney(request.money, request.target, quote.rate), quote, estimated: true };
      });
    },
  };
}
export type CurrencyConverter = ReturnType<typeof createCurrencyConverter>;
