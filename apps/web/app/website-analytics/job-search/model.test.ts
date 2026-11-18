import { describe, expect, test } from "bun:test";
import type { Application, Visit } from "../contract";
import { filterApplications, isWarm, linkCounts, reached, stageOf, statusOf, timePerPage } from "./model";

const now = Date.parse("2026-11-14T15:00:00Z");
const daysAgo = (n: number) => new Date(now - n * 86_400_000).toISOString();
const visit = (v: Partial<Visit>): Visit => ({ id: crypto.randomUUID(), at: daysAgo(1), link: "Portfolio", scanner: false, device: "desktop", pages: [], ctas: [], ...v });
const app = (a: Partial<Application>): Application => ({
  applicationId: crypto.randomUUID(), code: "c", company: "Co", role: "Dev", resume: "software", resumeLabel: "Software",
  sentAt: daysAgo(3), outcome: "none", outcomeAt: null, portfolioUrl: "https://girke.dev/r/c", visits: [], ...a,
});
const page = (title: string, activeSeconds: number) => ({ path: `/${title}`, title, activeSeconds, scrollPercent: 50 });

describe("job search model", () => {
  test("scanner opens never move an application forward", () => {
    const a = app({ visits: [visit({ scanner: true, pages: [page("Home", 120), page("RBC", 60)], ctas: ["Email"] })] });
    expect(reached(a, "opened")).toBe(false);
    expect(stageOf(a)).toBe("sent");
    expect(isWarm(a, now)).toBe(false);
  });

  test("engaged needs 30 s active or two pages; a reply counts as response even without visits", () => {
    expect(stageOf(app({ visits: [visit({ pages: [page("Home", 12)] })] }))).toBe("opened");
    expect(stageOf(app({ visits: [visit({ pages: [page("Home", 31)] })] }))).toBe("engaged");
    expect(stageOf(app({ visits: [visit({ pages: [page("Home", 5), page("About", 5)] })] }))).toBe("engaged");
    expect(stageOf(app({ visits: [visit({ ctas: ["Email"] })] }))).toBe("intent");
    expect(stageOf(app({ visits: [visit({ ctas: ["Navigation"] })] }))).toBe("opened");
    expect(stageOf(app({ outcome: "replied" }))).toBe("response");
  });

  test("keeps a registry entry without a verified send in All time without counting it in the funnel", () => {
    const unsent = app({ sentAt: null, visits: [visit({ at: daysAgo(1), ctas: ["Email"] })] });
    expect(filterApplications([unsent], { range: "30", resume: "all", status: "all" }, now)).toEqual([]);
    expect(filterApplications([unsent], { range: "all", resume: "all", status: "all" }, now)).toEqual([unsent]);
    expect(reached(unsent, "sent")).toBe(false);
    expect(reached(unsent, "opened")).toBe(false);
    expect(stageOf(unsent)).toBeNull();
    expect(isWarm(unsent, now)).toBe(false);
  });

  test("warm means unanswered and seen this week or more than once", () => {
    expect(statusOf(app({ visits: [visit({ at: daysAgo(2) })] }), now)).toBe("follow");
    expect(statusOf(app({ visits: [visit({ at: daysAgo(12) })] }), now)).toBe("waiting");
    expect(statusOf(app({ visits: [visit({ at: daysAgo(12) }), visit({ at: daysAgo(11) })] }), now)).toBe("follow");
    expect(statusOf(app({ outcome: "interview", visits: [visit({})] }), now)).toBe("responded");
    expect(statusOf(app({ outcome: "rejected" }), now)).toBe("rejected");
  });

  test("filters by date sent, résumé and status", () => {
    const apps = [app({ sentAt: daysAgo(2), resume: "software" }), app({ sentAt: daysAgo(20), resume: "web-cms" }), app({ sentAt: daysAgo(60), outcome: "rejected" })];
    expect(filterApplications(apps, { range: "7", resume: "all", status: "all" }, now)).toHaveLength(1);
    expect(filterApplications(apps, { range: "30", resume: "web-cms", status: "all" }, now)).toHaveLength(1);
    expect(filterApplications(apps, { range: "all", resume: "all", status: "rejected" }, now)).toHaveLength(1);
  });

  test("job type filters keep application-level links and leave ambiguous software roles separate", () => {
    const front = app({ role: "Front-End Engineer", code: "frontend1" });
    const back = app({ role: "Backend Developer", code: "backend1" });
    const devops = app({ role: "Site Reliability Engineer", code: "devops1" });
    const fullStack = app({ role: "Full Stack (Frontend / Backend)" });
    const web = app({ role: "Frontend CMS Developer", resume: "web-cms" });
    const explicitFrontend = app({ role: "Engineer", resume: "frontend" });
    const apps = [front, back, devops, fullStack, web, explicitFrontend];
    const filters = { range: "all", resume: "all", status: "all" };
    expect(filterApplications(apps, { ...filters, jobType: "frontend" }, now)).toEqual([front, explicitFrontend]);
    expect(filterApplications(apps, { ...filters, jobType: "backend" }, now)).toEqual([back]);
    expect(filterApplications(apps, { ...filters, jobType: "devops" }, now)).toEqual([devops]);
    expect(filterApplications(apps, { ...filters, jobType: "full-stack" }, now)).toEqual([fullStack]);
    expect(filterApplications(apps, { ...filters, jobType: "web-cms" }, now)).toEqual([web]);
  });

  test("link counts and time per page only use person visits", () => {
    const a = app({ visits: [visit({ link: "GitHub" }), visit({ link: "Portfolio", pages: [page("RBC", 90), page("Home", 10)] }), visit({ link: "Portfolio", pages: [page("RBC", 30)] }), visit({ link: "RBC demo", scanner: true, pages: [page("Demo", 500)] })] });
    expect(linkCounts([a])).toEqual([{ label: "Portfolio", value: 2 }, { label: "GitHub", value: 1 }]);
    expect(timePerPage(a)).toEqual([{ title: "RBC", seconds: 120 }, { title: "Home", seconds: 10 }]);
  });
});
