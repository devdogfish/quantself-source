import { join } from 'node:path';
import { z } from 'zod';
import { jobsHome } from './config';
import { readPrivatePostingFile } from './private-posting-file';

export const reviewedBrowserUrl = z.string().max(2_048).refine(value => {
  const url = URL.parse(value);
  return url?.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash;
});

export function exactBrowserPosting(value: string) {
  if (!reviewedBrowserUrl.safeParse(value).success) return;
  const url = new URL(value);
  return url.origin + url.pathname.replace(/\/$/, '') + url.search;
}

export function readBrowserConfig<T>(name: string, schema: z.ZodType<T>) {
  try {
    const value = readPrivatePostingFile(join(jobsHome(), name), {
      maxBytes: 128 * 1024, missing: 'allow', errorCode: 'invalid_browser_config',
    });
    const parsed = schema.safeParse(value);
    if (parsed.success) return parsed.data;
  } catch { /* Unavailable private config leaves this route disabled. */ }
}
