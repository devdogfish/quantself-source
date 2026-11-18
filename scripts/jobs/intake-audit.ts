import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { jobsHome } from './config';

type IntakeRow = { sourceUrl: string; sourceStatus: string; company: string; role: string; description?: string | null };
const evidenceSchema = z.object({
  checkedAtUtc: z.string().datetime({ offset: true }),
  applications: z.array(z.object({
    sourceUrl: z.url().max(2048), company: z.string().max(200), role: z.string().max(200),
    status: z.string().max(40), evidence: z.string().max(4000),
  })).max(500),
});

export function reconcileIntake<T extends IntakeRow>(applications: T[], audit: unknown, now = Date.now()): T[] {
  const parsed = evidenceSchema.safeParse(audit);
  if (!parsed.success) return applications;
  const checked = Date.parse(parsed.data.checkedAtUtc);
  // Use recent, explicitly closed evidence only. Absence from a board, account
  // gates, CAPTCHA and "likely closed" are not proof that a job is unavailable.
  if (checked > now || now - checked > 24 * 60 * 60 * 1000) return applications;
  const closed = new Map(parsed.data.applications.filter(row => row.status === 'closed').map(row => [row.sourceUrl, row]));
  return applications.map(row => {
    const evidence = closed.get(row.sourceUrl);
    if (row.sourceStatus !== 'draft' || !evidence || evidence.company !== row.company || evidence.role !== row.role) return row;
    const note = `Availability checked ${parsed.data.checkedAtUtc}: closed. ${evidence.evidence}`;
    return { ...row, sourceStatus: 'disqualified', description: `${note}\n${row.description || ''}`.slice(0, 12000) };
  });
}

export async function reconcileLocalIntake<T extends IntakeRow>(applications: T[]) {
  const path = join(jobsHome(), 'public-portal-audit.json');
  try {
    if ((await stat(path)).size > 1_000_000) return applications;
    const raw = await readFile(path, 'utf8');
    if (Buffer.byteLength(raw) > 1_000_000) return applications;
    return reconcileIntake(applications, JSON.parse(raw));
  } catch { return applications; }
}
