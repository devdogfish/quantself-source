import { createHash } from "node:crypto";

type JsonRecord = Record<string, unknown>;

export function fingerprintIdempotentRequest(request: JsonRecord) {
  return createHash("sha256")
    .update(JSON.stringify(normalizeJsonValue(request)))
    .digest("hex");
}

function normalizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeJsonValue(entry));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as JsonRecord)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalizeJsonValue(entry)]),
    );
  }

  return value ?? null;
}
