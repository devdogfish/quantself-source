export type ResumeLink = {
  url: string;
  label: string;
  kind: "project" | "portfolio" | "code" | "contact";
  inHeader?: boolean;
};

const knownLinks: ResumeLink[] = [
  { url: "https://rbc-analytics.demo.girke.dev", label: "the RBC analytics demo", kind: "project" },
  { url: "https://github.com/devdogfish/etpzp-sms", label: "the ETPZP SMS project source code", kind: "project" },
  { url: "https://sitings.ca/property/", label: "the Sitings property project", kind: "project" },
  { url: "https://github.com/devdogfish", label: "the GitHub code portfolio", kind: "code" },
  { url: "https://luigigirke.com", label: "the project portfolio website", kind: "portfolio" },
  { url: "https://girke.dev", label: "the project portfolio website", kind: "portfolio" },
  { url: "https://www.linkedin.com/in/luigigirke", label: "LinkedIn", kind: "contact" },
];

const aliases: Record<string, string> = {
  "/profile/portfolio/external": "https://luigigirke.com",
  "/profile/github/external": "https://github.com/devdogfish",
  "/profile/linkedin/external": "https://www.linkedin.com/in/luigigirke",
  "/project/rbc-analytics/demo": "https://rbc-analytics.demo.girke.dev",
  "/project/etpzp-sms/repository": "https://github.com/devdogfish/etpzp-sms",
  "/project/sitings/live-site": "https://sitings.ca/property/",
  "/profile/github": "https://github.com/devdogfish",
  "/profile/linkedin": "https://www.linkedin.com/in/luigigirke",
  "/project/rbc/demo": "https://rbc-analytics.demo.girke.dev",
  "/project/etpzp-sms/source": "https://github.com/devdogfish/etpzp-sms",
  "/project/sitings/demo": "https://sitings.ca/property/",
};
const legacyPortfolioCodes = new Set(["85c0fac356", "da393208fe", "79ddb560ef"]);

function publicUrl(value: string) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return;
    url.hash = "";
    return url;
  } catch { return; }
}

function normalizedUrl(value: string) {
  const url = publicUrl(value);
  return url ? url.href.replace(/\/$/, "") : undefined;
}

function knownLink(value: string) {
  const url = publicUrl(value);
  if (!url) return;
  const direct = knownLinks.find(link => normalizedUrl(link.url) === normalizedUrl(value));
  if (direct) return direct;
  if (url.hostname !== "girke.dev") return;
  const cohort = /^\/go\/(?:software|web-cms|admin-excel)(\/.*)$/.exec(url.pathname)?.[1];
  const application = /^\/r\/([a-f0-9]{24})(\/.*)?$/.exec(url.pathname);
  const legacy = /^\/r\/([a-f0-9]{10})\/?$/.exec(url.pathname);
  let original: string | undefined;
  if (cohort) original = aliases[cohort];
  else if (application) original = application[2] ? aliases[application[2]] : "https://luigigirke.com";
  else if (legacy && legacyPortfolioCodes.has(legacy[1])) original = "https://luigigirke.com";
  return knownLinks.find(link => link.url === original);
}

export function extractMarkdownLinks(markdown: string): Array<{ url: string; label: string }> {
  const content = markdown.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`/g, "");
  const links: Array<{ url: string; label: string }> = [];
  for (const match of content.matchAll(/(?<![!\\])\[([^\]\n]+)\]\(/g)) {
    let cursor = match.index + match[0].length;
    let depth = 0;
    let url = "";
    let closed = false;
    for (; cursor < content.length; cursor++) {
      const char = content[cursor];
      if (char === "\\" && cursor + 1 < content.length) {
        url += content[++cursor];
      } else if (char === "(") {
        depth++;
        url += char;
      } else if (char === ")") {
        if (!depth) { closed = true; break; }
        depth--;
        url += char;
      } else if (/\s/.test(char)) {
        closed = /^\s+(?:"[^"\n]*"|'[^'\n]*')\s*\)/.test(content.slice(cursor));
        break;
      } else {
        url += char;
      }
    }
    if (closed) links.push({ url, label: match[1] });
  }
  return links;
}

export function extractResumeLinks(markdown: string) {
  return extractMarkdownLinks(markdown).filter(link => publicUrl(link.url));
}

// Only known public destinations cross from local configuration. Never return
// the configuration, account aliases, registration credentials or contact data.
export function resumeLinkCatalog(
  header: string,
  replacements: Record<string, string> = {},
): ResumeLink[] {
  const catalog = new Map<string, ResumeLink>();
  for (const link of knownLinks) catalog.set(normalizedUrl(link.url)!, { ...link });
  for (const [original, replacement] of Object.entries(replacements)) {
    const known = knownLink(original);
    const key = normalizedUrl(replacement);
    if (known && key) catalog.set(key, { ...known, url: replacement });
  }
  for (const anchor of extractResumeLinks(header)) {
    const key = normalizedUrl(anchor.url);
    const known = key ? catalog.get(key) ?? knownLink(anchor.url) : undefined;
    if (known && key) catalog.set(key, { ...known, url: anchor.url, inHeader: true });
  }
  return [...catalog.values()];
}

export function describeResumeLinks(markdown: string, catalog: readonly ResumeLink[] = []): string {
  const byUrl = new Map(catalog.map(link => [normalizedUrl(link.url), link]));
  const linked = extractResumeLinks(markdown);
  if (markdown.includes("{{contact}}")) linked.unshift(...catalog.filter(link => link.inHeader));
  const labels = new Set<string>();
  for (const anchor of linked) {
    const url = publicUrl(anchor.url);
    if (!url || /(?:^|\.)linkedin\.com$/i.test(url.hostname)) continue;
    const known = byUrl.get(normalizedUrl(anchor.url)) ?? knownLink(anchor.url);
    if (known?.kind === "contact") continue;
    const text = anchor.label.replace(/[*_`\[\]\\]/g, "").replace(/\s+/g, " ").trim();
    if (text.includes("@")) continue;
    const label = known?.label ?? (/^(?:here|click here|link|demo|website|read more)$/i.test(text) || !text
      ? url.hostname : text.slice(0, 120));
    labels.add(label);
  }
  const names = [...labels];
  if (!names.length) return "This résumé has no additional project links.";
  const last = names.pop()!;
  const list = names.length ? names.join(", ") + (names.length > 1 ? ", and " : " and ") + last : last;
  return "This résumé links to " + list.replace(/[.!?]+$/, "") + ".";
}
