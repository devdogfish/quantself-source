// Sample responses for the Website analytics preview, in the exact contract shape (app/website-analytics/contract.ts).
// Fictional data, generated relative to the request time. Also a reference for how the API should apply filters.
import type { Application, ChannelId, Device, JobSearchReport, Visit, WebsiteReport } from "../app/website-analytics/contract";

const dayMs = 86_400_000;
const DAYS = 180;
const channels: ChannelId[] = ["resume", "linkedin", "youtube", "github", "google", "direct"];
const mobileShare: Record<string, number> = { resume: 0.22, linkedin: 0.58, youtube: 0.41, github: 0.08, google: 0.33, direct: 0.2 };
const activeS: Record<string, number> = { resume: 84, linkedin: 41, youtube: 131, github: 77, google: 66, direct: 52 };
const projects = [
  { title: "Banking case study", path: "/work/banking", activeS: 96, read: 71, by: { resume: 58, linkedin: 34, youtube: 3, github: 4, google: 9, direct: 12 } },
  { title: "Banking demo", path: "/work/banking/demo", activeS: 142, read: null, by: { resume: 41, linkedin: 12, youtube: 1, github: 2, google: 2, direct: 6 } },
  { title: "SMS gateway", path: "/work/sms-gateway", activeS: 118, read: 64, by: { resume: 12, linkedin: 6, youtube: 47, github: 14, google: 5, direct: 4 } },
  { title: "Personal dashboard", path: "/work/dashboard", activeS: 74, read: 52, by: { resume: 4, linkedin: 39, youtube: 2, github: 9, google: 1, direct: 5 } },
  { title: "About", path: "/about", activeS: 38, read: 80, by: { resume: 22, linkedin: 18, youtube: 6, github: 3, google: 4, direct: 9 } },
] as { title: string; path: string; activeS: number; read: number | null; by: Record<string, number> }[];
const inquiries = [
  { name: "Harbour Dental", topic: "Website redesign", channel: "google" as const, device: "desktop" as Device, at: 1, status: "new" as const },
  { name: "Maritime Bikes", topic: "Booking system", channel: "linkedin" as const, device: "mobile" as Device, at: 4, status: "call_booked" as const },
  { name: "Seaside Inn", topic: "Spreadsheet to web app", channel: "direct" as const, device: "desktop" as Device, at: 9, status: "replied" as const },
  { name: "Atlantic Tutoring", topic: "SMS reminders", channel: "youtube" as const, device: "desktop" as Device, at: 15, status: "won" as const },
  { name: "County Library", topic: "CMS migration", channel: "google" as const, device: "desktop" as Device, at: 22, status: "lost" as const },
  { name: "Bluenose Brewing", topic: "Online ordering", channel: "linkedin" as const, device: "mobile" as Device, at: 63, status: "won" as const },
];

let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const jitter = (n: number) => Math.max(0, Math.round(n + (rand() - 0.5) * Math.max(1, n * 0.4)));
function value(c: ChannelId, i: number) {
  const growth = 0.45 + (0.55 * i) / DAYS;
  const weekday = (i + 3) % 7 < 5;
  switch (c) {
    case "resume": return jitter(((weekday ? 4 : 1) + (i % 9 === 3 ? 4 : 0)) * (i > DAYS - 45 ? 1 : 0.6));
    case "linkedin": return jitter(3.5 * growth);
    case "youtube": return jitter(1.8 * growth);
    case "github": return jitter(1.6 * growth);
    case "google": return jitter(0.3 + (3 * i) / DAYS);
    default: return jitter(2 * growth);
  }
}
const history = Array.from({ length: DAYS }, (_, i) => ({
  ...Object.fromEntries(channels.map((c) => [c, value(c, i)])) as Record<ChannelId, number>,
  contacts: i % 11 === 4 ? 1 : i % 13 === 7 ? 2 : i % 17 === 3 ? 1 : 0,
}));

export function websiteReport(query: URLSearchParams, now = Date.now()): WebsiteReport {
  const days = (["7", "30", "90"].includes(query.get("range") ?? "") ? Number(query.get("range")) : 30) as 7 | 30 | 90;
  const channel = query.get("channel"), project = projects.find((p) => p.path === query.get("project")), device = query.get("device");
  const weight = (c: ChannelId, withProject = true) => {
    if (channel && channel !== c) return 0;
    let w = device === "mobile" ? mobileShare[c] : device === "desktop" ? 1 - mobileShare[c] : 1;
    if (withProject && project) w *= Math.min(1, project.by[c] / (projects.reduce((s, x) => s + x.by[c], 0) * 0.9));
    return w;
  };
  const dayOf = (i: number) => new Date(now - (DAYS - 1 - i) * dayMs).toISOString().slice(0, 10);
  const firstFullRetainedDay = Math.ceil((now - 90 * dayMs) / dayMs) * dayMs;
  const row = (i: number) => {
    const by = Object.fromEntries(channels.map((c) => [c, Math.round(history[i][c] * weight(c))])) as Record<ChannelId, number>;
    const visitors = channels.reduce((s, c) => s + by[c], 0);
    const all = channels.reduce((s, c) => s + history[i][c], 0);
    const base = project ? project.activeS : channels.reduce((s, c) => s + by[c] * activeS[c], 0) / Math.max(1, visitors);
    return { by, visitors, active: Math.round(base * (0.85 + ((i * 37) % 30) / 100)), contacts: history[i].contacts && visitors / Math.max(1, all) > 0.3 ? history[i].contacts : 0 };
  };
  const daily = Array.from({ length: days }, (_, k) => {
    const i = DAYS - days + k, a = row(i), b = row(i - days);
    const hasPrevious = Date.parse(dayOf(i - days)) >= firstFullRetainedDay;
    const byChannel = Object.fromEntries(channels.filter((c) => a.by[c]).map((c) => [c, a.by[c]]));
    return { day: dayOf(i), visitors: a.visitors, previousVisitors: hasPrevious ? b.visitors : null, avgActiveSeconds: a.active, previousAvgActiveSeconds: hasPrevious ? b.active : null, contactClicks: a.contacts, previousContactClicks: hasPrevious ? b.contacts : null, byChannel };
  });
  const previousPeriod = daily.every(d => d.previousVisitors !== null) ? "complete" : daily.some(d => d.previousVisitors !== null) ? "partial" : "unavailable";
  const sum = (k: "visitors" | "previousVisitors" | "contactClicks" | "previousContactClicks") => daily.reduce((s, d) => s + (d[k] ?? 0), 0);
  const avg = (k: "avgActiveSeconds" | "previousAvgActiveSeconds", w: "visitors" | "previousVisitors") => Math.round(daily.reduce((s, d) => s + (d[k] ?? 0) * (d[w] ?? 0), 0) / Math.max(1, sum(w)));
  const inRange = inquiries.filter((x) => x.at < days && (!channel || x.channel === channel) && (!device || x.device === device));
  const scale = days / 30;
  return {
    generatedAt: new Date(now).toISOString(), lastEventAt: new Date(now - 4 * 60_000).toISOString(), excludedScanners: Math.round(77 * scale),
    range: { days, from: dayOf(DAYS - days), to: dayOf(DAYS - 1) }, previousPeriod,
    totals: { visitors: sum("visitors"), previousVisitors: previousPeriod === "complete" ? sum("previousVisitors") : null, avgActiveSeconds: avg("avgActiveSeconds", "visitors"), previousAvgActiveSeconds: previousPeriod === "complete" ? avg("previousAvgActiveSeconds", "previousVisitors") : null, contactClicks: sum("contactClicks"), previousContactClicks: previousPeriod === "complete" ? sum("previousContactClicks") : null },
    daily,
    channels: channels.map((c) => ({ id: c, visitors: daily.reduce((s, d) => s + (d.byChannel[c] ?? 0), 0) })).filter((c) => c.visitors > 0).sort((a, b) => b.visitors - a.visitors)
      .map((c) => ({ ...c, avgActiveSeconds: activeS[c.id], contactClicks: Math.round((c.visitors / 40) * (activeS[c.id] / 80)), inquiries: inRange.filter((x) => x.channel === c.id).length })),
    projects: projects.map((p) => {
      const byChannel = Object.fromEntries(channels.map((c) => [c, Math.round(p.by[c] * scale * weight(c, false))]).filter(([, v]) => v)) as Partial<Record<ChannelId, number>>;
      return { path: p.path, title: p.title, views: Object.values(byChannel).reduce((s, v) => s + (v ?? 0), 0), avgActiveSeconds: p.activeS, readTo75Percent: p.read, byChannel };
    }).sort((a, b) => b.views - a.views),
    inquiries: inRange.map((x, k) => ({ id: `inq-${k}`, name: x.name, topic: x.topic, email: "hello@example.com", channel: x.channel, receivedAt: new Date(now - x.at * dayMs).toISOString(), status: x.status })),
  };
}

const page = (title: string, path: string, activeSeconds: number, scrollPercent: number | null) => ({ title, path, activeSeconds, scrollPercent });
const P = {
  home: (a: number, s: number) => page("Home", "/", a, s), case: (a: number, s: number) => page("Banking case study", "/work/banking", a, s),
  demo: (a: number) => page("Banking demo", "/work/banking/demo", a, null), sms: (a: number, s: number) => page("SMS gateway", "/work/sms-gateway", a, s),
  about: (a: number, s: number) => page("About", "/about", a, s), contact: (a: number, s: number) => page("Contact", "/contact", a, s),
};
const resumes = { software: "Software", "web-cms": "Web / CMS", "admin-excel": "Admin / Excel" } as const;

export function jobSearchReport(now = Date.now()): JobSearchReport {
  const at = (daysAgo: number, minutes = 0) => new Date(now - daysAgo * dayMs + minutes * 60_000).toISOString();
  let n = 0;
  const v = (daysAgo: number, link: string, pages: Visit["pages"] = [], extra: Partial<Visit> = {}): Visit => ({ id: `v${++n}`, at: at(daysAgo), link, scanner: false, device: "desktop", pages, ctas: [], ...extra });
  const scan = (sentDaysAgo: number, link = "Portfolio"): Visit => ({ id: `v${++n}`, at: at(sentDaysAgo, 0.1), link, scanner: true, device: null, pages: [], ctas: [] });
  const app = (id: string, company: string, role: string, resume: keyof typeof resumes, sent: number | null, outcome: Application["outcome"], visits: Visit[], outcomeAgo?: number): Application => {
    const hexId = Array.from(id, char => char.charCodeAt(0).toString(16)).join("");
    const code = hexId.padStart(24, "0");
    return {
      applicationId: `00000000-0000-4000-8000-${hexId.padStart(12, "0")}`, code, company, role, resume, resumeLabel: resumes[resume], sentAt: sent === null ? null : at(sent),
      outcome, outcomeAt: outcomeAgo === undefined ? null : at(outcomeAgo), portfolioUrl: `https://example.com/r/${code}`, visits: visits.sort((a, b) => b.at.localeCompare(a.at)),
    };
  };
  return {
    generatedAt: new Date(now).toISOString(), lastEventAt: at(0, -4), excludedScanners: 11,
    shares: [
      { code: "K3Vw9QpX", title: "Client website footer", track: "client", archived: false, opens: 44, visits: 28 },
      { code: "A7gd38MC", title: "LinkedIn profile", track: "backend", archived: false, opens: 12, visits: 7 },
      { code: "W9b57jQ2", title: "YouTube channel", track: null, archived: false, opens: 0, visits: 0 },
    ],
    applications: [
      app("a1", "Northwind", "Software Developer Intern", "software", 2, "none", [scan(2), v(1, "Portfolio", [P.home(22, 64), P.case(148, 92), P.demo(96)]), v(1, "GitHub")]),
      app("b2", "Contoso", "Full-Stack Engineer", "software", 4, "interview", [scan(4), v(3, "Banking demo", [P.demo(212), P.case(74, 81)]), v(3, "Portfolio", [P.home(31, 88), P.about(40, 100), P.contact(12, 60)], { ctas: ["Email"] }), v(2, "Portfolio", [P.home(18, 70), P.case(52, 66)], { device: "mobile" })], 1),
      app("c3", "Fabrikam", "Backend Developer", "software", 5, "replied", [v(4, "Banking case study", [P.case(186, 100), P.demo(61)]), v(4, "Portfolio", [P.home(14, 45)], { ctas: ["Email"] })], 3),
      app("d4", "Coastal Health", "Web Content Coordinator", "web-cms", 6, "none", [scan(6), scan(6, "Banking case study")]),
      app("e5", "Adatum", "Junior Software Engineer", "software", 7, "rejected", [scan(7), v(6, "Portfolio", [P.home(9, 30)])], 2),
      app("f6", "Harbour University", "Web Developer (Drupal)", "web-cms", 8, "none", [v(6.5, "Portfolio", [P.home(26, 72), P.sms(88, 90)])]),
      app("g7", "Tidewater Energy", "Business Systems Analyst", "admin-excel", 9, "none", []),
      app("h8", "Litware", "Software Developer", "software", 10, "none", [scan(10), v(9, "GitHub"), v(9, "SMS gateway source")]),
      app("i9", "Port Authority", "Office Administrator", "admin-excel", 11, "none", [scan(11)]),
      app("j10", "Tailspin", "DevOps Engineer", "software", 12, "interview", [v(11, "Portfolio", [P.home(40, 96), P.case(121, 100), P.sms(63, 74), P.contact(20, 100)], { ctas: ["Email", "Download résumé"] }), v(9, "Banking demo", [P.demo(305)])], 6),
      app("k11", "Province Digital", "Digital Services Developer", "web-cms", 13, "none", [scan(13), v(12, "Portfolio", [P.home(11, 38)], { device: "mobile" })]),
      app("l12", "Wingtip", "Software Developer Co-op", "software", 15, "rejected", [], 8),
      app("m13", "Children's Foundation", "Website & CRM Coordinator", "web-cms", 17, "replied", [v(16, "Portfolio", [P.home(35, 90), P.about(28, 100), P.sms(47, 61)])], 14),
      app("n14", "Shipyard Group", "Data / Excel Analyst", "admin-excel", 19, "none", [scan(19)]),
      app("o15", "Proseware", "Frontend Developer", "software", 21, "none", [scan(21), v(20, "Portfolio", [P.home(19, 55), P.case(44, 48)])]),
      app("p16", "Grocer Co", "Admin Assistant, IT", "admin-excel", 23, "none", []),
      app("q17", "Bluewave", "Web Developer", "web-cms", 25, "none", [v(24, "Portfolio", [P.home(7, 20)])]),
      app("r18", "Northwind", "Developer, Checkout", "software", 48, "rejected", [scan(48)], 40),
      app("s19", "Example Studio", "Web Developer", "web-cms", null, "none", []),
    ],
  };
}
