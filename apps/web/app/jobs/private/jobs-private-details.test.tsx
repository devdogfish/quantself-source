import { expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { candidateRulesDisplay } from "../../../../../scripts/jobs/candidate-rules";
import { candidateRules, screeningPosting } from "../../../../../scripts/jobs/candidate-rules.fixture";
import type { FieldMetadata, PrivateFieldWrite } from "./private-api";

mock.module("next/navigation", () => ({ usePathname: () => window.location.pathname, useRouter: () => ({ push() {}, replace() {} }) }));

const applicationId = "8ec63eb5-99b7-4892-95cb-4aed184f3c9e";
const firstName: FieldMetadata = { id: "first-name", key: "firstName", label: "First name", type: "text", scope: { kind: "global" }, options: [], hasValue: true, version: 2, updatedAt: "2026-11-10T00:00:00Z" };
const history: FieldMetadata = { ...firstName, id: "history", key: "question.history-fixture", label: "Work History", scope: { kind: "listing", applicationId }, hasValue: false, version: 1 };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function mountDetails(fetchRequest: (path: string, init: RequestInit) => Promise<Response>, contextMarkdown?: string, profile = false) {
  const dom = new Window({ url: `http://localhost/jobs/private?applicationId=${applicationId}` });
  const keys = ["HTMLStyleElement", "SVGElement", "ResizeObserver", "requestAnimationFrame", "cancelAnimationFrame", "matchMedia", "window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLSelectElement", "Element", "Event", "Node", "DocumentFragment", "MutationObserver", "getComputedStyle", "FormData", "IS_REACT_ACT_ENVIRONMENT", "fetch"];
  Object.defineProperty(dom, "matchMedia", { value: (query: string) => ({ matches: false, media: query,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, }) });
  const previous = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of keys) {
    const value = key === "window" ? dom : key === "fetch" ? fetchRequest : key === "getComputedStyle" ? dom.getComputedStyle.bind(dom) : key === "IS_REACT_ACT_ENVIRONMENT" ? true : Reflect.get(dom, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: typeof value === "function" && ["requestAnimationFrame", "cancelAnimationFrame", "matchMedia"].includes(key) ? value.bind(dom) : value });
  }
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { JobsPrivateDetails } = await import("./jobs-private-details");
  const { CandidateApplicationQuestions } = await import("./candidate-application-questions");
  const host = document.createElement("div");
  document.body.append(host);
  const rawRoot = createRoot(host);
  const { CacheProvider } = await import("@emotion/react");
  const { default: createCache } = await import("@emotion/cache");
  const cache = createCache({ key: "jobs-test", container: document.head });
  const { ChakraTestWrapper } = await import("@/components/chakra/test-utils");
  const root = {
    render: (element: Parameters<typeof rawRoot.render>[0]) => rawRoot.render(<CacheProvider value={cache}><ChakraTestWrapper>{element}</ChakraTestWrapper></CacheProvider>),
    unmount: () => rawRoot.unmount(),
  };
  return {
    act, host,
    button: (label: string) => [...host.querySelectorAll("button")].find((button) => button.getAttribute("aria-label") === label || button.textContent?.trim() === label),
    render: () => act(async () => root.render(contextMarkdown === undefined ? <JobsPrivateDetails applicationId={profile ? undefined : applicationId} />
      : <CandidateApplicationQuestions applicationId={applicationId} markdown={contextMarkdown} />)),
    async cleanup() {
      await act(async () => root.unmount());
      await dom.happyDOM.close();
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

const linkedIn: FieldMetadata = { ...firstName, id: "linkedin", key: "linkedin", label: "LinkedIn profile", type: "url" };
const website: FieldMetadata = { ...linkedIn, id: "website", key: "website", label: "Website or portfolio", hasValue: false };
const savedLinkedIn = { ...linkedIn, value: "https://www.linkedin.com/in/synthetic-owner" };
const emptyWebsite = { ...website, value: null };
const emptyHistory = { ...history, value: null };

function fieldInput(host: HTMLElement, label: string) {
  const form = [...host.querySelectorAll("form")].find((candidate) => {
    const labelledBy = candidate.getAttribute("aria-labelledby");
    return labelledBy && document.getElementById(labelledBy)?.textContent === label;
  });
  return form?.querySelector<HTMLInputElement>('input[name="answer"]');
}

function typeValue(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

test("visible fields save several edits together, keep blank saved values and preserve a later edit across a deferred conflict", async () => {
  const requests: PrivateFieldWrite[][] = [];
  const first = deferred<Response>();
  const second = deferred<Response>();
  const metadata = deferred<Response>();
  let reads = 0;
  const { act, host, button, render, cleanup } = await mountDetails(async (path, init) => {
    if (path === `/api/jobs/application-details/${applicationId}`) return Response.json({ application: { id: applicationId, role: "Fixture Engineer", company: "Fixture Studio", resumeTrack: "web" } });
    expect(init).toMatchObject({ credentials: "same-origin", cache: "no-store" });
    if (init.method !== "PATCH") {
      expect(path).toBe("/api/v1/jobs/private-fields/values");
      expect(init.method).toBe("POST");
      expect(JSON.parse(String(init.body))).toEqual({});
      return ++reads === 1 ? metadata.promise : Response.json({ fields: [{ ...firstName, version: 4, value: "outside-private-answer" }, savedLinkedIn, emptyWebsite, emptyHistory] });
    }
    requests.push(JSON.parse(String(init.body)).fields);
    if (requests.length === 1) return first.promise;
    if (requests.length === 2) return second.promise;
    if (requests.length === 3) return Response.json({ fields: [{ ...firstName, version: 5, value: "latest-private-answer" }] });
    throw new Error("Unexpected write");
  }, undefined, true);
  try {
    await render();
    expect(host.textContent).toContain("Loading saved-answer status");
    await act(async () => metadata.resolve(Response.json({ fields: [{ ...firstName, value: "existing-private-answer" }, savedLinkedIn, emptyWebsite, emptyHistory] })));
    expect(button("Update First name")).toBeUndefined();
    expect(button("Save answer")).toBeUndefined();
    expect(host.innerHTML).not.toContain("existing-private-answer");
    const name = fieldInput(host, "First name")!;
    const url = fieldInput(host, "Website or portfolio")!;
    const savedUrl = fieldInput(host, "LinkedIn profile")!;
    expect(name.type).toBe("password");
    expect(name.value).toBe("existing-private-answer");
    expect(url.type).toBe("url");
    expect(url.value).toBe("");
    expect(savedUrl.type).toBe("url");
    expect(savedUrl.value).toBe(savedLinkedIn.value);
    expect(savedUrl.placeholder).toBe("https://www.linkedin.com/in/alex-morgan");
    await act(async () => button("Save changes")?.click());
    expect(requests).toHaveLength(0);
    await act(async () => button("Show First name")?.click());
    expect(name.type).toBe("text");
    await act(async () => button("Hide First name")?.click());
    expect(name.type).toBe("password");
    await act(async () => button("Show First name")?.click());
    await act(async () => { typeValue(name, "first-private-answer"); typeValue(url, "https://portfolio.example.test"); typeValue(savedUrl, ""); });
    expect(name.value).toBe("first-private-answer");
    await act(async () => button("Save changes")?.click());
    expect(name.value).toBe("first-private-answer");
    expect(host.textContent).toContain("Saving changes…");
    expect([...requests[0]].sort((a, b) => a.key.localeCompare(b.key))).toMatchObject([
      { key: "firstName", expectedVersion: 2, value: "first-private-answer" },
      { key: "website", expectedVersion: 2, value: "https://portfolio.example.test" },
    ]);
    await act(async () => typeValue(name, "latest-private-answer"));
    expect(name.value).toBe("latest-private-answer");
    await act(async () => button("Save changes")?.click());
    expect(requests).toHaveLength(1);
    await act(async () => window.dispatchEvent(new Event("focus")));
    await act(async () => first.resolve(Response.json({ fields: [{ ...firstName, version: 3 }, { ...website, version: 3, hasValue: true }] })));
    expect(requests[1]).toMatchObject([{ key: "firstName", expectedVersion: 3, value: "latest-private-answer" }]);
    await act(async () => second.resolve(Response.json({ message: "echoing latest-private-answer" }, { status: 409 })));
    expect(host.textContent).toContain("Some answers changed elsewhere");
    expect(host.innerHTML).not.toContain("latest-private-answer");
    expect(host.innerHTML).not.toContain("outside-private-answer");
    await act(async () => button("Apply changes")?.click());
    expect(requests[2]).toMatchObject([{ expectedVersion: 4, value: "latest-private-answer" }]);
    expect(host.textContent).not.toContain("Some answers changed elsewhere");

    expect(host.querySelector('input[name="0:company"]')).toBeNull();
  } finally { await cleanup(); }
});

test("metadata refresh leaves the visible input mounted and phone validation does not erase typing", async () => {
  let read = 0;
  const requests: PrivateFieldWrite[][] = [];
  const phone: FieldMetadata = { ...firstName, id: "phone", key: "phone", label: "Phone number", type: "phone", hasValue: false };
  const email: FieldMetadata = { ...firstName, id: "email", key: "email", label: "Application email", type: "email" };
  const { act, host, button, render, cleanup } = await mountDetails(async (path, init) => {
    if (path === `/api/jobs/application-details/${applicationId}`) return Response.json({ application: { id: applicationId, resumeTrack: "web" } });
    if (init.method !== "PATCH") return Response.json({ fields: ++read === 1
      ? [{ ...phone, value: null }, { ...email, value: "category@example.test" }]
      : [{ ...phone, version: 3, hasValue: true, value: "+1 555 010 1234" }, savedLinkedIn, { ...email, value: "category@example.test" }] });
    requests.push(JSON.parse(String(init.body)).fields);
    return Response.json({ fields: [{ ...phone, version: 4, hasValue: true }] });
  }, undefined, true);
  try {
    await render();
    const input = fieldInput(host, "Phone number")!;
    expect(input.type).toBe("tel");
    expect(input.placeholder).toBe("+1 902 555 0123");
    expect(fieldInput(host, "Application email")).toBeUndefined();
    await act(async () => typeValue(input, "123 ext 4"));
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(fieldInput(host, "Phone number")).toBe(input);
    expect(input.value).toBe("123 ext 4");
    expect(input.type).toBe("tel");
    expect(host.querySelector('[aria-label="LinkedIn profile Saved"]')).toBeTruthy();
    await act(async () => button("Save changes")?.click());
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Use a number like +1 902 555 0123.");
    expect(input.value).toBe("123 ext 4");
    expect(requests).toHaveLength(0);
    await act(async () => { typeValue(input, "+1 (555) 234-5678"); button("Save changes")?.click(); });
    expect(requests[0]).toMatchObject([{ key: "phone", value: "+1 (555) 234-5678" }]);
    expect(input.value).toBe("+1 (555) 234-5678");
  } finally { await cleanup(); }
});

test("an uncertain batch replays the exact body before sending a later edit", async () => {
  const { createPrivateDetailsStore } = await import("./private-store");
  const first = deferred<FieldMetadata[]>();
  const commands: PrivateFieldWrite[][] = [];
  const store = createPrivateDetailsStore({ list: async () => [{ ...firstName, value: "saved-fixture-answer" }, website], save: async (fields) => {
    commands.push(fields);
    return commands.length === 1 ? first.promise : fields.map((field) => ({ ...firstName, ...field, version: (field.expectedVersion ?? 0) + 1 }));
  } });
  await store.refresh();
  expect(store.value(firstName)).toBe("saved-fixture-answer");
  expect(JSON.stringify([...store.getSnapshot().fields])).not.toContain("saved-fixture-answer");
  store.register(firstName, () => "first-fixture-answer");
  store.register(website, () => "https://fixture.example.test");
  store.saveChanges();
  store.register(firstName, () => "latest-fixture-answer");
  store.register(website);
  store.saveChanges();
  first.reject(new TypeError("Synthetic connection loss"));
  await Bun.sleep(0);
  expect(store.getSnapshot()).toMatchObject({ saving: false, problem: "uncertain", pending: 2 });
  store.retry();
  await Bun.sleep(0);
  expect(commands).toHaveLength(3);
  expect(commands[0]).toEqual(commands[1]);
  expect(commands[2]).toMatchObject([{ expectedVersion: 3, value: "latest-fixture-answer" }]);
});

test("a long save uses bounded batches and keeps the atomic requests sequential", async () => {
  const { createPrivateDetailsStore } = await import("./private-store");
  const first = deferred<FieldMetadata[]>();
  const commands: PrivateFieldWrite[][] = [];
  const records = Array.from({ length: 26 }, (_, index) => ({ ...firstName, key: `fixture${index}`, version: 2 }));
  const store = createPrivateDetailsStore({ list: async () => records, save: async (fields) => {
    commands.push(fields);
    return commands.length === 1 ? first.promise : [{ ...records[25], version: 3 }];
  } });
  await store.refresh();
  for (const field of records) store.register(field, () => "New synthetic answer");
  store.saveChanges();
  expect(commands.map(command => command.length)).toEqual([25]);
  first.resolve(records.slice(0, 25).map(record => ({ ...record, version: 3 })));
  await Bun.sleep(0);
  expect(commands.map(command => command.length)).toEqual([25, 1]);
  expect(store.getSnapshot().pending).toBe(0);
});

test("a paused application without registered questions offers one scoped refresh and keeps typed details", async () => {
  let reads = 0;
  const updated = deferred<Response>();
  const { act, host, button, render, cleanup } = await mountDetails(async (path) => {
    if (path === `/api/jobs/application-details/${applicationId}`) return Response.json({ application: {
      id: applicationId, role: "Fixture Engineer", company: "Fixture Studio", resumeTrack: "web",
      status: "needs_attention", issueCode: "manual_required", privatePauseFieldKeys: ["phone"],
    } });
    expect(path).toBe("/api/v1/jobs/private-fields/values");
    return ++reads === 1 ? Response.json({ fields: [] }) : updated.promise;
  });
  try {
    await render();
    expect(host.textContent).toContain("No questions are registered for this application.");
    expect(host.textContent).toContain("The runner can also pause at an employer-site step.");
    expect(reads).toBe(1);
    const phone = fieldInput(host, "Phone number")!;
    await act(async () => { typeValue(phone, "+1 902 555 0123"); button("Refresh questions")?.click(); });
    expect(reads).toBe(2);
    expect(button("Refreshing questions…")?.disabled).toBe(true);
    await act(async () => updated.resolve(Response.json({ fields: [{ ...history, label: "Do you hold a work permit?", value: null }] })));
    expect(fieldInput(host, "Do you hold a work permit?")).toBeTruthy();
    expect(fieldInput(host, "Phone number")).toBe(phone);
    expect(phone.value).toBe("+1 902 555 0123");
    expect(reads).toBe(2);
  } finally { await cleanup(); }
});

const application = { ...screeningPosting, id: applicationId, resumeTrack: "admin" };
const listingField = (key: string, label: string, options: string[] = []) =>
  ({ ...history, id: key, key, label, options, type: options.length ? "option" as const : "text" as const });
const referrer = listingField("question.referrer", "If yes, enter their name.");
const referred = listingField("question.referred", "Were you referred by an employee?");
const noticeFirst = listingField("question.notice-first", "What is your notice period if successful?", ["1 week", "2 weeks"]);
const noticeSecond = listingField("question.notice-second", "What is your notice period?", ["1 Week", "4 weeks"]);
const sourceDocumentation = listingField("question.source", "Have you created Source documentation before?", ["Yes", "No"]);
const consent = listingField("question.consent", "I consent to the processing of my application");
const contextMarkdown = "## Application answers\n- resume-only-experience: Yes\n- screening-referred: No\n- screening-notice-period: 1 week";

test("a known declined referral and context screening stay out of Private details while consent remains editable", async () => {
  const contextResponse = deferred<Response>();
  const paths: string[] = [];
  const { act, host, render, cleanup } = await mountDetails(async (path) => {
    paths.push(path);
    if (path.endsWith(`/application-details/${applicationId}`)) return Response.json({ application, candidateRules: candidateRulesDisplay(application, candidateRules) });
    if (path.endsWith("/candidate-context")) return contextResponse.promise;
    expect(path).toBe("/api/v1/jobs/private-fields/values");
    return Response.json({ fields: [referrer, referred, sourceDocumentation, noticeFirst, noticeSecond, consent].map(field => ({ ...field, value: null })) });
  });
  try {
    await render();
    expect(host.textContent).toContain("Checking whether a referral name is needed");
    expect(host.textContent).not.toContain("Referring employee’s full name");
    await act(async () => contextResponse.resolve(Response.json({ markdown: contextMarkdown, version: 1 })));
    expect(host.textContent).not.toContain("Referring employee’s full name");
    expect(host.textContent).not.toContain(noticeFirst.label);
    expect(host.textContent).not.toContain(sourceDocumentation.label);
    expect(fieldInput(host, consent.label)).toBeTruthy();
    expect(paths).toHaveLength(3);
  } finally { await cleanup(); }
});

test("the context panel reads metadata only, groups notice, and exposes unresolved questions", async () => {
  const paths: string[] = [];
  const { host, render, cleanup } = await mountDetails(async (path, init) => {
    paths.push(path);
    if (path.endsWith(`/application-details/${applicationId}`)) return Response.json({ application, candidateRules: candidateRulesDisplay(application, candidateRules) });
    expect(path).toBe(`/api/v1/jobs/private-fields?applicationId=${applicationId}`);
    expect(init.method).toBeUndefined();
    return Response.json({ fields: [noticeFirst, noticeSecond, sourceDocumentation, consent, history] });
  }, contextMarkdown);
  try {
    await render();
    expect(paths).toHaveLength(2);
    expect([...host.querySelectorAll("li")].filter(row => row.firstChild?.textContent === "Notice period")).toHaveLength(1);
    expect(host.textContent).toContain("1 week");
    expect(host.textContent).toContain("original clinical-study records");
    expect(host.textContent).toContain("Needs review before this question can be filled automatically.");
    expect(host.textContent).not.toContain(consent.label);
  } finally { await cleanup(); }
});

test("stale required shared questions use reusable details and candidate context", async () => {
  const duplicates = ["Legal First Name", "Legal Last Name", "Country", "Phone Device Type", "Country Phone Code"]
    .map((label, index) => listingField(`question.stale-${index}`, label));
  const { host, render, cleanup } = await mountDetails(async (path) => {
    if (path.endsWith(`/application-details/${applicationId}`)) return Response.json({ application: {
      id: applicationId, role: "Engineer", company: "Fixture", sourceUrl: "https://fixture.myworkdayjobs.com/en-US/jobs/job/test", resumeTrack: "web", status: "needs_attention",
      issueCode: "manual_required", approvedRevision: 1, privatePauseFieldKeys: duplicates.map(field => field.key),
    } });
    return Response.json({ fields: [...duplicates, consent].map(field => ({ ...field, value: null })) });
  });
  try {
    await render();
    for (const field of duplicates) expect(fieldInput(host, field.label)).toBeUndefined();
    expect(fieldInput(host, "First name")).toBeTruthy();
    expect(fieldInput(host, "Last name")).toBeTruthy();
    expect(fieldInput(host, "Country of residence")).toBeTruthy();
    expect(fieldInput(host, consent.label)).toBeTruthy();
    expect(host.textContent).toContain("reopen review and approve again");
    expect(host.querySelector('a[href="/jobs/profile"]')).toBeTruthy();
    expect(host.textContent).not.toContain("Save the missing answers to resume");
  } finally { await cleanup(); }
});

test("Workday phone questions use candidate context even when legacy listing answers exist", async () => {
  const workday = { id: applicationId, role: "Engineer", company: "Fixture", resumeTrack: "web", sourceUrl: "https://fixture.myworkdayjobs.com/en-US/jobs/job/test" };
  const phoneFields = [listingField("question.device", "Phone Device Type"), listingField("question.code", "Country Phone Code")]
    .map(field => ({ ...field, hasValue: true }));
  const { host, render, cleanup } = await mountDetails(async (path) => {
    if (path.endsWith(`/application-details/${applicationId}`)) return Response.json({ application: workday });
    return Response.json({ fields: phoneFields });
  }, "## Application answers\n- phone-device-type: Mobile");
  try {
    await render();
    expect(host.textContent).toContain("Phone device type");
    expect(host.textContent).toContain("Mobile");
    expect(host.textContent).toContain("Phone country calling code");
    expect(host.textContent).toContain("phone-country-code: …");
    expect(host.textContent).not.toContain("Uses an existing saved application answer");
  } finally { await cleanup(); }
});
