import { expect, test } from "bun:test";
import { createResumeTrackingValidator, portfolioCatalogUrl, UntrackedResumeLink } from "./resume-tracking-validation";

const known = "https://example.test/project";
const catalog = { destinations: [{ sourceUrls: [known] }] };

test("coalesces public catalog reads and applies the same check to drafts and saved documents", async () => {
  let requests = 0;
  let time = 1;
  const request: typeof fetch = async (url, init) => {
    expect(url).toBe(portfolioCatalogUrl);
    expect(init?.headers).toBeUndefined();
    expect(init?.method).toBeUndefined();
    requests++;
    return Response.json(catalog);
  };
  const validate = createResumeTrackingValidator(request, () => time);
  const document = `[Project](${known})`;
  const header = "[Email](mailto:synthetic@example.test) [Phone](tel:+19025550123)";
  await Promise.all([validate(document, header), validate(document, header)]);
  await validate(document, header);
  expect(requests).toBe(1);
  await expect(validate(document + " [Added](https://new.example/demo)", header)).rejects.toBeInstanceOf(UntrackedResumeLink);
  expect(requests).toBe(1);
  time += 30_001;
  await validate(document);
  expect(requests).toBe(2);
  await expect(validate(document, "[Protected header](https://unknown.example)")).rejects.toBeInstanceOf(UntrackedResumeLink);
  await expect(validate("[Bad](https://username:secret@example.test/project)")).rejects.toBeInstanceOf(UntrackedResumeLink);
  await expect(validate("[Bad](ftp://example.test/project)")).rejects.toBeInstanceOf(UntrackedResumeLink);
});

test("rejects invalid or oversized public catalog responses and briefly coalesces failures", async () => {
  let count = 0;
  const validate = createResumeTrackingValidator(async () => { count++; return Response.json({ destinations: [] }); });
  await expect(validate("[Project](" + known + ")")).rejects.toThrow("resume_tracking_catalog_unavailable");
  await expect(validate("[Project](" + known + ")")).rejects.toThrow("resume_tracking_catalog_unavailable");
  expect(count).toBe(1);
  const oversized = createResumeTrackingValidator(async () => new Response(" ".repeat(262_145)));
  await expect(oversized("")).rejects.toThrow("resume_tracking_catalog_unavailable");
});
