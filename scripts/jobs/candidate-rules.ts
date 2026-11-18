import { z } from 'zod';

const field = z.strictObject({
  id: z.string().min(1).max(101),
  label: z.string().min(1).max(400),
});

const rule = field.extend({
  type: z.enum(['text', 'textarea', 'combobox']),
  key: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  title: z.string().min(1).max(400),
  help: z.string().max(400).optional(),
  resumeOnlyValue: z.string().max(512).optional(),
  format: z.enum(['count', 'integer', 'salary', 'yes-no', 'notice']).optional(),
});

const postingRules = z.strictObject({
  sourceUrl: z.url({ protocol: /^https$/ }).max(2_048),
  company: z.string().min(1).max(200),
  role: z.string().min(1).max(200),
  rules: z.array(rule).max(40).refine(rules => new Set(rules.map(rule => rule.label)).size === rules.length),
  referral: z.strictObject({
    question: field.extend({ type: z.literal('textarea') }),
    name: field.extend({ type: z.literal('textarea') }),
    title: z.string().min(1).max(400),
  }).optional(),
  residence: z.strictObject({
    field: field.extend({ type: z.literal('select') }),
    country: z.string().min(1).max(120),
  }).optional(),
  phoneCountry: z.boolean().optional(),
  pageIdentity: z.strictObject({
    company: z.string().min(1).max(200),
    role: z.string().min(1).max(200),
  }).optional(),
});

export type CandidateRules = z.infer<typeof postingRules>[];
export const candidateRulesSchema = z.array(postingRules).max(100).refine(entries =>
  new Set(entries.map(({ sourceUrl, company, role }) => JSON.stringify([sourceUrl, company, role]))).size === entries.length);
export type CandidateRule = z.infer<typeof rule>;

export type CandidateRuleDisplay = Pick<CandidateRule, 'label' | 'type' | 'key' | 'title' | 'help' | 'format'> & {
  hasResumeOnlyDefault?: boolean;
};
export type CandidateRulesDisplay = {
  rules: CandidateRuleDisplay[];
  referral?: { questionLabel: string; nameLabel: string; title: string };
  phoneCountry?: boolean;
};

export function matchCandidateRules(
  posting: Pick<CandidateRules[number], 'sourceUrl' | 'company' | 'role'> | undefined,
  configured: CandidateRules,
) {
  const matches = configured.filter(rule => rule.sourceUrl === posting?.sourceUrl &&
    rule.company === posting.company && rule.role === posting.role);
  return matches.length === 1 ? matches[0] : undefined;
}

export function candidateRulesDisplay(posting: Parameters<typeof matchCandidateRules>[0], configured: CandidateRules): CandidateRulesDisplay | undefined {
  const selected = matchCandidateRules(posting, configured);
  if (!selected) return;
  return {
    rules: selected.rules.map(({ label, type, key, title, help, format, resumeOnlyValue }) =>
      ({ label, type, key, title, help, format, ...(resumeOnlyValue && { hasResumeOnlyDefault: true }) })),
    ...(selected.referral && { referral: {
      questionLabel: selected.referral.question.label, nameLabel: selected.referral.name.label, title: selected.referral.title,
    } }),
    ...(selected.phoneCountry && { phoneCountry: true }),
  };
}
