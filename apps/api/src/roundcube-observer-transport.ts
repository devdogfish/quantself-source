import {
  isObserverFrame, observerClientGid, observerClientUid, observerDeadlineMs, observerRequestBytes,
  observerResponseBytes, readObserverBytes,
} from "./roundcube-observer-wire";

const clientCommand = [
  "/sbin/su-exec", `${observerClientUid}:${observerClientGid}`, "/usr/local/bin/bun", "--no-env-file",
  "/app/apps/api/src/roundcube-observer-client.ts",
] as const;

export async function observeThroughDedicatedClient(request: Buffer): Promise<Buffer | null> {
  if (!isObserverFrame(request, observerRequestBytes)) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let child: ReturnType<typeof spawnClient> | undefined;
  try {
    const deadline = new Promise<null>(resolve => {
      timer = setTimeout(() => resolve(null), observerDeadlineMs);
    });
    child = spawnClient(request);
    const response = Promise.all([readObserverBytes(child.stdout, observerResponseBytes), child.exited])
      .then(([bytes, status]) => status === 0 && isObserverFrame(bytes, observerResponseBytes) ? bytes : null)
      .catch(() => null);
    return await Promise.race([deadline, response]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    if (child && child.exitCode === null) child.kill("SIGKILL");
  }
}

function spawnClient(request: Buffer) {
  return Bun.spawn([...clientCommand], { cwd: "/", env: {}, stdin: request, stdout: "pipe", stderr: "ignore" });
}
