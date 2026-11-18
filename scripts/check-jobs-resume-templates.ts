import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { readJobsResumeTemplate } from "../apps/api/src/jobs-resume-template";
import { maxResumeMarkdown } from "./jobs/resume-document";

const tracks = ["admin", "engineering", "web"] as const;
const directory = "/run/quantself-job-templates";

try {
  if (process.env.QUANTSELF_JOBS_RESUME_TEMPLATES_DIR !== directory) throw new Error();
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.uid !== 0 || metadata.gid !== 0 || (metadata.mode & 0o7777) !== 0o700) {
    throw new Error();
  }
  const names = (await readdir(directory)).sort();
  if (names.join("\n") !== tracks.map(track => `${track}.md`).join("\n")) throw new Error();

  for (const track of tracks) {
    const file = await lstat(join(directory, `${track}.md`));
    if (!file.isFile() || file.uid !== 0 || file.gid !== 0 || (file.mode & 0o7777) !== 0o600 ||
        file.size === 0 || file.size > maxResumeMarkdown * 4) {
      throw new Error();
    }
    await readJobsResumeTemplate(track);
  }
  console.log("PASS: three private Jobs résumé templates");
} catch {
  console.error("FAILED: private Jobs résumé templates are missing, invalid or unreadable by the API");
  process.exitCode = 1;
}
