const boardSegment = '[a-z0-9_-]+';
const ashbySegment = `${boardSegment}(?:\\.${boardSegment})*`;
const boardToken = new RegExp(`^${boardSegment}$`, 'i');
const ashbyToken = new RegExp(`^${ashbySegment}$`, 'i');
const uuid = '[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';
const entities = {
  amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"',
  ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', bull: '•',
};
const pageSize = 100;

function cleanText(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function decodeEntities(value) {
  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (entity, code) => {
    if (code[0] !== '#') return Object.hasOwn(entities, code) ? entities[code] : entity;
    const number = code[1].toLowerCase() === 'x' ? Number.parseInt(code.slice(2), 16) : Number(code.slice(1));
    return number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff)
      ? String.fromCodePoint(number)
      : entity;
  });
}

function htmlText(value) {
  if (typeof value !== 'string') return '';
  // Greenhouse may encode markup which then contains its own entities.
  for (let round = 0; round < 2; round++) {
    if (/<\/?[a-z][^>]*>/i.test(value)) break;
    const decoded = decodeEntities(value);
    if (decoded === value) break;
    value = decoded;
  }
  return cleanText(decodeEntities(value
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')));
}

function publicPostingUrl(value) {
  // The n8n sandbox may not expose WHATWG URL. Require an absolute domain
  // without credentials, port, whitespace, or IP literals before passing it on.
  if (typeof value !== 'string' || value.length > 2_048) return '';
  const match = value.match(/^https?:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})(?=[/?#]|$)(?:[/?#][^\s\\]*)?$/i);
  if (!match || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/i.test(match[1])) return '';
  return value;
}

export function sourceRequests(boards) {
  if (!Array.isArray(boards)) throw new Error('Configure an array of public job boards');
  const used = new Set();
  return boards.flatMap((source, index) => {
    const { provider, board, region = 'global' } = source ?? {};
    const company = provider === 'wwr' ? 'We Work Remotely' : cleanText(source?.company);
    const validBoard = provider === 'ashby' ? ashbyToken : boardToken;
    if (typeof board !== 'string' || board.length > 120 || !validBoard.test(board) ||
        !company || company.length > 200 || !['greenhouse', 'lever', 'ashby', 'wwr'].includes(provider) ||
        (provider === 'wwr' && board !== 'remote-jobs') ||
        !['global', 'eu'].includes(region) || (region === 'eu' && provider !== 'lever')) {
      throw new Error(`Invalid public job board at index ${index}`);
    }
    const key = `${provider}:${region}:${board.toLowerCase()}`;
    if (used.has(key)) return [];
    used.add(key);
    const request = { provider, board, company, region };
    if (provider === 'lever') {
      const host = region === 'eu' ? 'api.eu.lever.co' : 'api.lever.co';
      return [{ ...request, pageSize, url: `https://${host}/v0/postings/${board}?mode=json&limit=${pageSize}` }];
    }
    const urls = {
      greenhouse: `https://boards-api.greenhouse.io/v1/boards/${board}/jobs?content=true`,
      ashby: `https://api.ashbyhq.com/posting-api/job-board/${board}?includeCompensation=true`,
      wwr: 'https://weworkremotely.com/remote-jobs.rss',
    };
    return [{ ...request, url: urls[provider] }];
  });
}

function postingDate(value) {
  const milliseconds = typeof value === 'string' || typeof value === 'number' ? new Date(value).getTime() : NaN;
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : '';
}

function locations(values) {
  return [...new Set(values.map(cleanText).filter(Boolean))].join('; ').slice(0, 200);
}

function normalizeGreenhouse(job) {
  if (job.internal_job_id === null) return;
  return {
    id: /^\d+$/.test(String(job.id)) && Number.isSafeInteger(Number(job.id)) ? String(job.id) : '',
    role: job.title,
    sourceUrl: job.absolute_url,
    description: htmlText(job.content),
    location: cleanText(job.location?.name),
    postedAt: postingDate(job.first_published),
  };
}

function rangeSalary(range) {
  if (!range || !Number.isFinite(range.min) || !Number.isFinite(range.max)) return '';
  return cleanText(`${range.currency ?? ''} ${range.min}–${range.max} ${range.interval ?? ''}`);
}

function normalizeLever(job, request) {
  const host = request.region === 'eu' ? 'jobs.eu.lever.co' : 'jobs.lever.co';
  const pattern = new RegExp(`^https://${host.replaceAll('.', '\\.')}\/(${boardSegment})\/(${uuid})/?(?:[?#].*)?$`, 'i');
  const match = typeof job.hostedUrl === 'string' ? job.hostedUrl.match(pattern) : undefined;
  if (!match || match[1].toLowerCase() !== request.board.toLowerCase() || match[2].toLowerCase() !== cleanText(job.id).toLowerCase()) return;
  const lists = Array.isArray(job.lists) ? job.lists.flatMap(list => [cleanText(list?.text), htmlText(list?.content)]) : [];
  const otherLocations = Array.isArray(job.categories?.allLocations) ? job.categories.allLocations : [];
  return {
    id: match[2].toLowerCase(),
    role: job.text,
    sourceUrl: `https://${host}/${match[1]}/${match[2]}`,
    description: [cleanText(job.descriptionPlain) || htmlText(job.description), ...lists, cleanText(job.additionalPlain) || htmlText(job.additional)].filter(Boolean).join('\n'),
    location: locations([job.categories?.location, ...otherLocations]),
    workplaceType: cleanText(job.workplaceType) === 'unspecified' ? '' : cleanText(job.workplaceType),
    employmentType: cleanText(job.categories?.commitment),
    salary: cleanText(job.salaryDescriptionPlain) || rangeSalary(job.salaryRange),
    postedAt: postingDate(job.createdAt),
  };
}

function normalizeAshby(job, request) {
  if (job.isListed !== true) return;
  const pattern = new RegExp(`^https://jobs\\.ashbyhq\\.com\/(${ashbySegment})\/(${uuid})/?(?:[?#].*)?$`, 'i');
  const match = typeof job.jobUrl === 'string' ? job.jobUrl.match(pattern) : undefined;
  if (!match || match[1].toLowerCase() !== request.board.toLowerCase() || (job.id && cleanText(job.id).toLowerCase() !== match[2].toLowerCase())) return;
  const otherLocations = Array.isArray(job.secondaryLocations) ? job.secondaryLocations.map(item => item?.location) : [];
  return {
    id: match[2].toLowerCase(),
    role: job.title,
    sourceUrl: `https://jobs.ashbyhq.com/${match[1]}/${match[2]}`,
    description: cleanText(job.descriptionPlain) || htmlText(job.descriptionHtml),
    location: locations([job.location, ...otherLocations]),
    workplaceType: cleanText(job.workplaceType),
    employmentType: cleanText(job.employmentType),
    salary: cleanText(job.compensation?.scrapeableCompensationSalarySummary) || cleanText(job.compensation?.compensationTierSummary),
    postedAt: postingDate(job.publishedAt),
  };
}

function wwrItems(xml) {
  // The feed uses plain RSS item tags with escaped HTML or CDATA descriptions.
  if (typeof xml !== 'string' || !/<rss\b[^>]*>\s*<channel\b[^>]*>/i.test(xml) ||
      !/<\/channel>\s*<\/rss>\s*$/i.test(xml) || /<!DOCTYPE/i.test(xml)) return;
  const records = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)];
  if (records.length !== (xml.match(/<item>/g)?.length ?? 0)) return;
  return records.map(([, item]) => item);
}

function rssValue(item, name) {
  const match = item.match(new RegExp(`<${name}>([\\s\\S]*?)<\/${name}>`));
  const value = match?.[1].trim() ?? '';
  if (value.startsWith('<![CDATA[') && value.endsWith(']]>')) return value.slice(9, -3);
  return decodeEntities(value);
}

function normalizeWwr(item) {
  const title = rssValue(item, 'title');
  const separator = title.indexOf(':');
  const company = cleanText(title.slice(0, separator));
  const slug = wwrPostingSlug(item);
  if (!slug || separator < 1 || !company || company.length > 200) return;
  return {
    id: slug.toLowerCase(), company, role: title.slice(separator + 1),
    sourceUrl: `https://weworkremotely.com/remote-jobs/${slug}`,
    sourceLabel: 'We Work Remotely',
    description: htmlText(rssValue(item, 'description')),
    location: rssValue(item, 'region'), workplaceType: 'remote',
    employmentType: rssValue(item, 'type'), postedAt: postingDate(rssValue(item, 'pubDate')),
  };
}

function wwrPostingSlug(item) {
  return rssValue(item, 'link').match(/^https:\/\/weworkremotely\.com\/remote-jobs\/([a-z\d-]+)\/?(?:[?#].*)?$/i)?.[1];
}

export function indexWwrPostings(xml) {
  const items = wwrItems(xml);
  if (!items) return;
  const descriptions = new Map();
  for (const item of items) {
    const slug = wwrPostingSlug(item);
    if (!slug) continue;
    const url = `https://weworkremotely.com/remote-jobs/${slug}`;
    if (!descriptions.has(url)) descriptions.set(url, rssValue(item, 'description'));
  }
  return descriptions;
}

export function wwrPostingDescription(description) {
  return htmlText(description);
}

export function normalizeSourceResponse(request, response) {
  const label = `${request.provider}:${request.region}:${request.board.toLowerCase()}`;
  if (response?.statusCode !== 200) {
    throw new Error(`Public job board ${label} returned HTTP ${response?.statusCode ?? 'unknown'}`);
  }
  let rows = response.body?.jobs;
  if (request.provider === 'lever') rows = response.body;
  if (request.provider === 'wwr') rows = wwrItems(response.body ?? response.data);
  if (!Array.isArray(rows) || (request.provider === 'greenhouse' &&
      Number.isSafeInteger(response.body.meta?.total) && response.body.meta.total !== rows.length)) {
    throw new Error(`Invalid or incomplete public job board response for ${label}`);
  }
  const normalize = { greenhouse: normalizeGreenhouse, lever: normalizeLever, ashby: normalizeAshby, wwr: normalizeWwr }[request.provider];
  const postings = new Map();
  let skipped = 0;
  for (const row of rows) {
    const candidate = row && normalize(row, request);
    const role = cleanText(candidate?.role);
    const sourceUrl = publicPostingUrl(candidate?.sourceUrl);
    const description = candidate?.description;
    if (!candidate?.id || !role || !sourceUrl || !description) {
      skipped++;
      continue;
    }
    const { id, ...posting } = candidate;
    const sourceIdentity = `${label}:${id}`;
    if (postings.has(sourceIdentity)) skipped++;
    else postings.set(sourceIdentity, {
      ...posting, company: posting.company ?? request.company, role: role.slice(0, 200), sourceUrl, sourceIdentity,
      description: description.slice(0, 12_000),
      location: cleanText(posting.location).slice(0, 200),
      ...(posting.salary ? { salary: posting.salary.slice(0, 200) } : {}),
    });
  }
  return { postings: [...postings.values()], skipped };
}
