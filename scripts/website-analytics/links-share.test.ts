import { expect, test } from "bun:test";
import { createShareLink } from "./links-share";

test("the Owner command registers one share and prints only its redirect URL", async () => {
  let requests = 0;
  const env = {
    QUANTSELF_API_URL: "https://dashboard.example.net",
    QUANTSELF_TRACKED_LINKS_SHARE_TOKEN: "tracked-links-share-credential-for-tests",
  };
  const args = ["--title", "Kristina Girke footer", "--track", "client"];
  const request: typeof fetch = Object.assign(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    requests++;
    expect(String(url)).toBe("https://dashboard.example.net/api/v1/tracked-links/shares");
    expect(new Headers(init?.headers).get("x-api-key")).toBe(env.QUANTSELF_TRACKED_LINKS_SHARE_TOKEN);
    expect(init?.redirect).toBe("error");
    expect(JSON.parse(String(init?.body))).toEqual({
      title: "Kristina Girke footer", track: "client",
    });
    return Response.json({ code: "k3Vw9QpX" });
  }, { preconnect: fetch.preconnect });
  expect(await createShareLink(args, env, request)).toBe("https://girke.dev/r/k3Vw9QpX");
  await expect(createShareLink([...args.slice(0, -1), "//other.example"], env, request)).rejects.toThrow();
  expect(requests).toBe(1);
});
