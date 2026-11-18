import { createTestDom } from "@/components/shared/test-dom";
import { expect, mock, spyOn, test } from "bun:test";
import { act } from "react";
import type { ApplicationDetail } from "../jobs-client";

const postingText = "Build accessible dashboards.\n\nMaintain the job pipeline.";
const sourceUrl = "https://jobs.example.test/original";
const draft: ApplicationDetail = {
  id: "saved", company: "Fixture Studio", role: "Engineer", track: "web", status: "review",
  issue: null, verdict: null, dueAt: null, source: null, sourceUrl,
  updatedAt: "2026-11-16T00:00:00Z", appliedAt: null, brief: null, postingText,
  revision: 1, approvedRevision: null, summaryMarkdown: "- Build accessible dashboards",
  resumeMarkdown: "# {{fullName}}\n\n{{contact}}\n\n## Summary\n\n- Build accessible dashboards\n", pdfUrl: null,
};
const items: ApplicationDetail[] = [
  draft,
  { ...draft, id: "empty", postingText: " \n " },
  { ...draft, id: "failed", status: "needs_attention", issue: "model_error" },
  { ...draft, id: "brief", brief: {
    doing: "Own the dashboard roadmap.", remote: "confirmed",
    pay: { hourlyCad: { min: 45, max: 50 }, original: null, converted: false },
    companySize: { people: null, label: "Small company" }, automatable: "high",
    humanContact: { level: "low", note: "Mostly async" }, meetings: { level: "rare", note: "Rarely" },
  } },
];
const ids = items.map(({ id }) => id).join(",");
let location = `/jobs/review?ids=${ids}`;
const push = mock((_href: string) => {});

mock.module("next/navigation", () => ({
  usePathname: () => location.split("?")[0],
  useRouter: () => ({ push, replace() {} }),
  useSearchParams: () => new URLSearchParams(location.split("?")[1]),
}));
mock.module("../../todo/todo-notes-editor", () => ({
  TodoNotesEditor: ({ value, readOnly, onCommit }: { value: string; readOnly: boolean; onCommit(before: string, after: string): void }) =>
    <textarea aria-label="Fixture résumé" value={value} readOnly={readOnly} onChange={event => onCommit(value, event.currentTarget.value)} />,
}));
const buildJobsDraftPdf = mock(async (_markdown: string) => new Uint8Array([1, 2, 3]));
mock.module("@/lib/jobs-draft-pdf", () => ({ buildJobsDraftPdf }));
mock.module("../resume-pdf-viewer", () => ({
  ResumePdfViewer: ({ title, pdfUrl }: { title: string; pdfUrl: string }) => <div aria-label={title} data-pdf-url={pdfUrl} />,
}));

const dom = createTestDom();

test("review renders the saved posting immediately when a brief is absent", async () => {
  const loadSession = async (input: Parameters<typeof fetch>[0]) => {
    if (input === `/api/v1/jobs/review-session?ids=${ids}`) return Response.json({ items });
    throw new Error(`Unexpected review request: ${input}`);
  };
  const fetchSession = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(loadSession, { preconnect: fetch.preconnect }),
  );
  try {
    const { ReviewSessionPage } = await import("./review-session");
    await dom.render(<ReviewSessionPage />);
    const next = () => dom.click(dom.container.querySelector('button[aria-label="Next"]')!);
    const toggle = () => [...dom.container.querySelectorAll("button")].find((button) => /posting details/i.test(button.textContent ?? ""));
    const employerLink = () => dom.container.querySelector(`a[href="${sourceUrl}"]`);

    expect(dom.container.textContent).toContain(postingText);
    expect(dom.container.textContent).not.toContain("The brief is still being written.");
    expect(toggle()?.getAttribute("aria-expanded")).toBe("true");
    expect(employerLink()?.textContent).toBe("View job listing");
    expect(employerLink()?.getAttribute("target")).toBe("_blank");
    expect(buildJobsDraftPdf).not.toHaveBeenCalled();
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "p" })));
    await act(async () => { await Promise.resolve(); });
    expect(buildJobsDraftPdf).toHaveBeenCalledWith(draft.resumeMarkdown);
    expect(document.body.querySelector('[aria-label="Fixture Studio draft résumé PDF"]')?.getAttribute("data-pdf-url")).toMatch(/^blob:/);
    await act(async () => { document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "f" })));
    expect(dom.container.querySelector('textarea[aria-label="Fixture résumé"]')).toBeTruthy();
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "d" })));
    expect(dom.container.textContent).not.toContain(postingText);

    await next();
    expect(employerLink()).toBeTruthy();
    expect(dom.container.textContent).not.toContain(postingText);

    await next();
    expect(dom.container.textContent).toContain("The draft failed.");
    expect(dom.container.textContent).toContain("Retry draft");
    expect(dom.container.textContent).toContain(postingText);

    await next();
    expect(dom.container.textContent).toContain("Own the dashboard roadmap.");
    expect(dom.container.textContent).toContain("$45–$50/h");
    expect(dom.container.textContent).toContain("Remote confirmed");
    expect(dom.container.textContent).toContain("Low touch");
    expect(employerLink()).toBeTruthy();
    expect(dom.container.textContent).not.toContain(postingText);
    await dom.click(toggle()!);
    expect(dom.container.textContent).toContain(postingText);
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "d" })));
    expect(dom.container.textContent).not.toContain(postingText);
    expect(fetchSession).toHaveBeenCalledTimes(1);
  } finally {
    fetchSession.mockRestore();
  }
});

test("review keeps a newer Markdown edit visible while an earlier save resolves", async () => {
  const patch = `/api/v1/jobs/applications/${draft.id}`;
  const requests: Array<{ expectedRevision: number; summaryMarkdown: string }> = [];
  const first = Promise.withResolvers<Response>();
  const second = Promise.withResolvers<Response>();
  const load = async (input: Parameters<typeof fetch>[0], options?: RequestInit) => {
    if (input === `/api/v1/jobs/review-session?ids=${ids}`) return Response.json({ items });
    if (input === patch) {
      requests.push(JSON.parse(String(options?.body)));
      return requests.length === 1 ? first.promise : second.promise;
    }
    throw new Error(`Unexpected review request: ${input}`);
  };
  const fetchSession = spyOn(globalThis, "fetch").mockImplementation(Object.assign(load, { preconnect: fetch.preconnect }));
  try {
    const { ReviewSessionPage } = await import("./review-session");
    await dom.render(<ReviewSessionPage />);
    const field = dom.container.querySelector<HTMLInputElement>('textarea[aria-label="Fixture résumé"]')!;
    const before = "- [First](https://example.com)";
    const after = `${before}\n- Second`;
    await dom.type(field, before);
    await dom.type(field, after);
    expect(field.value).toBe(after);
    expect(requests).toEqual([{ expectedRevision: 1, summaryMarkdown: before }]);
    await act(async () => first.resolve(Response.json({ application: { ...draft, revision: 2, summaryMarkdown: before } })));
    expect(field.value).toBe(after);
    expect(requests.at(-1)).toEqual({ expectedRevision: 2, summaryMarkdown: after });
    await act(async () => second.resolve(Response.json({ application: { ...draft, revision: 3, summaryMarkdown: after } })));
    expect(field.value).toBe(after);
  } finally {
    fetchSession.mockRestore();
  }
});

const applicationPath = `/api/v1/jobs/applications/${draft.id}`;
const press = (key: string) => act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key })); });
const resumeField = () => dom.container.querySelector<HTMLInputElement>('textarea[aria-label="Fixture résumé"]')!;
const reviewButton = (name: RegExp) => [...dom.container.querySelectorAll("button")]
  .find((button) => name.test(button.getAttribute("aria-label") ?? button.textContent ?? ""));
const { revision: _revision, approvedRevision: _approval, summaryMarkdown: _summary, resumeMarkdown: _resume,
  postingText: _posting, brief: _brief, pdfUrl: _pdf, ...draftRow } = draft;

test("a saved-for-later draft stays read-only in both scopes until review resumes", async () => {
  const reopen = Promise.withResolvers<Response>();
  const requests: unknown[] = [];
  const savedRevision = 7;
  const updatedResume = `${draft.resumeMarkdown}\n## Experience`;
  const load = async (input: Parameters<typeof fetch>[0], options?: RequestInit) => {
    if (input === `/api/v1/jobs/review-session?ids=${ids}`) {
      return Response.json({ items: [{ ...draft, status: "saved_for_later", revision: savedRevision }, ...items.slice(1)] });
    }
    requests.push(JSON.parse(String(options?.body)));
    if (input === `${applicationPath}/decision`) return reopen.promise;
    if (input === applicationPath) {
      return Response.json({ application: { ...draft, revision: savedRevision + 1, resumeMarkdown: updatedResume } });
    }
    throw new Error(`Unexpected review request: ${input}`);
  };
  const fetchSession = spyOn(globalThis, "fetch").mockImplementation(Object.assign(load, { preconnect: fetch.preconnect }));
  try {
    const { ReviewSessionPage } = await import("./review-session");
    await dom.render(<ReviewSessionPage />);
    expect(resumeField().readOnly).toBe(true);
    expect(resumeField().value).toBe(draft.summaryMarkdown);
    const decisions = /^(Approve|Skip|Later|Reject|Revise with AI)/;
    expect(reviewButton(decisions)).toBeUndefined();
    for (const key of ["1", "2", "h", "r", "x"]) await press(key);
    expect(requests).toEqual([]);
    expect(dom.container.querySelector("textarea[placeholder^=Instructions]")).toBeNull();
    expect(dom.container.textContent).not.toContain("Wrong fit");

    await press("f");
    expect(resumeField().readOnly).toBe(true);
    expect(resumeField().value).toBe(draft.resumeMarkdown);
    await dom.click(reviewButton(/^Preview PDF/)!);
    expect(document.body.querySelector('[aria-label="Fixture Studio draft résumé PDF"]')).toBeTruthy();
    await act(async () => { document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });

    await dom.click(reviewButton(/^Resume review$/)!);
    expect(resumeField().readOnly).toBe(true);
    expect(reviewButton(decisions)).toBeUndefined();
    expect(requests).toEqual([{ action: "reopen", expectedRevision: savedRevision }]);
    await dom.click(reviewButton(/^Next$/)!);
    expect(resumeField().readOnly).toBe(false);
    await dom.click(reviewButton(/^Previous$/)!);
    expect(resumeField().readOnly).toBe(true);
    await press("f");
    expect(resumeField().readOnly).toBe(true);
    await act(async () => reopen.resolve(Response.json({ application: draftRow })));
    expect(resumeField().readOnly).toBe(false);
    expect(reviewButton(/^Approve/)).toBeTruthy();
    await dom.type(resumeField(), updatedResume);
    expect(requests.at(-1)).toEqual({ expectedRevision: savedRevision, resumeMarkdown: updatedResume });
    expect(resumeField().value).toBe(updatedResume);
  } finally {
    fetchSession.mockRestore();
  }
});

test("a late Later response keeps an optimistic Undo editable", async () => {
  const later = Promise.withResolvers<Response>();
  const reopen = Promise.withResolvers<Response>();
  const requests: unknown[] = [];
  const updatedSummary = "- Updated résumé";
  const load = async (input: Parameters<typeof fetch>[0], options?: RequestInit) => {
    if (input === `/api/v1/jobs/review-session?ids=${ids}`) return Response.json({ items });
    requests.push(JSON.parse(String(options?.body)));
    if (input === `${applicationPath}/decision`) return requests.length === 1 ? later.promise : reopen.promise;
    if (input === applicationPath) {
      return Response.json({ application: { ...draft, revision: 2, summaryMarkdown: updatedSummary } });
    }
    throw new Error(`Unexpected review request: ${input}`);
  };
  const fetchSession = spyOn(globalThis, "fetch").mockImplementation(Object.assign(load, { preconnect: fetch.preconnect }));
  try {
    const { ReviewSessionPage } = await import("./review-session");
    await dom.render(<ReviewSessionPage />);
    await press("h");
    await press("z");
    expect(resumeField().readOnly).toBe(false);
    expect(requests).toEqual([{ action: "later", expectedRevision: 1 }]);
    await act(async () => later.resolve(Response.json({ application: { ...draftRow, status: "saved_for_later" } })));
    expect(resumeField().readOnly).toBe(false);
    await dom.type(resumeField(), updatedSummary);
    expect(resumeField().value).toBe(updatedSummary);
    expect(requests).toEqual([{ action: "later", expectedRevision: 1 }, { action: "reopen", expectedRevision: 1 }]);
    await act(async () => reopen.resolve(Response.json({ application: draftRow })));
    expect(requests.at(-1)).toEqual({ expectedRevision: 1, summaryMarkdown: updatedSummary });
    expect(resumeField().value).toBe(updatedSummary);
  } finally {
    fetchSession.mockRestore();
  }
});

test("Owner opens a missing brief from the drawer and replays one save across résumé acknowledgements", async () => {
  const firstResume = Promise.withResolvers<Response>();
  const nextResume = Promise.withResolvers<Response>();
  const lostBrief = Promise.withResolvers<Response>();
  const lostRetry = Promise.withResolvers<Response>();
  const briefRequests: Array<{ key: string; body: string }> = [];
  const resumeRequests: Array<{ expectedRevision: number; summaryMarkdown: string }> = [];
  const savedBrief = { ...items[3].brief!, pay: { hourlyCad: null, original: null, converted: false } };
  const load = async (input: Parameters<typeof fetch>[0], options?: RequestInit) => {
    if (String(input).startsWith("/api/v1/jobs/applications?")) {
      return Response.json({ rows: [draftRow], total: 1, pageSize: 15, tabCounts: { all: 1, review: 1 } });
    }
    if (input === `${applicationPath}/lifecycle`) {
      return Response.json({ application: draftRow, transitions: [], appointments: [], revision: 0 });
    }
    if (input === `/api/v1/jobs/review-session?ids=${draft.id}`) return Response.json({ items: [draft] });
    if (input === applicationPath) {
      resumeRequests.push(JSON.parse(String(options?.body)));
      return resumeRequests.length === 1 ? firstResume.promise : nextResume.promise;
    }
    if (input === `${applicationPath}/brief`) {
      briefRequests.push({ key: new Headers(options?.headers).get("Idempotency-Key")!, body: String(options?.body) });
      if (briefRequests.length === 1) return lostBrief.promise;
      if (briefRequests.length === 2) return lostRetry.promise;
      return Response.json({ id: draft.id });
    }
    throw new Error(`Unexpected review request: ${input}`);
  };
  const fetchSession = spyOn(globalThis, "fetch").mockImplementation(Object.assign(load, { preconnect: fetch.preconnect }));
  const formData = globalThis.FormData;
  globalThis.FormData = window.FormData;
  try {
    location = `/jobs/applications?applicationId=${draft.id}`;
    const { JobsApplications } = await import("../applications/jobs-applications");
    await dom.render(<JobsApplications />);
    const drawer = document.body.querySelector('[role="dialog"]')!;
    const startReview = [...drawer.querySelectorAll("button")].find((button) => button.textContent === "Review")!;
    await dom.click(startReview);
    expect(push).toHaveBeenLastCalledWith(`/jobs/review?ids=${draft.id}`);
    location = `/jobs/review?ids=${draft.id}`;
    const { ReviewSessionPage } = await import("./review-session");
    await dom.render(<ReviewSessionPage />);

    const firstSummary = "- First Owner edit";
    const nextSummary = "- Newer Owner edit";
    await dom.type(resumeField(), firstSummary);
    await dom.click(dom.container.querySelector("summary")!);
    const form = dom.container.querySelector<HTMLFormElement>('form[aria-label="Missing job brief"]')!;
    const fields = {
      doing: savedBrief.doing, company: savedBrief.companySize.label, remote: savedBrief.remote,
      automatable: savedBrief.automatable, contact: savedBrief.humanContact.level, contactNote: savedBrief.humanContact.note,
      meetings: savedBrief.meetings.level, meetingNote: savedBrief.meetings.note,
    };
    for (const [name, value] of Object.entries(fields)) {
      (form.elements.namedItem(name) as HTMLInputElement).value = value;
    }
    expect(form.checkValidity()).toBe(true);
    await dom.click(reviewButton(/^Save brief$/)!);
    expect(form.querySelector("fieldset")?.disabled).toBe(true);
    await dom.type(resumeField(), nextSummary);
    expect(briefRequests).toEqual([]);
    expect(resumeField().value).toBe(nextSummary);

    await act(async () => firstResume.resolve(Response.json({ application: { ...draft, revision: 2, summaryMarkdown: firstSummary } })));
    expect(briefRequests).toHaveLength(1);
    expect(JSON.parse(briefRequests[0].body)).toEqual({ expectedRevision: 2, brief: savedBrief });
    expect(resumeField().value).toBe(nextSummary);
    await act(async () => lostBrief.reject(new TypeError("lost commit response")));
    expect(briefRequests[1]).toEqual(briefRequests[0]);
    await act(async () => lostRetry.reject(new TypeError("replay response lost")));
    expect(dom.container.textContent).toContain("Save could not be confirmed.");
    expect(resumeRequests.at(-1)).toEqual({ expectedRevision: 2, summaryMarkdown: nextSummary });

    await dom.click(reviewButton(/^Retry saving brief$/)!);
    expect(briefRequests).toHaveLength(2);
    await act(async () => nextResume.resolve(Response.json({
      application: { ...draft, revision: 3, summaryMarkdown: nextSummary, brief: savedBrief },
    })));
    expect(briefRequests[2]).toEqual(briefRequests[0]);
    expect(resumeField().value).toBe(nextSummary);
    expect(dom.container.textContent).toContain(savedBrief.doing);
    expect(dom.container.textContent).toContain("v3");
    expect(fetchSession).toHaveBeenCalledTimes(8);
  } finally {
    location = `/jobs/review?ids=${ids}`;
    globalThis.FormData = formData;
    fetchSession.mockRestore();
  }
});
