export type WebsiteAnalyticsRow = {
  id: string;
  at: number;
  kind: string;
  path: string;
  sessionId: string | null;
  pageViewId: string | null;
  visitorId: string | null;
  linkCode: string | null;
  ipId: string | null;
  utmSource: string | null;
  referrerHost: string | null;
  device: string | null;
  props: Record<string, unknown>;
};

type BrowserVisit = {
  entry: WebsiteAnalyticsRow;
  events: WebsiteAnalyticsRow[];
  redirect?: WebsiteAnalyticsRow;
};

type Page = { path: string; activeMs: number; scrollPercent: number | null };

export const analyticsDayMs = 86_400_000;
const browserAfterOpenMs = 30_000;
const scannerWindowMs = 10_000;
const scannerBurstMs = 2_000;
const botAgent = /bot|crawler|spider|preview|headless|scanner|safelinks|proofpoint|urlscan/i;
const chronological = (a: WebsiteAnalyticsRow, b: WebsiteAnalyticsRow) => a.at - b.at || a.id.localeCompare(b.id);

function optionalNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function deviceClass(value: string | null) {
  return value === "desktop" || value === "mobile" ? value : null;
}

export function ctaKey(event: WebsiteAnalyticsRow) {
  if (event.kind === "cta:click") {
    const value = event.props.cta ?? event.props.ctaId;
    return typeof value === "string" ? value : undefined;
  }
  if (event.kind === "outbound:click") {
    return typeof event.props.target === "string" ? event.props.target : undefined;
  }
}

function hasEngagement(event: WebsiteAnalyticsRow) {
  return Boolean(ctaKey(event)) || (event.kind === "page:engagement" &&
    ((optionalNumber(event.props.activeMs) ?? 0) >= 5_000 || (optionalNumber(event.props.maxScroll) ?? 0) > 0));
}

export function sessionPages(events: WebsiteAnalyticsRow[]) {
  const pages = new Map<string, Page>();
  for (const event of events) {
    if (!event.pageViewId || (event.kind !== "page:view" && event.kind !== "page:engagement")) continue;
    const page = pages.get(event.pageViewId) ?? { path: event.path, activeMs: 0, scrollPercent: null };
    if (event.kind === "page:engagement") {
      page.activeMs = Math.max(page.activeMs, optionalNumber(event.props.activeMs) ?? 0);
      const scroll = optionalNumber(event.props.maxScroll);
      if (scroll !== null) page.scrollPercent = Math.max(page.scrollPercent ?? 0, scroll);
    }
    pages.set(event.pageViewId, page);
  }
  return [...pages.values()];
}

export function pageTitle(path: string) {
  if (path === "/") return "Home";
  return path.replace(/^\/(?:work|projects?)(?=\/)/, "").split("/").filter(Boolean).slice(-2)
    .map(part => part.replace(/[-_]+/g, " ").replace(/\b[a-z]/g, c => c.toUpperCase())).join(" ");
}

function append<K, T>(map: Map<K, T[]>, key: K, value: T) {
  const group = map.get(key);
  if (group) group.push(value);
  else map.set(key, [value]);
}

function ipKey(row: WebsiteAnalyticsRow) {
  return row.linkCode && row.ipId && /^(?:[a-f0-9]{32}|[a-f0-9]{64})$/.test(row.ipId)
    ? `${row.linkCode}:ip:${row.ipId}` : null;
}

function sessionKey(row: WebsiteAnalyticsRow) {
  return row.linkCode && row.sessionId ? `${row.linkCode}:session:${row.sessionId}` : null;
}

function lastOpenBefore(opens: WebsiteAnalyticsRow[] | undefined, at: number) {
  if (!opens?.length) return undefined;
  let low = 0;
  let high = opens.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (opens[middle].at <= at) low = middle + 1;
    else high = middle;
  }
  const open = opens[low - 1];
  return open && at - open.at <= browserAfterOpenMs ? open : undefined;
}

function scannerBursts(groups: Iterable<WebsiteAnalyticsRow[]>) {
  const suspected = new Set<string>();
  for (const opens of groups) {
    if (opens.length < 2) continue;
    const destination = (row: WebsiteAnalyticsRow) => row.props.key ?? row.path;
    for (let start = 0; start < opens.length;) {
      let end = start + 1;
      while (end < opens.length && destination(opens[end]) === destination(opens[start])) end++;
      for (let i = start; i < end; i++) {
        if ((start > 0 && opens[i].at - opens[start - 1].at <= scannerBurstMs) ||
            (end < opens.length && opens[end].at - opens[i].at <= scannerBurstMs)) suspected.add(opens[i].id);
      }
      start = end;
    }
  }
  return suspected;
}

export function analyzeWebsiteEvents(rows: readonly WebsiteAnalyticsRow[], sentAtByCode: ReadonlyMap<string, number | null>) {
  const opens: WebsiteAnalyticsRow[] = [];
  const byIp = new Map<string, WebsiteAnalyticsRow[]>();
  const bySession = new Map<string, WebsiteAnalyticsRow[]>();
  const browserGroups = new Map<string, WebsiteAnalyticsRow[]>();
  const hardScanners = new Set<string>();
  let lastEventAt: number | null = null;
  for (const row of rows) {
    if (row.props.source === "synthetic") continue;
    lastEventAt = Math.max(lastEventAt ?? row.at, row.at);
    if (row.kind === "link:open") {
      opens.push(row);
      const sent = row.linkCode && sentAtByCode.get(row.linkCode);
      if (row.props.method === "HEAD" || (typeof row.props.ua === "string" && botAgent.test(row.props.ua)) ||
          (typeof sent === "number" && row.at >= sent && row.at - sent < scannerWindowMs)) hardScanners.add(row.id);
      const ip = ipKey(row);
      if (ip) append(byIp, ip, row);
      const session = sessionKey(row);
      if (session) append(bySession, session, row);
    } else if (row.sessionId) {
      append(browserGroups, JSON.stringify([row.sessionId, row.linkCode]), row);
    }
  }

  for (const group of [...byIp.values(), ...bySession.values()]) group.sort(chronological);
  const softScanners = scannerBursts(byIp.values());
  const visits: BrowserVisit[] = [];
  const verifiedOpens = new Set<string>();
  for (const events of browserGroups.values()) {
    events.sort(chronological);
    const first = events.find(row => row.kind === "page:view");
    const engaged = events.find(hasEngagement);
    const entry = first ?? engaged;
    if (!entry) continue;
    if (entry.linkCode && !engaged) continue;

    const ip = ipKey(entry);
    const session = sessionKey(entry);
    const ipOpen = ip ? lastOpenBefore(byIp.get(ip), entry.at) : undefined;
    const sessionOpen = session ? lastOpenBefore(bySession.get(session), entry.at) : undefined;
    const redirect = sessionOpen && (!ipOpen || sessionOpen.at >= ipOpen.at) ? sessionOpen : ipOpen;
    if (redirect && hardScanners.has(redirect.id)) continue;
    if (redirect) verifiedOpens.add(redirect.id);
    visits.push({ entry, events, redirect });
  }
  const scanners = opens.filter(row => hardScanners.has(row.id) || (softScanners.has(row.id) && !verifiedOpens.has(row.id)));
  return { visits, scanners, lastEventAt };
}
