import { analyzeWebsiteEvents, ctaKey, deviceClass, pageTitle, sessionPages, type WebsiteAnalyticsRow } from "./website-analytics-events";
import type { JobSearchReport, JobSearchVisit } from "./website-analytics-report-contract";

export type RegisteredApplication = {
  applicationId: string;
  code: string;
  cohort: string;
  company: string;
  role: string;
  sentAt: number | null;
  status: string | null;
};

export type RegisteredShare = Pick<JobSearchReport["shares"][number], "code" | "title" | "track" | "archived">;

const resumeLabels: Record<string, string> = {
  software: "Software", "web-cms": "Web / CMS", "admin-excel": "Admin / Excel",
  devops: "DevOps", frontend: "Frontend", backend: "Backend", "full-stack": "Full Stack",
};
const ctaLabels: Record<string, string> = {
  resume: "Résumé", download: "Download résumé", resume_download: "Download résumé",
  repository: "Source", repository_open: "Source", demo: "Demo", demo_open: "Demo",
  contact: "Contact", contact_open: "Contact", email: "Email", email_click: "Email", booking: "Booking", booking_click: "Booking",
  project: "Project", project_open: "Project", github: "GitHub", linkedin: "LinkedIn", "live-site": "Live site",
};

const iso = (ms: number) => new Date(ms).toISOString();

function destinationLabel(event?: WebsiteAnalyticsRow) {
  if (!event) return "Portfolio";
  const suffix = event.path.split("/").slice(3);
  const key = typeof event.props.key === "string" ? event.props.key : suffix.join("/");
  if (!key) return "Portfolio";
  if (key === "github" || key === "profile/github") return "GitHub";
  if (key === "linkedin" || key === "profile/linkedin") return "LinkedIn";
  return pageTitle(`/${key}`);
}

export function buildJobSearchReport(rows: readonly WebsiteAnalyticsRow[], registry: readonly RegisteredApplication[], now: number, shares: readonly RegisteredShare[] = []): JobSearchReport {
  const visitsByCode = new Map<string, JobSearchVisit[]>(registry.map(row => [row.code, []]));
  const sharesByCode = new Map(shares.map(share => [share.code, { ...share, opens: 0, visits: 0 }]));
  for (const event of rows) {
    if (event.kind !== "link:open" || !event.linkCode || event.props.source === "synthetic") continue;
    const share = sharesByCode.get(event.linkCode);
    if (share) share.opens++;
  }
  const activity = analyzeWebsiteEvents(rows, new Map(registry.map(row => [row.code, row.sentAt])));
  for (const { entry, events, redirect } of activity.visits) {
    if (!entry.linkCode) continue;
    const share = sharesByCode.get(entry.linkCode);
    if (share) share.visits++;
    visitsByCode.get(entry.linkCode)?.push({
      id: `browser:${entry.sessionId}`, at: iso(redirect?.at ?? entry.at), link: destinationLabel(redirect),
      scanner: false, device: deviceClass(entry.device),
      pages: sessionPages(events).map(page => ({
        path: page.path, title: pageTitle(page.path), activeSeconds: page.activeMs / 1000, scrollPercent: page.scrollPercent,
      })),
      ctas: events.flatMap(event => {
        const key = ctaKey(event);
        return key ? [Object.hasOwn(ctaLabels, key) ? ctaLabels[key] : pageTitle(`/${key}`)] : [];
      }),
    });
  }
  let excludedScanners = 0;
  for (const row of activity.scanners) {
    const visits = row.linkCode ? visitsByCode.get(row.linkCode) : undefined;
    if (!visits) continue;
    excludedScanners++;
    visits.push({
      id: `redirect:${row.id}`, at: iso(row.at), link: destinationLabel(row),
      scanner: true, device: null, pages: [], ctas: [],
    });
  }

  return {
    generatedAt: iso(now), lastEventAt: activity.lastEventAt === null ? null : iso(activity.lastEventAt), excludedScanners,
    shares: [...sharesByCode.values()].sort((a, b) => a.title.localeCompare(b.title) || a.code.localeCompare(b.code)),
    applications: registry.map(row => ({
      applicationId: row.applicationId, code: row.code, company: row.company, role: row.role,
      resume: row.cohort, resumeLabel: Object.hasOwn(resumeLabels, row.cohort) ? resumeLabels[row.cohort] : pageTitle(`/${row.cohort}`),
      sentAt: row.sentAt === null ? null : iso(row.sentAt),
      outcome: row.status === "interviewing" ? "interview" : row.status === "rejected" ? "rejected" : "none",
      outcomeAt: null, portfolioUrl: `https://girke.dev/r/${row.code}`,
      visits: visitsByCode.get(row.code)!.sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id)),
    })),
  };
}
