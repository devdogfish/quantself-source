/** Currency amounts are integer minor units. CAD is the reporting currency. */
export const currencies = ["CAD", "USD", "EUR", "CHF", "GBP", "AUD", "NZD", "JPY", "CNY", "SEK", "NOK", "DKK", "KWD", "BHD"] as const;
export type Currency = typeof currencies[number];
export type Money = { amountMinor: number; currency: Currency };
export type FxQuote = { base: Currency; quote: Currency; rate: string; requestedDate: string; rateDate: string; fetchedAt: string; source: "frankfurter-v2"; provider?: "ecb" | "blended" };
export type Conversion = { original: Money; converted: Money; quote: FxQuote | null; estimated: boolean };
export function minorDigits(currency: Currency) { return currency === "JPY" ? 0 : currency === "KWD" || currency === "BHD" ? 3 : 2; }
export function formatMoney(value: Money) { return new Intl.NumberFormat("en-CA", { style: "currency", currency: value.currency }).format(value.amountMinor / 10 ** minorDigits(value.currency)); }
export function decimalMoney(value: Money) { return (value.amountMinor / 10 ** minorDigits(value.currency)).toFixed(minorDigits(value.currency)); }
export function parseMoney(value: string, currency: Currency): number {
  const digits = minorDigits(currency);
  if (!new RegExp(`^-?\\d+(?:\\.\\d{1,${Math.max(digits, 1)}})?$`).test(value.trim()) || (digits === 0 && value.includes("."))) throw Error(`Enter a ${currency} amount with at most ${digits} decimals.`);
  const negative = value.trim().startsWith("-");
  const [whole, fraction = ""] = value.trim().replace(/^-/, "").split(".");
  const result = Number(BigInt(whole) * BigInt(10) ** BigInt(digits) + BigInt(fraction.padEnd(digits, "0") || "0")) * (negative ? -1 : 1);
  if (!Number.isSafeInteger(result) || Math.abs(result) > 100_000_000) throw Error("Amount exceeds the supported range.");
  return result;
}
/** Exact decimal multiplication, rounding half away from zero once at target minor units. */
export function convertMoney(money: Money, target: Currency, rate: string): Money {
  if (!Number.isSafeInteger(money.amountMinor)) throw Error("Money must be integer minor units.");
  const match = rate.match(/^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i);
  if (!match || !Number.isFinite(Number(rate)) || Number(rate) <= 0) throw Error("Invalid exchange rate.");
  const fraction = match[2] ?? "";
  const power = Number(match[3] ?? 0) - fraction.length + minorDigits(target) - minorDigits(money.currency);
  if (Math.abs(power) > 100) throw Error("Invalid exchange rate precision.");
  let numerator = BigInt(Math.abs(money.amountMinor)) * BigInt(match[1] + fraction);
  const divisor = power < 0 ? BigInt(10) ** BigInt(-power) : BigInt(1);
  if (power > 0) numerator *= BigInt(10) ** BigInt(power);
  const rounded = (numerator + divisor / BigInt(2)) / divisor;
  const amountMinor = Number(rounded) * Math.sign(money.amountMinor);
  if (!Number.isSafeInteger(amountMinor) || Math.abs(amountMinor) > 100_000_000) throw Error("Converted amount exceeds the supported range.");
  return { amountMinor, currency: target };
}
