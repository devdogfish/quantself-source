import { createHash } from "node:crypto";
import type { JobApplication, Prisma } from "@quantself/db/generated/prisma/client";
import { JobsError } from "./jobs-error";
import type { JobsPrivateSourceRule } from "./jobs-private-source-rules";

export function isExpiredSubmission(row: Pick<JobApplication, "status" | "submitLeaseUntil">, now: Date) {
  return row.status === "submitting" && row.submitLeaseUntil !== null && row.submitLeaseUntil <= now;
}

export function canonicalJobUrl(raw: string, privateRules: readonly JobsPrivateSourceRule[] = []) {
  let url: URL;
  try { url = new URL(raw); } catch { throw new JobsError(400, "A posting URL is invalid."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new JobsError(400, "Use a public HTTP or HTTPS posting URL without credentials.");
  }
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_.+|gclid|fbclid|msclkid|li_fat_id|trk|tracking_?id|ref|referrer|source|gh_src|lever-source|mc_cid|mc_eid)$/i.test(key)) {
      url.searchParams.delete(key);
    }
  }
  url.searchParams.sort();
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  if (!/^#(?:!?\/|[^=&]+=[^&]+$)/.test(url.hash)) url.hash = "";

  // The supported ATS listing and application routes share one posting identity.
  const lever = /^(?:jobs\.lever\.co|jobs\.eu\.lever\.co)$/.test(url.host) &&
    /^\/[a-z\d_-]+\/[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}(?:\/apply)?$/i.test(url.pathname);
  const greenhouse = /^(?:job-)?boards(?:\.eu)?\.greenhouse\.io$/.test(url.host) &&
    /^\/[a-z\d_-]+\/jobs\/\d+$/i.test(url.pathname);
  const ashby = url.host === "jobs.ashbyhq.com" &&
    /^\/[a-z\d_-]+(?:\.[a-z\d_-]+)*\/[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}(?:\/application)?$/i.test(url.pathname);
  const workable = url.host === "apply.workable.com" && /^\/[a-z\d_-]+\/j\/[A-Z\d]+(?:\/apply)?$/i.test(url.pathname);
  const manatal = url.host === "www.careers-page.com" && /^\/[a-z\d_-]+\/job\/[A-Z\d]{8}(?:\/apply)?$/i.test(url.pathname);
  const rippling = url.host === "ats.rippling.com" && url.pathname.match(
    /^\/([a-z\d_-]+)\/jobs\/([a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})(?:\/apply)?$/i,
  );
  const ripplingQuery = new URLSearchParams(url.searchParams);
  if (rippling) {
    // These observed application parameters repeat the URL identity. Mismatched
    // or extra parameters remain significant rather than collapsing another job.
    for (const [key, expected] of [["jobBoardSlug", rippling[1]], ["jobId", rippling[2]], ["step", "application"]]) {
      if (ripplingQuery.getAll(key).length === 1 && ripplingQuery.get(key) === expected) ripplingQuery.delete(key);
    }
  }
  const privateRule = privateRules.find(rule => {
    if (rule.path !== url.pathname || (url.host !== rule.canonicalHost && !rule.aliases.includes(url.host))) return false;
    const ids = url.searchParams.getAll(rule.postingIdParameter);
    return ids.length === 1 && /^\d+$/.test(ids[0]);
  });
  const sourceIdentity = lever
    ? `${url.host}${url.pathname.toLowerCase().replace(/\/apply$/, "")}`
    : greenhouse
      ? `${url.host.replace(/^boards/, "job-boards")}${url.pathname.toLowerCase()}`
      : ashby
        ? `${url.host}${url.pathname.replace(/\/application$/i, "")}${url.search}${url.hash}`
        : workable || manatal
          ? `${url.host}${url.pathname.replace(/\/apply$/i, "")}${url.search}${url.hash}`
          : rippling
            ? `${url.host}${url.pathname.replace(/\/apply$/i, "")}${ripplingQuery.size ? `?${ripplingQuery}` : ""}${url.hash}`
            : `${privateRule?.canonicalHost ?? url.host}${url.pathname}${url.search}${url.hash}`;
  return { sourceUrl: url.href, sourceKey: createHash("sha256").update(sourceIdentity).digest("hex") };
}

export async function readJob(tx: Prisma.TransactionClient, ownerId: string, id: string) {
  const row = await tx.jobApplication.findUnique({ where: { ownerId_id: { ownerId, id } } });
  if (!row) throw new JobsError(404, "Application not found.");
  return row;
}
