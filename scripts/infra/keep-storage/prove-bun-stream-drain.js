import { connect } from "node:net";
import { once } from "node:events";

const watchdog = setTimeout(() => {
  console.error(JSON.stringify({ error: "proof deadline", bun: Bun.version }));
  process.exit(2);
}, 14000);

function bridgeBody(body, onCancel) {
  const reader = body.getReader();
  let released = false;
  function releaseReader() {
    if (!released) {
      released = true;
      reader.releaseLock();
    }
  }
  return new ReadableStream({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          releaseReader();
          controller.close();
        } else {
          controller.enqueue(chunk.value);
        }
      } catch (error) {
        releaseReader();
        throw error;
      }
    },
    async cancel(reason) {
      onCancel();
      try {
        await reader.cancel(reason);
      } catch {
        // The upstream connection may have closed already.
      } finally {
        releaseReader();
      }
    },
  }, { highWaterMark: 0 });
}

async function cancellationErrorControl() {
  let cancelled = 0;
  const upstream = new ReadableStream({
    cancel() {
      cancelled++;
      throw Error("synthetic upstream cancellation rejection");
    },
  });
  await bridgeBody(upstream, () => {}).cancel("synthetic downstream cancellation");
  if (cancelled !== 1 || upstream.locked) throw Error("bridge cancellation cleanup differed");
  console.log(JSON.stringify({ name: "bridge-cancel-error", cancelled, upstreamUnlocked: true }));
}

async function trial(name) {
  let release, entered, cancelCount = 0, bridgeCancelCount = 0, pulls = 0;
  const enteredPull = new Promise(resolve => { entered = resolve; });
  const pendingPull = new Promise(resolve => { release = resolve; });
  const aborted = name.endsWith("-aborted");
  const forwarded = name.startsWith("forwarded-");
  const bridged = name.includes("-bridge-");
  const first = "first fixture chunk";
  const second = "second fixture chunk";
  const last = Buffer.byteLength(first + second) - 1;
  const range = `bytes=0-${last}`;

  function response() {
    if (name === "buffered") return new Response(first);
    return new Response(new ReadableStream({
      pull(controller) {
        if (++pulls === 1) {
          controller.enqueue(Buffer.from(first));
          return;
        }
        if (aborted) {
          entered();
          return pendingPull.then(() => {
            try { controller.close(); } catch {}
          });
        }
        controller.enqueue(Buffer.from(second));
        controller.close();
      },
      cancel() { cancelCount++; },
    }), forwarded ? {
      status: 206,
      headers: { "Content-Type": "audio/wav", "Content-Range": `bytes 0-${last}/120` },
    } : { headers: { "Content-Type": "text/event-stream" } });
  }

  const bind = { hostname: "127.0.0.1", port: 0, development: false };
  const upstream = forwarded ? Bun.serve({ ...bind, fetch: response }) : null;
  const server = Bun.serve({
    ...bind,
    async fetch(request) {
      if (!upstream) return response();
      const received = await fetch(`http://127.0.0.1:${upstream.port}/`, {
        signal: AbortSignal.timeout(2000),
        headers: { Range: request.headers.get("Range") || range },
      });
      const body = bridged && received.body ? bridgeBody(received.body, () => { bridgeCancelCount++; }) : received.body;
      return new Response(body, { status: received.status, headers: received.headers });
    },
  });
  const url = `http://127.0.0.1:${server.port}/`;
  if (aborted) {
    const socket = connect(server.port, "127.0.0.1");
    await once(socket, "connect");
    socket.write(`GET / HTTP/1.1\r\nHost: localhost\r\nRange: ${range}\r\n\r\n`);
    let observed = "";
    await new Promise((resolve, reject) => {
      socket.on("data", chunk => {
        observed += chunk;
        if (observed.includes(first)) resolve();
      });
      socket.on("error", reject);
      setTimeout(() => reject(Error("no first chunk")), 1000).unref();
    });
    if (!observed.startsWith(forwarded ? "HTTP/1.1 206" : "HTTP/1.1 200"))
      throw Error("unexpected first-chunk response");
    await enteredPull;
    const closed = once(socket, "close");
    socket.destroy();
    await closed;
  } else {
    const res = await fetch(url, { headers: { Connection: "close", Range: range } });
    if (res.status !== (forwarded ? 206 : 200) || await res.text() !== (name === "buffered" ? first : first + second))
      throw Error("control content or status differed");
  }
  await Bun.sleep(80);
  const before = server.pendingRequests;
  const upstreamBefore = upstream?.pendingRequests ?? null;
  const started = performance.now();
  let stopMs = null;
  const stopped = server.stop(false).then(() => { stopMs = Math.round(performance.now() - started); });
  const deadline = 500;
  const stoppedBeforeDeadline = await Promise.race([stopped.then(() => true), Bun.sleep(deadline).then(() => false)]);
  const atDeadline = server.pendingRequests;
  release();
  const stoppedAfterRelease = await Promise.race([stopped.then(() => true), Bun.sleep(deadline).then(() => false)]);
  console.log(JSON.stringify({
    name, before, atDeadline, deadline, stoppedBeforeDeadline, stoppedAfterRelease, stopMs, cancelCount, bridgeCancelCount,
    pendingAfterRelease: server.pendingRequests, upstreamBefore, upstreamAfterRelease: upstream?.pendingRequests ?? null,
  }));
  if (!stoppedAfterRelease) void server.stop(true);
  if (upstream) void upstream.stop(true);
  return stoppedBeforeDeadline;
}

console.log(JSON.stringify({ bun: Bun.version }));
try {
  const variant = process.argv[2] ?? "both";
  if (!["baseline", "bridge", "both"].includes(variant)) throw Error("invalid proof variant");
  const names = ["buffered", "stream", "stream-aborted"];
  if (variant !== "bridge") names.push("forwarded-stream", "forwarded-aborted");
  if (variant !== "baseline") names.push("forwarded-bridge-stream", "forwarded-bridge-aborted");
  let allStopped = true;
  for (const name of names) {
    if (!await trial(name)) allStopped = false;
  }
  if (variant !== "baseline") await cancellationErrorControl();
  clearTimeout(watchdog);
  process.exit(allStopped ? 0 : 3);
} catch (error) {
  console.error(JSON.stringify({ error: error.message, bun: Bun.version }));
  process.exit(2);
}
