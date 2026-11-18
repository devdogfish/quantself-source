import { z } from "@hono/zod-openapi";
import { Prisma, type PrismaClient } from "@quantself/db/generated/prisma/client";
import { JobsError } from "./jobs-error";

const version = z.number().int().min(0).max(2_147_483_647);
const markdown = z.string().max(50_000);

export const candidateContextOutput = z.object({ markdown, version }).openapi("JobCandidateContext");
export const patchCandidateContextInput = z.strictObject({
  markdown,
  expectedVersion: version.max(2_147_483_646),
});

type CandidateContextDb = Pick<PrismaClient, "jobCandidateContext">;
type CandidateContextPatch = z.infer<typeof patchCandidateContextInput>;
const select = { markdown: true, version: true } as const;

export async function getCandidateContext(db: CandidateContextDb, ownerId: string) {
  return await db.jobCandidateContext.findUnique({ where: { ownerId }, select }) ?? { markdown: "", version: 0 };
}

function checkMarkdown(text: string) {
  const email = /\b[\w.!#$%&'*+/=?^`{|}~-]{1,64}@[\w.-]{1,253}\.[a-z]{2,63}\b/i;
  const phone = /(?:^|[^\w])(?:\+?1[ .-]?)?(?:\([2-9]\d{2}\)[ .-]?|[2-9]\d{2}[ .-]?)[2-9]\d{2}[ .-]?\d{4}(?!\w)/m;
  if (email.test(text) || phone.test(text)) {
    throw new JobsError(400, "Use masked references for email addresses and phone numbers. Save values in Reusable details.");
  }
  if (text.includes("\0")) throw new JobsError(400, "Candidate context cannot contain null characters.");
}

export async function patchCandidateContext(db: CandidateContextDb, ownerId: string, input: CandidateContextPatch) {
  const { markdown, expectedVersion } = input;
  checkMarkdown(markdown);
  const data = { markdown, version: expectedVersion + 1 };
  try {
    if (expectedVersion === 0) return await db.jobCandidateContext.create({ data: { ownerId, ...data }, select });
    return await db.jobCandidateContext.update({ where: { ownerId, version: expectedVersion }, data, select });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && ["P2002", "P2025"].includes(error.code)) {
      throw new JobsError(409, "Candidate context changed in another session.");
    }
    throw error;
  }
}
