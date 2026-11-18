export function prepareQuantselfBatches(candidates: Array<{
  company: string;
  role: string;
  sourceIdentity: string;
  sourceUrl: string;
  description: string;
  category: string;
  fitNote: string;
  resumeTrack: string;
}>, runId: string): Array<{ body: { applications: unknown[] } }>;
