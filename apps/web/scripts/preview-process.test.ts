import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nextDevCacheConfig } from "../preview-cache";
import { runPreviewProcess } from "./preview-process";

test("native and preview dev caches use isolated paths and native persistent caching requires opt-in", () => {
  expect(nextDevCacheConfig({})).toEqual({ distDir: ".next", turbopackFileSystemCacheForDev: false });
  expect(nextDevCacheConfig({ QUANTSELF_DEV_TURBOPACK_DISK_CACHE: "1" })).toMatchObject({ turbopackFileSystemCacheForDev: true });
  for (const kind of ["jobs", "todo", "habits", "website-analytics"]) {
    expect(nextDevCacheConfig({ QUANTSELF_NEXT_PREVIEW: kind, QUANTSELF_DEV_TURBOPACK_DISK_CACHE: "1" }))
      .toEqual({ distDir: `.next/${kind}-preview`, turbopackFileSystemCacheForDev: false });
  }
  expect(nextDevCacheConfig({ QUANTSELF_NEXT_PREVIEW: "../../outside" }).distDir).toBe(".next");
  expect(nextDevCacheConfig({ QUANTSELF_HABITS_PREVIEW: "1" }).distDir).toBe(".next/habits-preview");
});

test("preview startup failure stops its stub", async () => {
  let stopped = false;
  await expect(runPreviewProcess({
    command: [join(tmpdir(), "nonexistent-quantself-preview-command")], cwd: tmpdir(),
    stopApi: () => { stopped = true; },
  })).rejects.toThrow();
  expect(stopped).toBe(true);
});

test.skipIf(process.platform === "win32")("an exited launcher releases its preview grandchild and the stub, preserving the exit status", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quantself-preview-exit-"));
  try {
    const program = `
      import { spawn } from "node:child_process";
      const child = spawn(process.execPath, ["-e", ${JSON.stringify('const server = Bun.serve({hostname:"127.0.0.1",port:0,fetch:()=>new Response("preview")}); console.log(server.port);')}]);
      child.stdout.once("data", data => { Bun.write("port.txt", String(data)).then(() => process.exit(7)); });
    `;
    let stopped = false;
    const code = await runPreviewProcess({
      command: [process.execPath, "-e", program], cwd: directory,
      stopApi: () => { stopped = true; },
    }, 250);
    expect(code).toBe(7);
    expect(stopped).toBe(true);
    const port = Number((await Bun.file(join(directory, "port.txt")).text()).trim());
    expect(port).toBeGreaterThan(0);
    await expect(fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")("SIGTERM closes both sockets, including a child that ignores graceful shutdown", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quantself-preview-signal-"));
  const helper = new URL("./preview-process.ts", import.meta.url).pathname;
  const script = join(directory, "supervisor.ts");
  const childSource = 'process.on("SIGTERM", () => {}); const server = Bun.serve({hostname:"127.0.0.1",port:0,fetch:()=>new Response("preview")}); console.log(server.port);';
  let preview: ReturnType<typeof Bun.spawn> | undefined;
  try {
    await writeFile(script, `
      import { runPreviewProcess } from ${JSON.stringify(helper)};
      const stub = Bun.serve({hostname:"127.0.0.1",port:0,fetch:()=>new Response("stub")});
      console.log(stub.port);
      process.exitCode = await runPreviewProcess({
        command:[process.execPath,"-e",${JSON.stringify(childSource)}], cwd:process.cwd(),
        stopApi: () => stub.stop(true),
      }, 100);
    `);
    const processUnderTest = Bun.spawn([process.execPath, script], { cwd: directory, stdout: "pipe", stderr: "inherit" });
    preview = processUnderTest;
    const reader = processUnderTest.stdout.getReader();
    let stdout = "";
    while (stdout.split("\n").length < 3) {
      const chunk = await reader.read();
      if (chunk.done) break;
      stdout += new TextDecoder().decode(chunk.value);
    }
    const [stubPort, webPort] = stdout.trim().split("\n").map(Number);
    expect(stubPort).toBeGreaterThan(0);
    expect(webPort).toBeGreaterThan(0);
    const url = (port: number) => `http://127.0.0.1:${port}`;
    expect(await (await fetch(url(stubPort))).text()).toBe("stub");
    expect(await (await fetch(url(webPort))).text()).toBe("preview");
    processUnderTest.kill("SIGTERM");
    expect(await processUnderTest.exited).toBe(143);
    await expect(fetch(url(stubPort), { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
    await expect(fetch(url(webPort), { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
    reader.releaseLock();
  } finally {
    if (preview?.exitCode === null) preview.kill("SIGTERM");
    await preview?.exited;
    await rm(directory, { recursive: true, force: true });
  }
});
