import { createConnection } from "node:net";

export const observerSocketPath = "/run/quantself-roundcube-observer/observe.sock";
export const observerClientUid = 41001;
export const observerClientGid = 41002;
export const observerDeadlineMs = 4250;
export const observerRequestBytes = 1024;
export const observerResponseBytes = 4096;

export function isObserverFrame(bytes: Buffer, limit: number) {
  return bytes.length > 1 && bytes.length <= limit && bytes.indexOf(10) === bytes.length - 1;
}

export async function readObserverBytes(stream: ReadableStream<Uint8Array>, limit: number) {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return Buffer.concat(chunks, length);
      length += chunk.value.byteLength;
      if (length > limit) {
        void reader.cancel().catch(() => {});
        throw new Error("Observer stream exceeds its limit");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
}

export async function exchangeObserverFrame(path: string, request: Buffer) {
  if (!isObserverFrame(request, observerRequestBytes)) return null;
  return new Promise<Buffer | null>(resolve => {
    const socket = createConnection({ path });
    const chunks: Buffer[] = [];
    let received = 0;
    const deadline = setTimeout(() => finish(null), observerDeadlineMs);
    function finish(response: Buffer | null) {
      clearTimeout(deadline);
      socket.destroy();
      resolve(response);
    }
    socket.on("error", () => finish(null));
    socket.on("close", () => finish(null));
    socket.on("connect", () => socket.write(request));
    socket.on("data", (data: Buffer) => {
      received += data.length;
      if (received > observerResponseBytes) finish(null);
      else chunks.push(data);
    });
    socket.on("end", () => {
      const response = Buffer.concat(chunks);
      finish(isObserverFrame(response, observerResponseBytes) ? response : null);
    });
  });
}
