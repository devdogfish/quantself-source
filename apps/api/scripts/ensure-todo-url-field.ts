/** Provision the optional URL text field. Dry-run by default; --apply creates only when absent. */
import { createPrivateKey, sign } from "node:crypto";

async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== "--apply")) throw Error("Usage: ensure-todo-url-field.ts [--apply]");
  const apply = args.includes("--apply");
  const repository = process.env.QUANTSELF_TODO_REPOSITORY;
  const appId = process.env.QUANTSELF_GITHUB_APP_ID;
  const installationId = process.env.QUANTSELF_GITHUB_INSTALLATION_ID;
  const privateKey = process.env.QUANTSELF_GITHUB_PRIVATE_KEY;
  if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository) || !/^\d+$/.test(appId ?? "") || !/^\d+$/.test(installationId ?? "") || !privateKey) throw Error("Missing configured task repository/GitHub App credentials.");
  const [owner, repo] = repository.split("/");
  const request = async (path: string, token: string, method = "GET", body?: unknown) => {
    const response = await fetch(`https://api.github.com${path}`, { method, redirect: "error", signal: AbortSignal.timeout(20000), headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10", ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok) throw Error(`GitHub ${method} ${path}: HTTP ${response.status}. No credentials or response body logged.`);
    const link = response.headers.get("link")?.match(/<([^>]+)>; rel="next"/)?.[1];
    let next: string | undefined;
    if (link) { const url = new URL(link); if (url.origin !== "https://api.github.com" || url.pathname !== `/orgs/${owner}/issue-fields`) throw Error("Unexpected pagination target."); next = url.pathname + url.search; }
    return { data: await response.json() as any, next };
  };
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: now - 60, exp: now + 540, iss: appId })}`;
  const jwt = `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), createPrivateKey(privateKey)).toString("base64url")}`;
  const [app, installation] = await Promise.all([request("/app", jwt), request(`/app/installations/${installationId}`, jwt)]);
  if (String(app.data.id) !== appId || String(installation.data.app_id) !== appId || installation.data.account?.login?.toLowerCase() !== owner.toLowerCase() || installation.data.suspended_at || installation.data.repository_selection !== "selected") throw Error("Configured GitHub installation identity/scope mismatch.");
  if (apply && installation.data.permissions?.issue_fields !== "write") throw Error("Existing installation lacks Issue Fields write permission. No permissions changed.");
  const access = await request(`/app/installations/${installationId}/access_tokens`, jwt, "POST", { repositories: [repo], permissions: { issues: "read", metadata: "read", issue_fields: apply ? "write" : "read" } });
  if (!access.data.token) throw Error("GitHub returned no installation token.");
  const token: string = access.data.token;
  const allowed = (await request("/installation/repositories?per_page=100", token)).data;
  if (allowed.total_count !== 1 || allowed.repositories?.length !== 1 || allowed.repositories[0].full_name?.toLowerCase() !== repository.toLowerCase() || !allowed.repositories[0].private) throw Error("Token scope must be only the dedicated private task repository.");
  const find = async () => {
    const fields: any[] = []; const seen = new Set<string>();
    let path: string | undefined = `/orgs/${owner}/issue-fields?per_page=100`;
    while (path) { if (seen.has(path) || seen.size >= 100) throw Error("Incomplete pagination."); seen.add(path); const page = await request(path, token); if (!Array.isArray(page.data)) throw Error("Invalid field collection."); fields.push(...page.data); path = page.next; }
    const matches = fields.filter(field => field.name?.toLowerCase() === "url");
    if (matches.length > 1 || matches.some(field => field.name !== "URL" || field.data_type !== "text")) throw Error("Existing URL field is ambiguous or incompatible; nothing changed.");
    return matches[0];
  };
  const existing = await find();
  if (existing) { console.log(JSON.stringify({ action: "no-op", fieldId: existing.id, name: "URL", type: "text" })); return; }
  if (!apply) { console.log(JSON.stringify({ action: "create", repository, field: { name: "URL", data_type: "text" } })); return; }
  // Never replay a POST blindly after an uncertain response: rerun to check existence first.
  await request(`/orgs/${owner}/issue-fields`, token, "POST", { name: "URL", data_type: "text", description: "Task links, one per line." });
  const verified = await find();
  if (!verified) throw Error("URL creation readback failed. Recheck before retrying.");
  console.log(JSON.stringify({ saved: true, fieldId: verified.id, name: "URL", type: "text" }));
}
if (import.meta.main) main().catch(error => { console.error(error instanceof Error ? error.message : "URL setup failed."); process.exitCode = 1; });
