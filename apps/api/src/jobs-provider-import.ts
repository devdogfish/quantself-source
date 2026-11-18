import { randomUUID } from "node:crypto";
import type { Prisma } from "@quantself/db/generated/prisma/client";
import { canonicalJobUrl } from "./jobs-application";
import { JobsError } from "./jobs-error";
import type { JobsPrivateSourceRule } from "./jobs-private-source-rules";
import type { JobsImportApplication } from "./jobs-owner-contract";

export type PendingJobImport = {
  input: JobsImportApplication;
  source: ReturnType<typeof canonicalJobUrl>;
  id?: string;
};

export class JobsProviderImportRace extends JobsError {
  constructor() {
    super(409, "The posting was imported concurrently. Retry the same batch.");
  }
}

export function canonicalGreenhousePosting(board: string, postingId: string) {
  return canonicalJobUrl(`https://job-boards.greenhouse.io/${board}/jobs/${postingId}`);
}

export function greenhouseHostedKey(sourceUrl: string, identity: string) {
  const [, , board, postingId] = identity.split(":");
  const url = new URL(sourceUrl);
  const hosted = /^(?:job-)?boards(?:\.eu)?\.greenhouse\.io$/.test(url.hostname);
  const publishedIds = url.searchParams.getAll("gh_jid");
  if ((hosted && url.pathname.toLowerCase() !== `/${board}/jobs/${postingId}`) ||
      (publishedIds.length && (publishedIds.length !== 1 || publishedIds[0] !== postingId))) {
    throw new JobsError(400, "The Greenhouse identity does not match the posting URL.");
  }
  return canonicalGreenhousePosting(board, postingId).sourceKey;
}

export async function planProviderImports(tx: Prisma.TransactionClient, ownerId: string, inputs: JobsImportApplication[], privateRules: readonly JobsPrivateSourceRule[]) {
  const rows = inputs.map(input => {
    const source = canonicalJobUrl(input.sourceUrl, privateRules);
    return { input, source, hostedKey: input.sourceIdentity && greenhouseHostedKey(source.sourceUrl, input.sourceIdentity) };
  });
  const identityByUrl = new Map<string, string>();
  for (const { input: { sourceIdentity }, source, hostedKey } of rows) {
    if (!sourceIdentity || !hostedKey) continue;
    for (const key of [source.sourceKey, hostedKey]) {
      const previous = identityByUrl.get(key);
      if (previous && previous !== sourceIdentity) throw new JobsError(409, "One posting URL has conflicting provider identities.");
      identityByUrl.set(key, sourceIdentity);
    }
  }
  const groups = new Map<string, { primary: PendingJobImport; sourceIdentity?: string; sourceKeys: Set<string> }>();
  for (const { input, source, hostedKey } of rows) {
    const sourceIdentity = input.sourceIdentity ?? identityByUrl.get(source.sourceKey);
    const key = sourceIdentity ?? source.sourceKey;
    const group = groups.get(key) ?? { primary: { input, source }, sourceIdentity, sourceKeys: new Set<string>() };
    group.sourceKeys.add(source.sourceKey);
    if (hostedKey) group.sourceKeys.add(hostedKey);
    groups.set(key, group);
  }
  const existing = await tx.jobApplication.findMany({
    where: { ownerId, sourceKey: { in: [...new Set([...groups.values()].flatMap(group => [...group.sourceKeys]))] } },
    select: { id: true, sourceKey: true },
  });
  const bindings = await tx.jobProviderPosting.findMany({
    where: { ownerId, sourceIdentity: { in: [...new Set(identityByUrl.values())] } },
    select: { applicationId: true, sourceIdentity: true },
  });
  const byUrl = new Map(existing.map(row => [row.sourceKey, row.id]));
  const byIdentity = new Map(bindings.map(row => [row.sourceIdentity, row.applicationId]));
  const links: Prisma.JobProviderPostingCreateManyInput[] = [];
  const pending: PendingJobImport[] = [];
  for (const { primary, sourceIdentity, sourceKeys } of groups.values()) {
    const linked = sourceIdentity ? byIdentity.get(sourceIdentity) : undefined;
    const matches = new Set([...sourceKeys].flatMap(key => {
      const id = byUrl.get(key);
      return id ? [id] : [];
    }));
    if (linked) matches.add(linked);
    if (matches.size > 1) throw new JobsError(409, "The provider identity and URL match different existing applications.");
    let applicationId = matches.values().next().value;
    if (!applicationId) {
      applicationId = randomUUID();
      pending.push({ ...primary, id: applicationId });
    }
    if (sourceIdentity && !linked) links.push({ ownerId, applicationId, sourceIdentity });
  }
  return { pending, links };
}
