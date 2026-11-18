export function prepareFeedConfig(input) {
  // Avoid relying on WHATWG URL, which is absent in the n8n Code sandbox.
  const baseUrl = typeof input.quantselfBaseUrl === 'string' ? input.quantselfBaseUrl.trim().replace(/\/$/, '') : '';
  if (!/^https:\/\/[a-z\d-]+(?:\.[a-z\d-]+)+(?::\d{1,5})?$/i.test(baseUrl)) {
    throw new Error('Set the Quantself HTTPS origin in Feed configuration.');
  }
  const careerCriteria = typeof input.careerCriteria === 'string' ? input.careerCriteria.trim() : '';
  if (!careerCriteria || careerCriteria.length > 8_000) {
    throw new Error('Set 1 to 8,000 characters of Owner Career criteria in Feed configuration.');
  }
  if (!Array.isArray(input.boards) || !input.boards.length || input.boards.length > 8) {
    throw new Error('Configure 1 to 8 public boards in Feed configuration.');
  }
  if (!Number.isInteger(input.maxScreenings) || input.maxScreenings < 1 || input.maxScreenings > 500) {
    throw new Error('Set maxScreenings between 1 and 500.');
  }
  const { boards, preflight } = input;
  if (preflight != null && (
    typeof preflight !== 'object' || Object.keys(preflight).length !== 2 ||
    boards.length !== 1 || boards[0]?.provider !== 'greenhouse' || boards[0].board !== preflight.board ||
    typeof preflight.board !== 'string' || !/^[a-z\d_-]+$/i.test(preflight.board) ||
    typeof preflight.postingId !== 'string' || !/^[1-9]\d*$/.test(preflight.postingId) ||
    !Number.isSafeInteger(Number(preflight.postingId))
  )) {
    throw new Error('Preflight requires one matching Greenhouse board and a valid posting ID.');
  }
  return { ...input, quantselfBaseUrl: baseUrl, careerCriteria };
}

function preflightUrlParts(sourceUrl, board, postingId) {
  // The Code sandbox lacks WHATWG URL.
  const match = typeof sourceUrl === 'string' &&
    sourceUrl.match(/^(https?):\/\/(?:job-)?boards(?:\.eu)?\.greenhouse\.io(\/[^?#]*)(?:\?([^#]*))?(?:#.*)?$/i);
  if (!match || match[2].replace(/\/+$/, '').toLowerCase() !== `/${board}/jobs/${postingId}`) return;
  return { scheme: match[1].toLowerCase(), query: match[3] ?? '' };
}

function verifyRawPreflightPosting(pages, { board, postingId }) {
  const { jobs, meta } = pages[0]?.body ?? {};
  if (pages.length !== 1 || !Array.isArray(jobs)) {
    throw new Error('Preflight requires exactly one Greenhouse board response.');
  }
  if (meta?.total !== jobs.length) {
    throw new Error('Preflight requires a complete Greenhouse board response with a matching numeric total.');
  }
  // Count claims before normalization can discard malformed rows or deduplicate them.
  const boardToken = board.toLowerCase();
  const matches = jobs.filter(row =>
    String(row?.id) === postingId || preflightUrlParts(row?.absolute_url, boardToken, postingId));
  if (matches.length !== 1 || matches[0].id !== Number(postingId)) {
    throw new Error('Preflight requires exactly one raw row with the approved numeric posting ID and no conflicting URL claims.');
  }
}

function matchesPreflightUrl(sourceUrl, board, postingId) {
  const parts = preflightUrlParts(sourceUrl, board, postingId);
  if (parts?.scheme !== 'https') return false;

  const queryIds = [];
  for (const field of parts.query.split('&')) {
    const [key, ...value] = field.split('=');
    if (decodeURIComponent(key) === 'gh_jid') queryIds.push(decodeURIComponent(value.join('=')));
  }
  return queryIds.length === 0 || (queryIds.length === 1 && queryIds[0] === postingId);
}

export function collectPostings(requests, pagesByBoard, normalizeSourceResponse, maxPages, preflight) {
  if (preflight) verifyRawPreflightPosting(pagesByBoard.get(0) ?? [], preflight);

  const postings = new Map();
  const sourceErrors = [];
  let skippedRows = 0;
  let duplicates = 0;
  let responses = 0;

  for (const [index, request] of requests.entries()) {
    const pages = pagesByBoard.get(index) ?? [];
    responses += pages.length;
    const board = `${request.provider}:${request.region}:${request.board}`;
    const boardPostings = [];
    let boardSkipped = 0;
    try {
      if (!pages.length) throw new Error('Missing public board response.');
      const lastPage = pages.at(-1);
      if (request.provider === 'lever' && pages.length === maxPages && lastPage.body?.length >= request.pageSize) {
        throw new Error('Pagination limit reached before the last page.');
      }
      for (const page of pages) {
        const { postings: rows, skipped } = normalizeSourceResponse(request, page);
        boardSkipped += skipped;
        boardPostings.push(...rows);
      }
    } catch (error) {
      sourceErrors.push({ board, reason: error.message });
      continue;
    }
    skippedRows += boardSkipped;
    for (const posting of boardPostings) {
      if (postings.has(posting.sourceIdentity)) duplicates++;
      else postings.set(posting.sourceIdentity, posting);
    }
  }

  const source = { boards: requests.length, responses, unique: postings.size, skippedRows, duplicates, errors: sourceErrors };
  if (!preflight) return { postings: [...postings.values()], source };

  const board = preflight.board.toLowerCase();
  const { postingId } = preflight;
  const selected = postings.get(`greenhouse:global:${board}:${postingId}`);
  if (sourceErrors.length || !matchesPreflightUrl(selected?.sourceUrl, board, postingId)) {
    throw new Error('Preflight could not verify the approved Greenhouse posting URL and identity.');
  }
  return { postings: [selected], source };
}

export function selectForScreening(postings, limit, now) {
  const ordered = [...postings].sort((a, b) => a.sourceIdentity.localeCompare(b.sourceIdentity, 'en'));
  if (ordered.length <= limit) return ordered;
  const utcDay = Math.floor(now / 86_400_000);
  const offset = (utcDay * limit) % ordered.length;
  return [...ordered.slice(offset), ...ordered.slice(0, offset)].slice(0, limit);
}

export function compactImportResponse(response) {
  const statusCode = Number.isInteger(response?.statusCode) ? response.statusCode : null;
  // Keep only fields needed to interpret a response. HTTP/node errors can include request data.
  const body = response?.body;
  return {
    statusCode,
    body: typeof body === 'object' && body !== null ? {
      imported: body.imported ?? null,
      duplicates: body.duplicates ?? null,
      idempotencyConflict: body.message === 'Idempotency-Key was already used with different input.',
    } : {},
  };
}

export function isRetryableImport(response) {
  const { statusCode, body } = response;
  return statusCode === null || (statusCode === 409 && !body.idempotencyConflict)
    || (statusCode >= 500 && statusCode <= 599);
}
