import { expect, test } from 'bun:test';
import { reconcileIntake } from './intake-audit';

const checkedAtUtc = '2026-11-10T04:00:00+00:00';
const now = Date.parse('2026-11-10T05:00:00Z');
const row = { sourceUrl: 'https://example.com/jobs/123', company: 'Example', role: 'Editor', sourceStatus: 'draft', description: 'Original listing notes.' };
const evidence = { ...row, status: 'closed', evidence: 'The employer says this exact position is no longer active.' };

test('fresh, matching closure evidence disqualifies only unsubmitted drafts and preserves original notes', () => {
  const audit = { checkedAtUtc, applications: [evidence] };
  const [result] = reconcileIntake([row], audit, now);
  expect(result.sourceStatus).toBe('disqualified');
  expect(result.description).toContain(evidence.evidence);
  expect(result.description).toContain(row.description);
  expect(row.sourceStatus).toBe('draft');
  for (const sourceStatus of ['applied', 'rejected', 'skipped']) {
    const historical = { ...row, sourceStatus };
    expect(reconcileIntake([historical], audit, now)[0]).toBe(historical);
  }
});

test('missing, old, future, mismatched and inconclusive evidence never excludes a candidate', () => {
  const unchanged = (audit: unknown) => expect(reconcileIntake([row], audit, now)[0]).toBe(row);
  unchanged(null);
  unchanged({ checkedAtUtc: '2026-11-08T04:00:00Z', applications: [evidence] });
  unchanged({ checkedAtUtc: '2026-11-11T04:00:00Z', applications: [evidence] });
  for (const change of [{ status: 'likely_closed' }, { status: 'unknown' }, { status: 'open' },
    { company: 'Different employer' }, { role: 'Different role' }, { sourceUrl: 'https://example.com/jobs/456' }]) {
    unchanged({ checkedAtUtc, applications: [{ ...evidence, ...change }] });
  }
});
