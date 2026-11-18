import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/** Twilio signs the exact public URL followed by sorted POST fields. Reject
 * duplicate keys rather than interpreting a differently signed form. */
export function validateTwilioSignature(url: string, form: URLSearchParams, signature: string | null, token: string): boolean {
  if (!signature || !token || [...form.keys()].length !== new Set(form.keys()).size) return false;
  const message = url + [...form.keys()].sort().map(key => key + form.get(key)).join("");
  const expected = createHmac("sha1", token).update(message).digest("base64");
  const supplied = Buffer.from(signature);
  const target = Buffer.from(expected);
  return supplied.length === target.length && timingSafeEqual(supplied, target);
}

/** Offline provisioning helper. Persist only the returned salted hash. */
export function hashPhonePin(pin: string): string {
  if (!/^\d{6,12}$/.test(pin)) throw new Error("Phone PIN must contain 6–12 digits");
  const salt = randomBytes(16).toString("hex");
  return `scrypt:${salt}:${scryptSync(pin, salt, 32).toString("hex")}`;
}
export function verifyPhonePin(pin: string, stored: string): boolean {
  if (!/^\d{6,12}$/.test(pin)) return false;
  const match = /^scrypt:([a-f0-9]{32}):([a-f0-9]{64})$/.exec(stored);
  if (!match) return false;
  return timingSafeEqual(scryptSync(pin, match[1]!, 32), Buffer.from(match[2]!, "hex"));
}
export const PHONE_HANGUP = '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>';
export function phonePinPrompt(actionUrl: string): string {
  const action = actionUrl.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Gather input="dtmf" action="${action}" method="POST" timeout="8" finishOnKey="#" actionOnEmptyResult="true"><Say>Enter your PIN, then press pound.</Say></Gather><Hangup/></Response>`;
}
