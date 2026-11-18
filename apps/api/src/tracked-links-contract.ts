import { z } from "@hono/zod-openapi";

export const trackedLinkPath = "/api/v1/tracked-links";
export const trackedLinkCode = z.string().min(1).max(24).regex(/^[A-Za-z0-9]+$/);
export const newTrackedLink = z.object({ code: trackedLinkCode.length(8) });

export const trackedLinkTrack = z.enum(["web-cms", "admin-excel", "devops", "frontend", "backend", "full-stack"]);
export const trackedShareTrack = z.enum(["client", ...trackedLinkTrack.options]);

export function normalizeTrackedLinkTrack(track: unknown) {
  return track === "software" ? "backend" : track;
}
const title = z.string().trim().min(1).max(200);
export const trackedApplicationInput = z.strictObject({
  applicationId: z.uuid(),
  company: title,
  role: title,
  // Existing résumé runners can keep registering during the rollout.
  track: z.preprocess(normalizeTrackedLinkTrack, trackedLinkTrack)
    .openapi({ type: "string", enum: trackedLinkTrack.options }),
  revision: z.number().int().positive().max(2_147_483_646),
});
export const trackedShareInput = z.strictObject({ title, track: trackedShareTrack.optional() });
export const trackedLinkLookup = z.discriminatedUnion("kind", [
  z.object({ code: z.string(), kind: z.literal("application"), track: trackedLinkTrack }),
  z.object({ code: z.string(), kind: z.literal("share"), track: trackedShareTrack.nullable() }),
]);
export type TrackedLinkLookup = z.infer<typeof trackedLinkLookup>;
export type TrackedApplicationInput = z.infer<typeof trackedApplicationInput>;
export type TrackedShareInput = z.infer<typeof trackedShareInput>;
