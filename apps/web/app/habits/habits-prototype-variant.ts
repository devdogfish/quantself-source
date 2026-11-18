export type Variant = "A" | "B" | "C";

export function prototypeVariant(value: unknown): Variant | undefined {
  if (process.env.NODE_ENV === "production") return undefined;
  return value === "A" || value === "B" || value === "C" ? value : undefined;
}
