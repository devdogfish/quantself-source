import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { reservePort, startDevOwnerIngress } from "../../../scripts/dev-owner-ingress";
import type { PreviewKind } from "../preview-cache";

type PreviewProcessOptions = {
  command: [string, ...string[]];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  stopApi: () => void | Promise<void>;
  onStart?: () => void;
};

export async function runPreviewProcess(options: PreviewProcessOptions, graceMs = 3000) {
  const group = process.platform !== "win32";
  let child: ChildProcess | undefined;
  let exited: Promise<number> | undefined;
  const interrupt = Promise.withResolvers<number>();
  const exitFor = { SIGINT: 130, SIGTERM: 143 } as const;
  const onInterrupt = () => interrupt.resolve(exitFor.SIGINT);
  const onTerminate = () => interrupt.resolve(exitFor.SIGTERM);
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);

  function signal(signal: NodeJS.Signals | 0) {
    if (!child?.pid) return false;
    try {
      return group ? process.kill(-child.pid, signal) : child.kill(signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      throw error;
    }
  }

  try {
    const [command, ...args] = options.command;
    child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: "inherit", detached: group });
    exited = new Promise<number>((resolve, reject) => {
      child!.once("error", reject);
      child!.once("exit", (code, childSignal) => {
        resolve(code ?? (childSignal && childSignal in exitFor ? exitFor[childSignal as keyof typeof exitFor] : 1));
      });
    });
    void exited.catch(() => {});
    options.onStart?.();
    return await Promise.race([exited, interrupt.promise]);
  } finally {
    try {
      if (signal("SIGTERM")) {
        const deadline = performance.now() + graceMs;
        while (performance.now() < deadline && signal(0)) await Bun.sleep(25);
        if (signal(0)) signal("SIGKILL");
      }
      await exited?.catch(() => {});
    } finally {
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onTerminate);
      await options.stopApi();
    }
  }
}

export function createPreviewOwnerIngress(port: number) {
  const origin = `http://127.0.0.1:${port}`;
  const proof = randomBytes(32).toString("hex");
  return {
    env: {
      QUANTSELF_PUBLIC_ORIGIN: origin,
      QUANTSELF_OWNER_INGRESS_TOKEN: proof,
    },
    browserInstructions: `For ${origin} requests only, set header x-quantself-owner-proof: ${proof}`,
  };
}

export async function runNextPreview(input: {
  kind: PreviewKind;
  port: number;
  env: NodeJS.ProcessEnv;
  server: { stop(closeActiveConnections: boolean): void | Promise<void> };
  message: string;
}) {
  const ownerIngress = createPreviewOwnerIngress(input.port);
  const web = await reservePort(0);
  const ingress = startDevOwnerIngress(input.port, web.port, ownerIngress.env.QUANTSELF_OWNER_INGRESS_TOKEN, "127.0.0.1");
  try {
    await once(ingress, "listening");
  } catch (error) {
    await web.release();
    await input.server.stop(true);
    throw error;
  }
  await web.release();
  return runPreviewProcess({
    command: [process.execPath, "run", "--cwd", "apps/web", "dev", "--hostname", "127.0.0.1", "--port", String(web.port)],
    cwd: fileURLToPath(new URL("../../..", import.meta.url)),
    env: { ...input.env, ...ownerIngress.env, QUANTSELF_NEXT_PREVIEW: input.kind },
    stopApi: () => {
      ingress.close();
      ingress.closeAllConnections();
      return input.server.stop(true);
    },
    onStart: () => console.log(input.message),
  });
}
