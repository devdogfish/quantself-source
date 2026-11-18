import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { JobResumeTrack } from "@quantself/db/generated/prisma/client";
import { parseResumeDocument, replaceDocumentSummary } from "../../../scripts/jobs/resume-document";
import { JobsError } from "./jobs-error";

export async function readJobsResumeTemplate(track: JobResumeTrack, supplied?: string) {
  if (supplied !== undefined) {
    try { return parseResumeDocument(supplied).markdown; }
    catch { throw new JobsError(400, "Use a portable résumé template with the Summary and contact placeholders."); }
  }
  const directory = process.env.QUANTSELF_JOBS_RESUME_TEMPLATES_DIR;
  if (directory) {
    try {
      const markdown = await readFile(join(directory, track + ".md"), "utf8");
      return parseResumeDocument(markdown).markdown;
    } catch { throw new JobsError(503, "The configured Jobs résumé template is unavailable or invalid."); }
  }
  throw new JobsError(503, "Supply a résumé template or configure the Jobs résumé templates directory.");
}

export async function fillLegacyResume(
  track: JobResumeTrack, summary: string, template = readJobsResumeTemplate(track),
) {
  try {
    return replaceDocumentSummary(await template, summary).markdown;
  } catch {
    return null;
  }
}
