// Sample data for `bun run preview:jobs` (in-memory only, no API).
import type { IssueCode, Status } from "../app/jobs/jobs-client";

type JobStatus = Status;
/** Sample listing shape for the preview stub (seed data only, not the API contract). */
export type SampleApplication = {
  id: string; company: string; role: string; location: string | null; salary: string | null;
  sourceUrl: string; sourceLabel: string | null; sourceStatus: string | null; description: string;
  resumeTrack: Track; summary: string; hasResumeMarkdown: boolean; reviewLane: "quick" | "tailored";
  status: JobStatus; revision: number; approvedRevision: number | null; revisionPending: boolean;
  createdAt: string; updatedAt: string; appliedAt: string | null;
  issueCode: IssueCode | null; receiptCode: "confirmation_page" | "confirmation_message" | null;
};
type JobApplication = SampleApplication;

const companies = [
  ["Northline Studio", "Frontend Developer", "Halifax, NS", "$78k–$92k", "web"],
  ["Shopify", "Senior Software Engineer, Checkout", "Remote, Canada", "$150k–$185k", "engineering"],
  ["Wealthsimple", "Full-stack Engineer", "Toronto, ON", "$120k–$140k", "engineering"],
  ["Clio", "Software Developer II", "Vancouver, BC", "$105k–$125k", "engineering"],
  ["Atlantic Health", "Operations Coordinator", "Halifax, NS", "$52k–$58k", "admin"],
  ["Lightspeed", "React Developer", "Montréal, QC", "$95k–$115k", "web"],
  ["Hootsuite", "Web Platform Engineer", "Remote", "$110k–$130k", "web"],
  ["Benevity", "Backend Engineer, Payments", "Calgary, AB", "$115k–$135k", "engineering"],
  ["Dalhousie University", "Administrative Analyst", "Halifax, NS", "$58k–$64k", "admin"],
  ["Vidyard", "Software Engineer, Growth", "Kitchener, ON", "$100k–$120k", "engineering"],
  ["Kinaxis", "Data Operations Specialist", "Ottawa, ON", "$65k–$75k", "admin"],
  ["Jobber", "Frontend Engineer, Design Systems", "Edmonton, AB", "$110k–$125k", "web"],
  ["Ada Support", "Software Engineer, Platform", "Remote", "$125k–$150k", "engineering"],
  ["Thinkific", "Web Developer", "Vancouver, BC", "$85k–$100k", "web"],
  ["Nova Scotia Power", "Business Systems Analyst", "Halifax, NS", "$70k–$82k", "admin"],
  ["Coveo", "Full-stack Developer", "Québec City, QC", "$95k–$115k", "engineering"],
  ["FreshBooks", "Senior Frontend Engineer", "Toronto, ON", "$130k–$150k", "web"],
  ["Procurify", "Excel Reporting Specialist", "Remote", "$60k–$70k", "admin"],
  ["Unbounce", "Software Engineer, Editor", "Vancouver, BC", "$105k–$120k", "web"],
  ["Dapper Labs", "Backend Developer", "Remote", "$120k–$140k", "engineering"],
  ["Points", "Software Developer", "Toronto, ON", "$90k–$105k", "engineering"],
  ["Hopper", "Mobile Web Engineer", "Montréal, QC", "$110k–$130k", "web"],
  ["Sobeys", "Office Administrator", "Stellarton, NS", "$45k–$50k", "admin"],
  ["Float", "Product Engineer", "Toronto, ON", "$120k–$145k", "engineering"],
  ["Copperleaf", "Junior Developer", "Vancouver, BC", "$70k–$80k", "engineering"],
  ["League", "Frontend Developer", "Remote", "$100k–$115k", "web"],
  ["Mindbeacon", "Operations Associate", "Remote", "$50k–$56k", "admin"],
  ["Trulioo", "Software Engineer II", "Vancouver, BC", "$110k–$125k", "engineering"],
  ["Ritual", "Web Engineer", "Toronto, ON", "$95k–$110k", "web"],
  ["Emera", "Reporting Analyst", "Halifax, NS", "$62k–$70k", "admin"],
  ["Cohere", "Frontend Engineer, Dashboard", "Toronto, ON", "$140k–$170k", "web"],
  ["PointClickCare", "Software Developer", "Mississauga, ON", "$95k–$110k", "engineering"],
  ["Achievers", "UI Developer", "Toronto, ON", "$90k–$105k", "web"],
  ["Pela", "E-commerce Web Developer", "Kelowna, BC", "$75k–$90k", "web"],
  ["CGI", "Junior Business Analyst", "Halifax, NS", "$58k–$65k", "admin"],
  ["Tulip", "Software Engineer", "Waterloo, ON", "$105k–$120k", "engineering"],
] as const;

const statusPlan: JobStatus[] = [
  "review", "review", "review", "review", "review", "review", "review", "review", "review",
  "draft", "draft",
  "approved", "approved", "queued", "submitting",
  "needs_attention", "needs_attention", "needs_attention",
  "applied", "applied", "applied", "applied", "applied", "applied", "applied", "applied",
  "rejected", "rejected", "skipped", "skipped", "skipped", "saved_for_later", "saved_for_later",
  "disqualified", "applied", "review",
];
const issues = ["submission_uncertain", "unsupported_portal", "manual_required"] as const;
const sources = ["LinkedIn", "Indeed", "Company site", "Workday", "Greenhouse", "Lever"];

export const NOW = new Date("2026-11-14T15:00:00Z").getTime();
const hour = 3_600_000;

export const sampleApplications: JobApplication[] = companies.map(([company, role, location, salary, track], i) => {
  // i 10: a drafting failure (model_error) that belongs in Review; i 2: approved v2, then edited (needs re-approval).
  const status: JobStatus = i === 10 ? "needs_attention" : statusPlan[i % statusPlan.length];
  const created = NOW - (i * 19 + 3) * hour;
  const appliedAt = status === "applied" || status === "rejected" ? new Date(created + 26 * hour).toISOString() : null;
  return {
    id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    company, role, location, salary,
    sourceUrl: `https://jobs.example.com/${company.toLowerCase().replace(/\W+/g, "-")}/${i}`,
    sourceLabel: sources[i % sources.length],
    sourceStatus: null,
    description: description(company, role, track),
    resumeTrack: track,
    summary: `${role} at ${company} matches ${track === "admin" ? "four years of reporting and spreadsheet automation" : "TypeScript, React and Postgres production work"}. Strong overlap on ${i % 3 === 0 ? "design systems and accessibility" : i % 3 === 1 ? "API design and observability" : "stakeholder reporting"}; gap on ${i % 2 ? "Kubernetes" : "people management"}.`,
    hasResumeMarkdown: true,
    reviewLane: i % 3 === 0 ? "tailored" : "quick",
    status,
    revision: 1 + (i % 4),
    approvedRevision: ["approved", "queued", "submitting", "applied"].includes(status) ? 1 + (i % 4) : i === 2 ? (i % 4) : null,
    revisionPending: false,
    createdAt: new Date(created).toISOString(),
    updatedAt: new Date(created + 2 * hour).toISOString(),
    appliedAt,
    issueCode: i === 10 ? "model_error" : status === "needs_attention" ? issues[i % 3] : null,
    receiptCode: status === "applied" ? (i % 4 === 0 ? null : i % 2 ? "confirmation_page" : "confirmation_message") : null,
  } satisfies JobApplication;
});

// Agent verdict (Ramp Policy Agent style) and the summary before the last edit are prototype-only (not in the API yet).
export type AgentVerdict = { level: "strong" | "review" | "weak"; reasons: { text: string; source: string }[] };
export function agentVerdict(a: JobApplication): AgentVerdict {
  const score = fitScore(a);
  const level = score >= 80 ? "strong" : score >= 65 ? "review" : "weak";
  const tech = a.resumeTrack === "admin" ? "Excel reporting and data cleanup" : "TypeScript and React";
  const reasons = [
    { text: `Core stack matches: ${tech}`, source: "Posting: What you bring, line 2" },
    { text: level === "weak" ? "Seniority gap: posting asks for team leadership" : "Experience level fits what the posting asks", source: "Resume: Professional Experience" },
    { text: a.location?.startsWith("Remote") || a.location?.includes("Halifax") ? "Location works without relocation" : `Requires relocation to ${a.location}`, source: "Posting: header" },
  ];
  return { level, reasons: level === "review" ? reasons : reasons.slice(0, level === "strong" ? 3 : 2) };
}
export const verdictLabels = { strong: "Strong fit", review: "Review", weak: "Weak fit" } as const;
export function previousSummary(a: JobApplication) {
  return a.summary.replace("Strong overlap", "Some overlap").replace(/; gap on .*$/, ".");
}

// Match score used to derive the verdict.
export function fitScore(a: JobApplication) {
  const n = Number(a.id.slice(-2));
  return 52 + ((n * 37) % 46);
}
export function fitVerdict(score: number) {
  return score >= 80 ? "Strong" : score >= 65 ? "Good" : "Weak";
}

export const sampleResume = `# Alex Morgan

Halifax, NS | alex@example.com | github.com/alexm

## Summary

- Full-stack developer with five years shipping TypeScript products.
- Built and ran a design system used by 14 teams; cut checkout latency by 38%.

## Professional Experience

**Harbourline Software** | Halifax, NS

Senior Developer | 2023 - Present

- Led migration of a 120-screen React app to a shared component library.
- Designed a PostgreSQL-backed job queue processing 2M events/day.
- Introduced accessibility audits; WCAG AA across all customer flows.

## Tools and Languages

**Languages:** TypeScript, JavaScript, SQL, HTML, CSS

## Education

**Dalhousie University** | Halifax, NS`;

// Structured posting (prototype). The API keeps one description string; variants may show sections separately.
export type Posting = { about: string; role: string; requirements: string[]; niceToHave: string[]; benefits: string };
type Track = "engineering" | "web" | "admin";
// A function (hoisted) because sampleApplications above is built at module load.
function requirementsFor(track: Track) {
  return ({
  engineering: { must: ["2+ years building production software", "Strong TypeScript and modern React", "Experience with relational databases", "Writing automated tests", "Clear written communication"], nice: ["Accessibility expertise", "CI/CD and Docker"] },
  web: { must: ["Experience maintaining websites in a CMS", "Solid HTML, CSS and JavaScript", "Accessibility and SEO best practices", "Working with designers on page layouts", "Clear written communication"], nice: ["WordPress or Shopify themes", "Analytics and reporting"] },
  admin: { must: ["Advanced Excel: lookups, pivot tables, formulas", "Maintaining records and trackers accurately", "Comfort with reporting tools", "Coordinating with several teams", "Clear written communication"], nice: ["Bilingual (French)", "Billing or invoicing experience"] },
  } satisfies Record<Track, { must: string[]; nice: string[] }>)[track];
}
export function posting(company: string, role: string, track: Track): Posting {
  const req = requirementsFor(track);
  return {
    about: `${company} builds products and services used by thousands of customers across Canada.`,
    role: `As ${/^[AEIOU]/i.test(role) ? "an" : "a"} ${role}, you will own your work end to end, collaborate across teams and help improve how we operate.`,
    requirements: [...req.must], niceToHave: [...req.nice],
    benefits: "Health and dental, flexible hours, learning budget.",
  };
}
function description(company: string, role: string, track: Track) {
  const p = posting(company, role, track);
  return `About ${company}\n${p.about}\n\nThe role\n${p.role}\n\nWhat you bring\n${p.requirements.map((r) => `• ${r}`).join("\n")}\n\nNice to have\n${p.niceToHave.map((r) => `• ${r}`).join("\n")}\n\nBenefits\n${p.benefits}`;
}

// Requirement → resume evidence: the first resume bullet or line mentioning a requirement's terms (prototype heuristic).
const synonyms: Record<string, string[]> = {
  "production software": ["Present", "Developer"], typescript: ["TypeScript"], react: ["React"], "relational databases": ["PostgreSQL", "SQLite", "SQL", "Prisma"],
  "automated tests": ["unit tests", "Playwright", "tests"], communication: ["Collaborated", "Reported directly", "Marketing"], accessibility: ["accessibility", "axe-core"],
  "ci/cd": ["GitHub Actions", "CI/CD"], cms: ["TeamSite", "WordPress", "content"], "html, css": ["HTML", "CSS"], seo: ["SEO", "Lighthouse"],
  designers: ["mock", "designers", "campaign"], excel: ["Excel"], "records and trackers": ["tracker", "records"], "reporting tools": ["report", "CSV", "Excel files"],
  "several teams": ["Collaborated", "team", "Marketing"], french: ["French"], billing: ["invoic", "billing"], wordpress: ["WordPress", "Shopify"], analytics: ["analytics", "Lighthouse"],
};
export function findEvidence(requirement: string, resume: string): string | null {
  const lines = resume.split("\n").map((l) => l.replace(/^[-*•]\s+/, "").trim()).filter((l) => l && !l.startsWith("#"));
  const terms = Object.entries(synonyms).filter(([k]) => requirement.toLowerCase().includes(k)).flatMap(([, v]) => v);
  for (const term of terms) {
    const hit = lines.find((l) => l.toLowerCase().includes(term.toLowerCase()));
    if (hit) return hit.replace(/\*\*|_/g, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  }
  return null;
}

export const runnerSample = {
  online: true,
  lastHeartbeat: NOW - 40_000,
  version: "1.8.2",
  host: "mac-studio",
  slots: { used: 1, total: 2 },
};

// Weekly counts for the last 10 weeks (prototype).
export const weekly = [
  { week: "Sep 7", drafted: 14, applied: 6, responses: 1 },
  { week: "Sep 14", drafted: 18, applied: 9, responses: 2 },
  { week: "Sep 21", drafted: 11, applied: 7, responses: 1 },
  { week: "Sep 28", drafted: 22, applied: 12, responses: 3 },
  { week: "Oct 5", drafted: 19, applied: 10, responses: 2 },
  { week: "Oct 12", drafted: 25, applied: 15, responses: 4 },
  { week: "Oct 19", drafted: 16, applied: 11, responses: 2 },
  { week: "Oct 26", drafted: 21, applied: 13, responses: 3 },
  { week: "Nov 2", drafted: 27, applied: 17, responses: 5 },
  { week: "Nov 9", drafted: 24, applied: 14, responses: 3 },
];

export function ago(iso: string | number) {
  const t = typeof iso === "number" ? iso : new Date(iso).getTime();
  const m = Math.round((NOW - t) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

export const trackLabels = { engineering: "Engineering", web: "Web", admin: "Admin" } as const;

// Application deadline (prototype-only; not in the API yet). Every 5th listing has none.
const day = 86_400_000;
export function dueAt(a: JobApplication): number | null {
  const n = Number(a.id.slice(-12));
  if (n % 5 === 4) return null;
  return NOW + (((n * 37) % 30) - 6) * day;
}
export function dueLabel(t: number | null) {
  if (t === null) return "—";
  const days = Math.round((t - NOW) / day);
  if (days < 0) return `${-days}d overdue`;
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  return new Date(t).toLocaleDateString("en-CA", { month: "short", day: "numeric" });
}
export const daysUntil = (t: number) => Math.round((t - NOW) / day);

// Review sessions are passed by URL: ?view=review&session=3,7,12 (sample row numbers).
export const rowNumber = (a: JobApplication) => Number(a.id.slice(-12));
export const byRowNumber = (n: number) => sampleApplications.find((a) => rowNumber(a) === n);

// Job brief: the posting boiled down to facts in the Owner's words (prototype data; the agent would write this).
export type JobBrief = {
  doing: string;
  remote: { label: string; confirmed: boolean };
  meetings: string;
  contact: string;
  automatable: "High" | "Medium" | "Low";
  size: { label: string; band: "small" | "mid" | "large" };
  angle: string;
};
const briefs = {
  admin: [
    "Enter billing records into their system and reconcile them against invoices. Each Friday you send one Excel summary to finance. Questions come by email, so calls are rare.",
    "Keep the client tracker spreadsheet up to date and build a monthly report from it. Most of the work is lookups and cleaning data. The team is small and works asynchronously.",
    "Copy about 30 intake forms a day into the records system and answer internal questions by email. The workflow is fixed and documented.",
  ],
  web: [
    "Publish WordPress pages from a content queue that the marketing team fills. Most of the work is formatting copy and images, with the occasional small CSS fix. Requests arrive as tickets, so calls are rare.",
    "Edit Shopify product listings and theme sections, and now and then build a landing page from a designer's mockup. Work arrives in weekly batches from one marketing lead.",
    "Move existing content into a new CMS and fix pages that break along the way. The migration runs six months with a clear checklist, then becomes ongoing site maintenance.",
  ],
  engineering: [
    "Build TypeScript and React features in a team of eight engineers. Expect code reviews, planning meetings and a weekly on-call shift. The work is collaborative and hard to automate.",
    "Own a set of backend services and APIs and ship features from product specs. The team works in two-week sprints with daily standups, and test coverage matters.",
    "Ship full-stack features in a small team with little process. You work directly with the founders and customers, and scope changes often.",
  ],
} as const;
const sizes = [
  { label: "About 15 people", band: "small" }, { label: "About 60 people", band: "small" }, { label: "About 250 people", band: "mid" },
  { label: "About 1,200 people", band: "large" }, { label: "10,000+ people", band: "large" },
] as const;
const angles = {
  small: "Small team: lead with owning work end to end and shipping alone.",
  mid: "Mid-size: lead with measurable time saved for a team.",
  large: "Large company: lead with scale and working inside big teams.",
} as const;
export function jobBrief(a: JobApplication): JobBrief {
  const n = Number(a.id.slice(-12));
  const size = sizes[(n * 3) % sizes.length];
  const remote = a.location?.startsWith("Remote")
    ? { label: "Remote, confirmed", confirmed: true }
    : a.resumeTrack === "engineering"
      ? { label: n % 2 ? "Hybrid, 2 days in office" : "Remote in Canada, confirmed", confirmed: n % 2 === 0 }
      : { label: n % 3 === 0 ? "Not stated" : "Remote, confirmed", confirmed: n % 3 !== 0 };
  const byTrack = {
    admin: { meetings: "Rare", contact: "Low: internal email only", automatable: "High" },
    web: { meetings: "Weekly check-in", contact: "Low: requests from marketing", automatable: n % 2 ? "Medium" : "High" },
    engineering: { meetings: "Daily standup and planning", contact: "High: works inside a team", automatable: "Low" },
  } as const;
  return { doing: briefs[a.resumeTrack][n % 3], remote, ...byTrack[a.resumeTrack], size: { ...size }, angle: angles[size.band] };
}

// Résumé summary helpers. Only the Summary section is tailored per job; everything else is the fixed base résumé.
export type Pillar = "Time saved" | "Money saved" | "Money made" | "Process only";
export function outcomePillar(bullet: string): Pillar {
  if (/\b(cost|costs|saving|savings|cheaper|budget)\b/i.test(bullet)) return "Money saved";
  if (/\b(revenue|sales|users|customers|clients|conversion|signups?|launched)\b/i.test(bullet)) return "Money made";
  if (/\b(hours?|days?|minutes?|weeks?|faster|automat\w*|replac\w*|cut)\b/i.test(bullet)) return "Time saved";
  return "Process only";
}
export function splitResume(markdown: string) {
  const start = markdown.search(/^## Summary\s*$/m);
  if (start < 0) return { head: markdown, bullets: [] as string[], tail: "" };
  const rest = markdown.slice(start).replace(/^## Summary\s*$/m, "");
  const next = rest.search(/^## /m);
  const body = next < 0 ? rest : rest.slice(0, next);
  return {
    head: markdown.slice(0, start),
    bullets: body.split("\n").filter((l) => /^\s*[-*]\s+/.test(l)).map((l) => l.replace(/^\s*[-*]\s+/, "")),
    tail: next < 0 ? "" : rest.slice(next),
  };
}
// Prototype "tailoring": reorder the base summary for the company size (the agent rewrites it in the real flow).
export function tailorSummary(bullets: string[], band: JobBrief["size"]["band"]) {
  const ownership = (b: string) => /\b(only developer|solo|alone|end to end|freelance)\b/i.test(b);
  const scale = (b: string) => (b.match(/\d[\d,.]*\+?/g) ?? []).reduce((max, m) => Math.max(max, Number(m.replace(/[,+]/g, "")) || 0), 0);
  const score = (b: string) => band === "small" ? (ownership(b) ? 1e9 : 0) + scale(b) : band === "large" ? scale(b) : (outcomePillar(b) === "Time saved" ? 1e9 : 0) + scale(b);
  return [...bullets].sort((x, y) => score(y) - score(x));
}
