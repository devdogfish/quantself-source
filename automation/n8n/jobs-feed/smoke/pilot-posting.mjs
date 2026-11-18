import { prepareQuantselfBatches } from '../quantself/quantself.mjs';
import { buildScreenRequest } from '../screening/screening.mjs';
import { normalizeSourceResponse } from '../sources/sources.mjs';

export const board = { provider: 'greenhouse', region: 'global', board: 'synthetic-studio', company: 'Synthetic Studio' };
export const criteria = 'Web publishing';
export const boardResponse = {
  jobs: [{
    id: 197, title: 'Editor', absolute_url: 'https://job-boards.greenhouse.io/synthetic-studio/jobs/197',
    content: '<p>Edit product pages.</p>', location: { name: 'Remote Canada' },
  }],
  meta: { total: 1 },
};
export const result = { decision: 'keep', category: 'web', fitNote: 'Edits product pages.' };
export const [posting] = normalizeSourceResponse(board, { statusCode: 200, body: boardResponse }).postings;
export const screenBody = JSON.stringify(buildScreenRequest(posting, criteria));
export const importBody = JSON.stringify(prepareQuantselfBatches([{ ...posting, ...result, resumeTrack: 'web' }], 'fixture')[0].body);
