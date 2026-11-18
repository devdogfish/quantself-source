import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { cleanDevelopmentCaches, pruneLegacyDevImages } from "./dev-clean";
import type { CommandRunner } from "./ops";

async function fixture(run: (root: string, write: (path: string) => Promise<void>) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "quantself-dev-clean-"));
  try {
    await run(root, async path => {
      const file = join(root, path);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, "synthetic");
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("clears only this checkout's native and preview Next development caches", async () => {
  await fixture(async (root, write) => {
    const known = ["native/apps/web/.next/dev/cache/data", "native/apps/web/.next/jobs-preview/dev/cache/data"];
    const preserved = [
      "native/apps/web/.next/cache/build-data", "native/apps/web/.next/dev/types/routes.ts",
      "native/apps/web/.next/new-preview/dev/cache/data", "other/apps/web/.next/dev/cache/data",
    ];
    await Promise.all([...known, ...preserved].map(write));
    expect(await cleanDevelopmentCaches(join(root, "native"))).toEqual(["apps/web/.next/dev/cache", "apps/web/.next/jobs-preview/dev/cache"]);
    for (const path of known) expect(await Bun.file(join(root, path)).exists()).toBe(false);
    for (const path of preserved) expect(await readFile(join(root, path), "utf8")).toBe("synthetic");
  });
});

test("a lock or symlink refuses cleanup before removing another development cache", async () => {
  await fixture(async (root, write) => {
    const existing = "apps/web/.next/dev/cache/data";
    const preview = "apps/web/.next/todo-preview/dev";
    await Promise.all([write(existing), write(`${preview}/lock`), write("elsewhere/data")]);
    await expect(cleanDevelopmentCaches(root)).rejects.toThrow("development lock");
    await rm(join(root, preview, "lock"));
    await symlink(join(root, "elsewhere"), join(root, preview, "cache"), "dir");
    await expect(cleanDevelopmentCaches(root)).rejects.toThrow("real development directory");
    expect(await readFile(join(root, existing), "utf8")).toBe("synthetic");
    expect(await readFile(join(root, "elsewhere/data"), "utf8")).toBe("synthetic");
  });
});

test("the opt-in Docker command targets only dangling images of the native dev project on a local socket", async () => {
  const calls: Parameters<CommandRunner["run"]>[] = [];
  const runner: CommandRunner = {
    interrupt() {},
    async run(...args) {
      calls.push(args);
      return { exitCode: 0, stdout: "unix:///private/tmp/docker.sock\n", stderr: "" };
    },
  };
  await pruneLegacyDevImages(runner, {});
  expect(calls).toEqual([
    [["docker", "context", "inspect", "--format", "{{.Endpoints.docker.Host}}"]],
    [["docker", "--host", "unix:///private/tmp/docker.sock", "image", "prune", "--force",
      "--filter", "label=com.docker.compose.project=quantself-dev"], { env: { DOCKER_CONTEXT: "" }, stdio: "inherit" }],
  ]);
  await expect(pruneLegacyDevImages(runner, { DOCKER_HOST: "ssh://production.example.test" })).rejects.toThrow("local Docker socket");
  expect(calls).toHaveLength(2);
});
