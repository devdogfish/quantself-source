import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { canonicalJobUrl } from "./jobs-application";

const key = (url: string) => canonicalJobUrl(url).sourceKey;
const postingId = "00000000-0000-4000-8000-000000000001";

test("canonical posting URLs remove tracking and preserve the posting identity", () => {
  const { sourceUrl, sourceKey } = canonicalJobUrl("https://example.test/editor/?utm_source=feed&b=2&job=1#description");
  expect(sourceUrl).toBe("https://example.test/editor?b=2&job=1");
  expect(sourceKey).toBe(key("https://example.test/editor?job=1&b=2"));
  expect(sourceKey).not.toBe(key("https://example.test/editor?job=2&b=2"));
  expect(key("https://example.test/#!/job/1")).not.toBe(key("https://example.test/#!/job/2"));
  expect(() => key("https://example.test@private.example.test/editor")).toThrow();
  expect(() => key("javascript:alert(1)")).toThrow();
});

test("public ATS routes share an identity only when their provider and posting match", () => {
  const pairs = [
    ["https://boards.greenhouse.io/sample/jobs/1234", "https://job-boards.greenhouse.io/sample/jobs/1234?gh_src=feed"],
    [`https://jobs.lever.co/sample/${postingId}`, `https://jobs.lever.co/sample/${postingId}/apply?lever-source=feed`],
    [`https://jobs.ashbyhq.com/sample/${postingId}`, `https://jobs.ashbyhq.com/sample/${postingId}/application`],
    ["https://apply.workable.com/sample/j/1234ABCD", "https://apply.workable.com/sample/j/1234ABCD/apply"],
    ["https://www.careers-page.com/sample/job/ABCD1234", "https://www.careers-page.com/sample/job/ABCD1234/apply"],
    [`https://ats.rippling.com/sample/jobs/${postingId}`, `https://ats.rippling.com/sample/jobs/${postingId}/apply?jobBoardSlug=sample&jobId=${postingId}&step=application`],
  ];
  for (const [posting, application] of pairs) expect(key(posting)).toBe(key(application));
  expect(key("https://job-boards.greenhouse.io/sample/jobs/1234")).not.toBe(key("https://job-boards.greenhouse.io/another/jobs/1234"));
  expect(key("https://job-boards.greenhouse.io/sample/jobs/1234")).not.toBe(key("https://job-boards.greenhouse.io/sample/jobs/1235"));
  expect(key(`https://ats.rippling.com/sample/jobs/${postingId}/apply?jobBoardSlug=another`)).not.toBe(key(pairs[5][0]));
  expect(key(`https://jobs.ashbyhq.com/sample/${postingId}?location=1`)).not.toBe(key(`https://jobs.ashbyhq.com/sample/${postingId}?location=2`));
});

test("explicit private aliases preserve a legacy canonical key without guessing another URL", () => {
  const primary = "https://careers.example.test/job?gh_jid=01234&team=2";
  const alternate = "https://jobs.example.test/job/?team=2&utm_source=board&gh_jid=01234";
  const rules = [{ canonicalHost: "careers.example.test", aliases: ["jobs.example.test"], path: "/job", postingIdParameter: "gh_jid" }];
  expect(key(primary)).not.toBe(key(alternate));
  const { sourceKey, sourceUrl } = canonicalJobUrl(alternate, rules);
  expect(sourceKey).toBe(createHash("sha256").update("careers.example.test/job?gh_jid=01234&team=2").digest("hex"));
  expect(sourceUrl).toBe("https://jobs.example.test/job?gh_jid=01234&team=2");
  const withRules = (url: string) => canonicalJobUrl(url, rules).sourceKey;
  expect(withRules(primary)).toBe(sourceKey);
  expect(withRules(alternate.replace("/job/", "/other/"))).not.toBe(sourceKey);
  expect(withRules(alternate.replace("01234", "nonnumeric"))).toBe(key(alternate.replace("01234", "nonnumeric")));
  expect(withRules(alternate + "&gh_jid=01234")).toBe(key(alternate + "&gh_jid=01234"));
  expect(withRules(alternate.replace("team=2", "team=3"))).not.toBe(sourceKey);
});

test("the current batch import accepts verified Greenhouse provider identities", async () => {
  const { jobsImportApplicationsInput } = await import("./jobs-owner-contract");
  const row = {
    sourceUrl: "https://careers.example.test/editor?gh_jid=1234", company: "Fixture", role: "Editor",
    track: "web" as const, postingText: "Edit product pages.", sourceIdentity: "greenhouse:global:fixture:1234",
  };
  expect(jobsImportApplicationsInput.parse({ applications: [row] })).toEqual({ applications: [row] });
  expect(jobsImportApplicationsInput.safeParse({ applications: [{ ...row, sourceIdentity: "other:fixture:1234" }] }).success).toBe(false);
});
