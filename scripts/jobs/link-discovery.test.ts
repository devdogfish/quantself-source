import { expect, test } from "bun:test";
import { discoverApplicationLinks, LinkDiscoveryUnavailable } from "./link-discovery";

test("fetches current choices from the configured public endpoint without registration or credentials", async () => {
  const current = {
    project: [{ key: "new-project/demo", description: "A newly published project demo." }],
    profile: [{ key: "new-profile", description: "A newly available public profile." }],
    variant: [{ key: "new-variant", description: "A newly available presentation." }],
  };
  const calls: { input: unknown; init: unknown }[] = [];
  const result = await discoverApplicationLinks("https://portfolio.example/api/links", async (input, init) => {
    calls.push({ input, init });
    expect(init?.method).toBe("GET");
    expect(init?.headers).toBeUndefined();
    expect(init?.body).toBeUndefined();
    expect(init?.redirect).toBe("error");
    return Response.json({ ...current, token: "must-not-appear", projectCount: 999 });
  });
  expect(calls).toHaveLength(1);
  expect(calls[0].input).toBe("https://portfolio.example/api/links");
  expect(result).toEqual(current);
  expect(JSON.stringify(result)).not.toContain("must-not-appear");
});

test("rejects malformed, duplicate, oversized and unsuccessful discovery responses safely", async () => {
  const invalid = [
    { project: [], profile: [] },
    { project: [{ key: "a", description: "A" }, { key: "a", description: "Duplicate" }], profile: [], variant: [] },
    { project: [{ key: "a", description: "" }], profile: [], variant: [] },
  ];
  for (const payload of invalid) {
    await expect(discoverApplicationLinks(undefined, async () => Response.json(payload))).rejects.toBeInstanceOf(LinkDiscoveryUnavailable);
  }
  await expect(discoverApplicationLinks(undefined, async () => new Response("x".repeat(262_145), {
    headers: { "Content-Type": "application/json" },
  }))).rejects.toBeInstanceOf(LinkDiscoveryUnavailable);
  await expect(discoverApplicationLinks(undefined, async () => Response.json({ secret: "private" }, { status: 500 }))).rejects.toThrow(
    "Application link discovery is unavailable.",
  );
});

test("rejects credential-bearing or non-public endpoint configuration before fetching", async () => {
  let calls = 0;
  const request = async () => { calls++; return Response.json({}); };
  for (const url of ["http://example.test/api/links", "https://user:secret@example.test/api/links",
    "https://example.test/api/links?token=secret", "https://example.test/application-registry"]) {
    await expect(discoverApplicationLinks(url, request)).rejects.toBeInstanceOf(LinkDiscoveryUnavailable);
  }
  expect(calls).toBe(0);
});
