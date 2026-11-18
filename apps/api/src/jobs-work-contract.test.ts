import { expect, test } from "bun:test";
import { jobsSubmissionEventInput, jobsWorkClaimInput, jobsWorkClaimOutput, jobsWorkCompleteInput, jobsWorkFailInput, jobsWorkPdfUploadHeaders } from "./jobs-work-contract";

const id = "49db114d-041b-4e68-a82c-2050a3a47ac5";
const leaseToken = "synthetic-lease-for-jobs-contract";

test("Jobs work claims and reports expose only the payload for their work kind", () => {
  expect(jobsWorkClaimInput.parse({ workerId: "fixture", kinds: ["enrich", "tailor"] }).kinds).toEqual(["enrich", "tailor"]);
  expect(jobsWorkClaimInput.safeParse({ workerId: "fixture", kinds: ["render", "render"] }).success).toBe(false);
  const work = { id, applicationId: id, revision: 0, leaseToken, leaseUntil: "2026-11-14T19:00:00Z", kind: "enrich",
    input: { track: "web", postingText: "Edit product pages", candidateContext: "Content publishing" } } as const;
  expect(jobsWorkClaimOutput.parse({ work })).toEqual({ work });
  expect(jobsWorkClaimOutput.safeParse({ work: { ...work, input: { ...work.input, applicationAddress: "private" } } }).success).toBe(false);
  expect(jobsWorkCompleteInput.tailor.parse({ leaseToken, resultId: id, result: { summaryMarkdown: "- Edit product pages" } })).toMatchObject({ leaseToken });
  expect(jobsWorkCompleteInput.submit.safeParse({ leaseToken, resultId: id, result: { summaryMarkdown: "- Edit product pages" } }).success).toBe(false);
  expect(jobsWorkFailInput.safeParse({ leaseToken, resultId: id, code: "submission_uncertain", requirements: [] }).success).toBe(false);
  expect(jobsWorkPdfUploadHeaders.parse({ "x-job-work-id": id, "x-job-lease-token": leaseToken, "x-content-sha256": "a".repeat(64) })).toHaveProperty("x-job-work-id", id);
});

test("the submit receipt accepts an SES Message-ID only for confirmation messages", () => {
  const capturedAt = "2026-11-14T19:00:00Z";
  const parse = (receipt: unknown) => jobsWorkCompleteInput.submit.safeParse({
    leaseToken, resultId: id, result: { receipt },
  });
  const receipt = { code: "confirmation_message", capturedAt, sesMessageId: "fixture-ses-id" } as const;
  expect(parse(receipt).data?.result.receipt).toEqual(receipt);
  expect(parse({ code: "confirmation_page", capturedAt }).success).toBe(true);
  expect(parse({ code: "confirmation_message", capturedAt }).success).toBe(true);
  expect(parse({ ...receipt, code: "confirmation_page" }).success).toBe(false);
  for (const sesMessageId of ["", "id\n", "id@example.test", "<fixture-id>", "x".repeat(257)]) {
    expect(parse({ ...receipt, sesMessageId }).success).toBe(false);
  }
});

test("the SES submission channel is valid on a claimed preflight or a successful start", () => {
  const event = { leaseToken, eventId: id, workId: id, channel: "ses", step: "submit_started", state: "running" };
  expect(jobsSubmissionEventInput.safeParse(event).success).toBe(true);
  expect(jobsSubmissionEventInput.safeParse({ ...event, step: "runner_claimed", state: "done" }).success).toBe(true);
  expect(jobsSubmissionEventInput.safeParse({ ...event, step: "runner_claimed" }).success).toBe(false);
  expect(jobsSubmissionEventInput.safeParse({ ...event, step: "portal_opened" }).success).toBe(false);
  expect(jobsSubmissionEventInput.safeParse({ ...event, state: "failed" }).success).toBe(false);
});
