import { expect, test } from "bun:test";

test("backup signal waits for the admitted batch and prevents a second claim", async () => {
  const child = Bun.spawn(["bun", "-e", `
    import { runInventoryWorkerLoop } from "./apps/web/scripts/inventory-worker-loop";
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    process.on("message", release);
    await runInventoryWorkerLoop(async () => {
      process.send("claim");
      await gate;
      console.log("batch complete");
      return 1;
    }, { pollIntervalMs: 100, runOnce: false });
    process.disconnect();
  `], {
    cwd: new URL("../../../", import.meta.url).pathname,
    stdout: "pipe",
    ipc(message, process) {
      expect(message).toBe("claim");
      process.kill("SIGTERM");
      // A second message after the signal lets the original claim finish.
      setTimeout(() => process.send("release"), 25);
    },
  });

  try {
    const output = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    expect(output.trim().split("\n")).toEqual(["batch complete", "Inventory worker drain complete"]);
  } finally {
    child.kill("SIGKILL");
  }
}, 5_000);
