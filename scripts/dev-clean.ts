import { lstat, rm } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { previewCacheDirectory, previewKinds } from "../apps/web/preview-cache";
import { createBunCommandRunner, type CommandRunner } from "./ops";

async function stat(path: string) {
  return lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
}

async function directory(path: string) {
  const entry = await stat(path);
  if (!entry) return false;
  if (!entry.isDirectory()) throw new Error(`Expected a real development directory: ${path}`);
  return true;
}

async function nextCache(dist: string) {
  if (!await directory(dist)) return;
  const dev = join(dist, "dev");
  if (!await directory(dev)) return;
  if (await stat(join(dev, "lock"))) throw new Error(`Stop Next.js and review its development lock before cleaning: ${dev}`);
  const cache = join(dev, "cache");
  if (await directory(cache)) return cache;
}

export async function cleanDevelopmentCaches(root: string) {
  const apps = join(root, "apps");
  const web = join(apps, "web");
  const next = join(web, ".next");
  if (!await directory(apps) || !await directory(web) || !await directory(next)) return [];
  const distributions = [next, ...previewKinds.map(kind => join(web, previewCacheDirectory(kind)))];
  const paths = (await Promise.all(distributions.map(nextCache))).filter(path => path !== undefined);

  for (const path of paths) await rm(path, { recursive: true, force: true });
  return paths.map(path => relative(root, path));
}

export async function pruneLegacyDevImages(runner: CommandRunner, env: NodeJS.ProcessEnv = process.env) {
  const inspection = env.DOCKER_HOST ? null : await runner.run([
    "docker", "context", "inspect", "--format", "{{.Endpoints.docker.Host}}",
  ]);
  if (inspection && inspection.exitCode !== 0) throw new Error("Cannot inspect the active Docker context.");
  const endpoint = (env.DOCKER_HOST ?? inspection?.stdout ?? "").trim();
  if (!/^(?:unix:\/\/\/|npipe:\/\/\/\/)/.test(endpoint) || /[\r\n]/.test(endpoint)) {
    throw new Error("Development image cleanup requires a local Docker socket.");
  }
  const result = await runner.run([
    "docker", "--host", endpoint, "image", "prune", "--force",
    "--filter", "label=com.docker.compose.project=quantself-dev",
  ], { env: { DOCKER_CONTEXT: "" }, stdio: "inherit" });
  if (result.exitCode !== 0) throw new Error("Scoped development image cleanup failed.");
}

if (import.meta.main) {
  try {
    const flags = process.argv.slice(2);
    if (flags.length && (flags.length !== 1 || flags[0] !== "--docker-images")) {
      throw new Error("Usage: bun run dev:clean [--docker-images]");
    }
    const removed = await cleanDevelopmentCaches(resolve(import.meta.dir, ".."));
    console.log(removed.length ? `Removed development caches: ${removed.join(", ")}` : "No checkout development caches found.");
    if (flags.length) await pruneLegacyDevImages(createBunCommandRunner());
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Development cleanup failed.");
    process.exitCode = 1;
  }
}
