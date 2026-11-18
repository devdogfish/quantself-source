import { join } from 'node:path';
import { z } from 'zod';
import { jobsHome } from './config';
import { readPrivatePostingFile } from './private-posting-file';

const singleLine = (max: number) => z.string().min(1).max(max)
  .regex(/^[^\p{Cc}\p{Cf}\u2028\u2029]+$/u).refine(value => value.trim() === value);
const route = z.strictObject({
  sourceUrls: z.array(z.string().max(2_048).refine(value => {
    const url = URL.parse(value);
    return url?.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash && url.href === value;
  })).min(1).max(8),
  company: singleLine(200),
  role: singleLine(200),
  recipient: z.email().max(254),
  questions: z.array(singleLine(400)).max(20).refine(values => new Set(values).size === values.length),
  subjectNamePrefix: singleLine(120).optional(),
});

export type EmailRoutes = z.infer<typeof route>[];
type Posting = { sourceUrl: string; company: string; role: string };
const routes = z.array(route).max(100).refine(entries => {
  const keys = entries.flatMap(({ company, role, sourceUrls }) =>
    sourceUrls.map(sourceUrl => JSON.stringify([company, role, sourceUrl])));
  return new Set(keys).size === keys.length;
});

export function readEmailRoutes(): EmailRoutes {
  const configuredPath = process.env.QUANTSELF_JOBS_EMAIL_ROUTES;
  const data = readPrivatePostingFile(configuredPath ?? join(jobsHome(), 'email-routes.json'), {
    maxBytes: 64 * 1024, missing: configuredPath === undefined ? 'allow' : undefined, errorCode: 'invalid_email_routes',
  });
  const parsed = routes.safeParse(data === undefined ? [] : data);
  if (!parsed.success) throw new Error('invalid_email_routes');
  return parsed.data;
}

export function emailApplicationRoute(posting: Posting, configured = readEmailRoutes()) {
  const matching = configured.filter(route => route.company === posting.company && route.role === posting.role &&
    route.sourceUrls.includes(posting.sourceUrl));
  return matching.length === 1 ? matching[0] : undefined;
}
