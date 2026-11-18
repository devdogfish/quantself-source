/** Rename the existing organization field in place. No task/option writes.
 * Docs: https://docs.github.com/en/rest/orgs/issue-fields#update-issue-field-for-an-organization
 * Dry run: bun apps/api/scripts/rename-todo-category-field.ts
 * Apply: add --apply --expected=<dry-run fingerprint> --backup=/absolute/new/file.json
 */
import { createHash, createPrivateKey, sign } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

type Field = { id: number; name: string; data_type: string; options?: unknown[]; [key: string]: unknown };
export function planCategoryFieldRename(fields: Field[]) {
  const categories = fields.filter(field => field.name === "Category");
  const areas = fields.filter(field => field.name === "Area");
  if (categories.length > 1 || areas.length > 1 || (categories.length && areas.length)) throw Error("Ambiguous Area/Category fields; resolve duplicates manually.");
  const field = categories[0] ?? areas[0];
  if (!field || field.data_type !== "single_select" || !Number.isSafeInteger(field.id)) throw Error("Expected exactly one existing single-select Category or Area field.");
  return { action: categories.length ? "no-op" : "rename", fieldId: field.id, optionCount: field.options?.length ?? 0,
    fingerprint: createHash("sha256").update(JSON.stringify(field)).digest("hex"), field };
}
export function verifyCategoryFieldRename(before: Field, after: Field) {
  const stable = (field: Field) => { const { name: _name, updated_at: _updated, ...rest } = field; return JSON.stringify(rest); };
  if (after.name !== "Category" || stable(before) !== stable(after)) throw Error("Rename readback mismatch. Inspect the backup; do not retry an option write.");
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== "--apply" && !arg.startsWith("--expected=") && !arg.startsWith("--backup="))) throw Error("Unknown argument.");
  const apply = args.includes("--apply");
  const expected = args.find(arg => arg.startsWith("--expected="))?.slice(11);
  const backup = args.find(arg => arg.startsWith("--backup="))?.slice(9);
  if (apply && (!expected || !backup || !isAbsolute(backup))) throw Error("Apply requires --expected=<dry-run fingerprint> and --backup=<absolute new file path>.");
  const repository = process.env.QUANTSELF_TODO_REPOSITORY;
  const appId = process.env.QUANTSELF_GITHUB_APP_ID;
  const installationId = process.env.QUANTSELF_GITHUB_INSTALLATION_ID;
  const privateKey = process.env.QUANTSELF_GITHUB_PRIVATE_KEY;
  if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository) || !/^\d+$/.test(appId ?? "") || !/^\d+$/.test(installationId ?? "") || !privateKey) throw Error("Missing configured to-do repository/GitHub App credentials.");
  const [owner, repo] = repository.split("/");
  const request = async (path: string, token: string, method = "GET", body?: unknown): Promise<{ data: any; next?: string }> => {
    const response = await fetch(`https://api.github.com${path}`, { method, redirect: "error", signal: AbortSignal.timeout(20000), headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10", ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok) throw Error(`GitHub ${method} ${path}: HTTP ${response.status}. No credentials or response body logged.`);
    const nextUrl = response.headers.get("link")?.match(/<([^>]+)>; rel="next"/)?.[1];
    let next: string | undefined;
    if (nextUrl) { const url = new URL(nextUrl); if (url.origin !== "https://api.github.com" || url.pathname !== `/orgs/${owner}/issue-fields`) throw Error("Unexpected pagination target."); next = url.pathname + url.search; }
    return { data: await response.json(), next };
  };
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const timestamp = Math.floor(Date.now() / 1000);
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: timestamp - 60, exp: timestamp + 540, iss: appId })}`;
  const jwt = `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), createPrivateKey(privateKey)).toString("base64url")}`;
  const [app, installation] = await Promise.all([request("/app", jwt), request(`/app/installations/${installationId}`, jwt)]);
  if (String(app.data.id) !== appId || String(installation.data.app_id) !== appId || installation.data.account?.login?.toLowerCase() !== owner.toLowerCase() || installation.data.suspended_at || installation.data.repository_selection !== "selected") throw Error("Configured GitHub App installation identity/scope mismatch.");
  const permission = installation.data.permissions?.issue_fields;
  if (apply && permission !== "write") throw Error("Existing installation lacks Issue Fields write permission. No permissions changed.");
  const access = await request(`/app/installations/${installationId}/access_tokens`, jwt, "POST", { repositories: [repo], permissions: { issues: "read", metadata: "read", issue_fields: apply ? "write" : "read" } });
  if (!access.data.token) throw Error("GitHub returned no installation token.");
  const token: string = access.data.token;
  const list = async () => {
    const fields: Field[] = [];
    let path: string | undefined = `/orgs/${owner}/issue-fields?per_page=100`;
    const seen = new Set<string>();
    while (path) { if (seen.has(path) || seen.size >= 100) throw Error("Incomplete pagination."); seen.add(path); const page = await request(path, token); if (!Array.isArray(page.data)) throw Error("Invalid fields collection."); fields.push(...page.data); path = page.next; }
    return fields;
  };
  const fields = await list();
  const plan = planCategoryFieldRename(fields);
  const report = { repository, organization: owner, action: plan.action, fieldId: plan.fieldId, optionCount: plan.optionCount, fingerprint: plan.fingerprint, installedIssueFieldsPermission: permission, patch: plan.action === "rename" ? { name: "Category" } : null };
  console.log(JSON.stringify(report, null, 2));
  if (!apply || plan.action === "no-op") return;
  if (expected !== plan.fingerprint) throw Error("Field changed since dry run. Review a fresh dry run before applying.");
  await writeFile(backup!, JSON.stringify({ capturedAt: new Date().toISOString(), repository, fields, plan: report }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  const fresh = planCategoryFieldRename(await list());
  if (fresh.action !== "rename" || fresh.fingerprint !== plan.fingerprint) throw Error("Field changed during backup. Nothing renamed.");
  await request(`/orgs/${owner}/issue-fields/${plan.fieldId}`, token, "PATCH", { name: "Category" });
  const verified = planCategoryFieldRename(await list());
  verifyCategoryFieldRename(plan.field, verified.field);
  console.log(JSON.stringify({ saved: true, fieldId: verified.fieldId, name: "Category", optionsPreserved: true, backup }));
}
if (import.meta.main) main().catch(error => { console.error(error instanceof Error ? error.message : "Rename failed."); process.exitCode = 1; });
