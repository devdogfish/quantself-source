import { parseArgs } from "node:util";
import { trackedLinkPath, trackedShareInput, newTrackedLink } from "../../apps/api/src/tracked-links-contract";

const usage = 'bun run links:share --title "Kristina Girke footer" --track client';

export async function createShareLink(
  args: string[],
  env: Record<string, string | undefined> = process.env,
  request: typeof fetch = fetch,
) {
  const { values } = parseArgs({ args, options: {
    title: { type: "string" }, track: { type: "string" },
  } });
  const input = trackedShareInput.safeParse(values);
  if (!input.success) throw new Error(usage);

  const token = env.QUANTSELF_TRACKED_LINKS_SHARE_TOKEN;
  if (!token || Buffer.byteLength(token) < 32) throw new Error("Set QUANTSELF_TRACKED_LINKS_SHARE_TOKEN.");
  const origin = URL.parse(env.QUANTSELF_API_URL ?? "");
  if (!origin || origin.pathname !== "/" || origin.username || origin.password || origin.search || origin.hash ||
    (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)))) {
    throw new Error("Set QUANTSELF_API_URL to the API's HTTPS origin. Local development may use loopback HTTP.");
  }

  let response: Response;
  try {
    response = await request(new URL(trackedLinkPath + "/shares", origin), {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
      headers: { "X-API-Key": token, "Content-Type": "application/json" },
      body: JSON.stringify(input.data),
    });
  } catch {
    throw new Error("Could not reach the tracked-links API.");
  }
  if (!response.ok) throw new Error(`Tracked link registration failed (HTTP ${response.status}).`);
  const share = newTrackedLink.safeParse(await response.json().catch(() => null));
  if (!share.success) throw new Error("The tracked-links API returned an invalid code.");
  return `https://girke.dev/r/${share.data.code}`;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log(usage);
  } else {
    try {
      console.log(await createShareLink(args));
    } catch (error) {
      console.error(error instanceof Error ? error.message : "Tracked link registration failed.");
      process.exitCode = 1;
    }
  }
}
