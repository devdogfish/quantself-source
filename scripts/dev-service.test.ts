import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devServiceLabel, devServicePlist, runDevService } from "./dev-service";

test.skipIf(process.platform !== "darwin")("macOS accepts restart configuration, literal paths, group cleanup and private logs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quantself-service-test-"));
  try {
    const file = join(directory, "dev.plist");
    const repository = "/tmp/Quantself & Work <test>";
    await writeFile(file, devServicePlist(repository, "/opt/homebrew/bin/bun", "/tmp/log & output"));
    const parse = Bun.spawn(["plutil", "-convert", "json", "-o", "-", file], { stdout: "pipe", stderr: "pipe" });
    const parsed = await new Response(parse.stdout).json();
    expect(await parse.exited).toBe(0);
    expect(parsed.Label).toBe(devServiceLabel);
    expect(parsed.ProgramArguments).toEqual(["/opt/homebrew/bin/bun", `--env-file=${repository}/.env`, "run", `${repository}/scripts/dev.ts`]);
    // Normal circuit-open exit1 must not reset the retry budget.
    expect(parsed.KeepAlive).toEqual({ Crashed: true });
    expect(parsed.RunAtLoad).toBe(true);
    expect(parsed.AbandonProcessGroup).toBe(false);
    expect(parsed.ThrottleInterval).toBeGreaterThanOrEqual(300);
    expect(parsed.ExitTimeOut).toBeGreaterThan(0);
    expect(parsed.Umask).toBe(0o077);
    expect(parsed.StandardOutPath).toBe(parsed.StandardErrorPath);
    expect(Object.keys(parsed.EnvironmentVariables).sort()).toEqual(["PATH", "QUANTSELF_DEV_MANAGED"]);
    expect(parsed.EnvironmentVariables.QUANTSELF_DEV_MANAGED).toBe("1");
    expect(parsed.EnvironmentVariables.PATH.split(":")).toContain("/Applications/Docker.app/Contents/Resources/bin");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("unknown service actions cannot install or stop a job", async () => {
  await expect(runDevService("restart-everything")).rejects.toThrow();
});
