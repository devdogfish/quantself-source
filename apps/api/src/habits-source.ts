import { createPrivateKey, sign } from "node:crypto";
import type { HabitProjection } from "./habits-definition";
export class HabitUnavailable extends Error {
  constructor(public revoked = false) {
    super(
      revoked
        ? "Habit repository access revoked."
        : "Habit definitions unavailable.",
    );
  }
}
export type HabitDefinitions = {
  revision?: number;
  projection: HabitProjection | null;
  sha: string | null;
  stale: boolean;
  error: string | null;
};
// Dedicated App only. Each token is restricted to one private repository and Contents read.
export function githubHabitLoader(
  env = process.env,
  transport: typeof fetch = fetch,
  now = Date.now,
  permission: "read" | "write" = "read",
) {
  const etags = new Map<string, { sha: string; value: string }>();
  let tokenPending: Promise<void> | null = null;
  let token: { value: string; expires: number } | null = null;
  async function request(
    path: string,
    bearer: string,
    init: RequestInit = {},
    missingIsRevoked = true,
    allowedStatuses: number[] = [],
  ) {
    const response = await transport(`https://api.github.com${path}`, {
      ...init,
      signal: AbortSignal.timeout(15_000),
      headers: {
        Authorization: `Bearer ${bearer}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...init.headers,
      },
    });
    if (
      !response.ok &&
      response.status !== 304 &&
      !allowedStatuses.includes(response.status)
    ) {
      if (
        [401, 403].includes(response.status) ||
        (response.status === 404 && missingIsRevoked)
      ) {
        token = null;
        throw new HabitUnavailable(true);
      }
      throw new HabitUnavailable();
    }
    return response;
  }
  const read = async (sha: string | null, path = "SYSTEM.md", tree = false) => {
    const etag = etags.get(path);
    const repo = env.QUANTSELF_HABITS_REPOSITORY;
    const appId = env.QUANTSELF_HABITS_GITHUB_APP_ID;
    const installation = env.QUANTSELF_HABITS_GITHUB_INSTALLATION_ID;
    const key = env.QUANTSELF_HABITS_GITHUB_PRIVATE_KEY;
    if (
      !repo ||
      !/^[\w.-]+\/[\w.-]+$/.test(repo) ||
      !/^\d+$/.test(appId ?? "") ||
      !/^\d+$/.test(installation ?? "") ||
      !key
    )
      throw new HabitUnavailable(true);
    if (!token || token.expires < now() + 60_000) {
      if (!tokenPending)
        tokenPending = (async () => {
          const encode = (v: unknown) =>
            Buffer.from(JSON.stringify(v)).toString("base64url");
          const payload = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iss: appId, iat: Math.floor(now() / 1000) - 60, exp: Math.floor(now() / 1000) + 540 })}`;
          const jwt = `${payload}.${sign("RSA-SHA256", Buffer.from(payload), createPrivateKey(key)).toString("base64url")}`;
          const installationInfo = (await (
            await request(`/app/installations/${installation}`, jwt)
          ).json()) as {
            app_id: number;
            repository_selection: string;
            account: { login: string };
            suspended_at: string | null;
            permissions: { contents?: string };
          };
          if (
            String(installationInfo.app_id) !== appId ||
            installationInfo.repository_selection !== "selected" ||
            installationInfo.account?.login.toLowerCase() !==
              repo.split("/")[0].toLowerCase() ||
            installationInfo.suspended_at ||
            !["read", "write"].includes(
              installationInfo.permissions?.contents ?? "",
            )
          )
            throw new HabitUnavailable(true);
          const access = (await (
            await request(
              `/app/installations/${installation}/access_tokens`,
              jwt,
              {
                method: "POST",
                body: JSON.stringify({
                  repositories: [repo.split("/")[1]],
                  permissions: { contents: permission, metadata: "read" },
                }),
              },
            )
          ).json()) as { token: string; expires_at: string };
          if (
            !access.token ||
            Date.parse(access.expires_at) <= now() ||
            !Number.isFinite(Date.parse(access.expires_at))
          )
            throw new HabitUnavailable(true);
          const allowed = (await (
            await request(
              "/installation/repositories?per_page=100",
              access.token,
            )
          ).json()) as {
            total_count: number;
            repositories: { full_name: string; private: boolean }[];
          };
          if (
            allowed.total_count !== 1 ||
            allowed.repositories.length !== 1 ||
            allowed.repositories[0].full_name.toLowerCase() !==
              repo.toLowerCase() ||
            !allowed.repositories[0].private
          )
            throw new HabitUnavailable(true);
          token = {
            value: access.token,
            expires: Date.parse(access.expires_at),
          };
        })().finally(() => {
          tokenPending = null;
        });
      await tokenPending;
    }
    const response = await request(
      tree
        ? `/repos/${repo}/git/trees/HEAD?recursive=1`
        : `/repos/${repo}/contents/${path}`,
      token!.value,
      {
        headers:
          etag && etag.sha === sha ? { "If-None-Match": etag.value } : {},
      },
      tree || path === "habits.yaml",
    );
    if (response.status === 304) return null;
    if (tree) {
      const listing = (await response.json()) as {
        sha: string;
        truncated: boolean;
        tree: { path: string; type: string }[];
      };
      if (listing.truncated || !listing.sha || !Array.isArray(listing.tree))
        throw new HabitUnavailable();
      return {
        sha: listing.sha,
        text: JSON.stringify(
          listing.tree
            .filter(
              (f) =>
                f.type === "blob" &&
                /^reviews\/\d{4}-\d{2}-\d{2}\.md$/.test(f.path),
            )
            .map((f) => f.path)
            .sort()
            .reverse(),
        ),
      };
    }
    const file = (await response.json()) as {
      sha: string;
      content: string;
      encoding: string;
      size: number;
    };
    if (
      !file.sha ||
      file.encoding !== "base64" ||
      file.size > 1_000_000 ||
      typeof file.content !== "string"
    )
      throw new HabitUnavailable();
    const responseEtag = response.headers.get("etag");
    if (etags.size >= 32 && !etags.has(path))
      etags.delete(etags.keys().next().value!);
    if (responseEtag) etags.set(path, { sha: file.sha, value: responseEtag });
    else etags.delete(path);
    return file.sha === sha
      ? null
      : {
          sha: file.sha,
          text: Buffer.from(file.content, "base64").toString("utf8"),
        };
  };
  return Object.assign(read, {
    async createReview(path: string, text: string, expectedSha?: string) {
      if (
        permission !== "write" ||
        !/^reviews\/\d{4}-\d{2}-\d{2}\.md$/.test(path)
      )
        throw new HabitUnavailable();
      // Refresh repository authorization before creating a document.
      await read(null, "SYSTEM.md");
      const repo = env.QUANTSELF_HABITS_REPOSITORY!;
      const endpoint = `/repos/${repo}/contents/${path}`;
      const existing = await request(endpoint, token!.value, {}, false, [404]);
      if (existing.status !== 404) return;
      const created = await request(
        endpoint,
        token!.value,
        {
          method: "PUT",
          body: JSON.stringify({
            message: `Start habit review ${path}`,
            content: Buffer.from(text).toString("base64"),
          }),
        },
        false,
        [409, 422],
      );
      if (created.status === 409 || created.status === 422) {
        // A concurrent creator won. Verify the file exists; never supply a SHA or replace it.
        await request(endpoint, token!.value, {}, false);
      }
    },
  });
}
export const habitLoader = githubHabitLoader();
