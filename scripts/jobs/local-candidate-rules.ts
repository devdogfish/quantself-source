import { join } from 'node:path';
import { jobsHome } from './config';
import { candidateRulesSchema } from './candidate-rules';
import { readPrivatePostingFile } from './private-posting-file';

export function readCandidateRules() {
  const data = readPrivatePostingFile(join(jobsHome(), 'candidate-rules.json'), {
    maxBytes: 8 * 1024 * 1024, missing: 'allow', errorCode: 'invalid_candidate_rules',
  });
  const parsed = candidateRulesSchema.safeParse(data === undefined ? [] : data);
  if (!parsed.success) throw new Error('invalid_candidate_rules');
  return parsed.data;
}
