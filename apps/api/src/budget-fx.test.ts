import { expect, test } from "bun:test";
import { convertMoney, parseMoney, decimalMoney, type Currency } from "@quantself/budgeting";
import { createCurrencyConverter, FxUnavailable } from "./budget-fx";
import { prepareBankRows, identifyBankRows } from "./budget-bank-import";
import { priceSubscriptions, subscription } from "./budget-subscriptions";
import { subscriptionPayments } from "@quantself/budgeting";

function fixture(fetcher: (url: URL) => Promise<Response> = async url => new Response(JSON.stringify(
  (url.searchParams.get("quotes") ?? "").split(",").map(quote => ({ base: url.searchParams.get("base"), quote, date: "2026-11-06", rate: 1.4 }))))) {
  const rows = new Map<string, unknown>(); let reads = 0; let writes = 0; const urls: URL[] = [];
  const db: any = { budgetFxRate: {
    findMany: async ({ where }: any) => { reads++; return [...rows].filter(([key]) => where.key.in.includes(key)).map(([key, data]) => ({ key, data })); },
    createMany: async ({ data }: any) => { writes++; for (const row of data) if (!rows.has(row.key)) rows.set(row.key, row.data); },
    update: async ({ where, data }: any) => { writes++; rows.set(where.key, data.data); },
  } };
  const fx = createCurrencyConverter(db, (async input => { const url = new URL(String(input)); urls.push(url); return fetcher(url); }) as typeof fetch, () => "2026-11-08");
  return { fx, rows, urls, get reads() { return reads; }, get writes() { return writes; } };
}
const request = (amountMinor = 1254, date = "2026-11-07", currency: Currency = "USD") => ({ money: { amountMinor, currency }, target: "CAD" as const, date });
test("money conversion rounds once with decimal arithmetic, signs and currency minor units", () => {
  expect(convertMoney({ amountMinor: 101, currency: "USD" }, "CAD", "1.5").amountMinor).toBe(152);
  expect(convertMoney({ amountMinor: -101, currency: "USD" }, "CAD", "1.5").amountMinor).toBe(-152);
  expect(convertMoney({ amountMinor: 100, currency: "USD" }, "JPY", "150.5").amountMinor).toBe(151);
  expect(convertMoney({ amountMinor: 1000, currency: "KWD" }, "CAD", "4.5").amountMinor).toBe(450);
  expect(convertMoney({ amountMinor: 100, currency: "USD" }, "CAD", "1e-2").amountMinor).toBe(1);
  expect(parseMoney("12.54", "USD")).toBe(1254);
  expect(parseMoney("1.234", "KWD")).toBe(1234);
  expect(decimalMoney({ amountMinor: 1234, currency: "KWD" })).toBe("1.234");
  expect(() => parseMoney("1.5", "JPY")).toThrow();
  expect(() => convertMoney({ amountMinor: 1, currency: "USD" }, "CAD", "0")).toThrow();
});
test("duplicates batch once, cache persistently, weekend conversion reports the actual source date", async () => {
  const f = fixture();
  const result = await f.fx.convertMany(Array.from({ length: 100 }, () => request()));
  expect(f.urls).toHaveLength(1); expect(f.reads).toBe(1); expect(f.writes).toBe(1);
  expect(result[0]).toMatchObject({ original: { amountMinor: 1254, currency: "USD" }, converted: { amountMinor: 1756, currency: "CAD" }, estimated: true, quote: { rateDate: "2026-11-06", requestedDate: "2026-11-07" } });
  expect([...f.urls[0].searchParams.keys()].sort()).toEqual(["base", "date", "providers", "quotes"]);
  await f.fx.convertMany([request()]); expect(f.urls).toHaveLength(1); expect(f.reads).toBe(2);
});
test("multiple transaction dates use one time-series fetch per source currency", async () => {
  const f = fixture();
  await f.fx.convertMany([request(100, "2026-11-06"), request(200, "2026-11-07"), request(300, "2026-11-08")]);
  expect(f.urls).toHaveLength(1); expect(f.urls[0].searchParams.get("from")).toBe("2026-10-27");
  expect(f.urls[0].searchParams.get("to")).toBe("2026-11-08"); expect(f.rows.size).toBe(3);
});
test("future forecast dates use latest reference data; same currency and zero never fetch", async () => {
  const f = fixture();
  expect((await f.fx.convertMany([request(0), request(500, "2026-11-08", "CAD")])).map(row => row.converted.amountMinor)).toEqual([0, 500]);
  expect(f.reads).toBe(0); expect(f.urls).toHaveLength(0);
  expect((await f.fx.convertMany([request(100, "2027-01-01")]))[0].quote?.requestedDate).toBe("2026-11-08");
});
test("missing, stale, malformed and unavailable rates fail explicitly without zero or persistence", async () => {
  for (const response of [new Response("{}"), new Response("[]"), new Response("failure", { status: 503 }), new Response(JSON.stringify([{ base: "USD", quote: "CAD", date: "2020-01-01", rate: 1.4 }]))]) {
    const f = fixture(async () => response);
    await expect(f.fx.convertMany([request()])).rejects.toBeInstanceOf(FxUnavailable);
    expect(f.writes).toBe(0);
  }
});
test("native bank imports preserve source value and stable IDs independent of FX rates", async () => {
  const f = fixture(); const input = { account: "account-1" as const, rows: [{ date: "2026-11-07", merchant: "Example", totalCents: 1254, currency: "USD" as const, flow: "expense" as const }] };
  const prepared = await prepareBankRows("owner", [input], f.fx);
  expect(prepared[0]).toMatchObject({ totalCents: 1756, originalAmountMinor: 1254, originalCurrency: "USD", foodCents: 0 });
  const native = identifyBankRows("owner", input)[0]; expect(prepared[0].id).toBe(native.id);
  expect(identifyBankRows("owner", { ...input, rows: input.rows.map(row => ({ ...row, currency: "CAD" })) })[0].id).not.toBe(native.id);
});
test("foreign subscription forecasts update estimates without changing source terms; free periods work", async () => {
  const item = subscription.parse({ id: crypto.randomUUID(), revision: 1, commandId: crypto.randomUUID(), name: "Domain", status: "active", stopsOn: null, websiteUrl: null, cancelUrl: null, logoKey: null, estimated: true, evidence: "", sourceKey: null,
    terms: [{ effectiveOn: "2026-11-01", startOn: "2026-11-12", amountCents: 1000, currency: "USD", cadAmountCents: 1300, frequency: "yearly", interval: 1 }] });
  const f = fixture(); const priced = await priceSubscriptions([item], f.fx, "2026-11-08");
  expect(item.terms[0].cadAmountCents).toBe(1300); expect(priced[0].terms[0].cadAmountCents).toBe(1400);
  expect(subscriptionPayments(priced[0], "2026-11-08", "2026-12-01")[0].cents).toBe(1400);
  const free = subscription.parse({ ...item, terms: [{ ...item.terms[0], amountCents: 0, cadAmountCents: 0 }] });
  expect(subscriptionPayments(free, "2026-11-08", "2026-12-01")[0].cents).toBe(0);
});

test("outbound work is bounded and identical concurrent conversions share a fetch", async () => {
  let active = 0, peak = 0;
  const f = fixture(async url => {
    active++; peak = Math.max(peak, active);
    await Bun.sleep(5); active--;
    return Response.json((url.searchParams.get("quotes") ?? "").split(",").map(quote => ({ base: url.searchParams.get("base"), quote, date: "2026-11-06", rate: 1.4 })));
  });
  const batch = (["USD", "EUR", "CHF", "GBP", "AUD"] as const).map(currency => request(100, "2026-11-07", currency));
  await Promise.all([f.fx.convertMany(batch), f.fx.convertMany(batch)]);
  expect(f.urls).toHaveLength(5); expect(peak).toBe(4);
});
