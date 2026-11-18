import { createServer, request } from "node:http";
import { createServer as createTcpServer } from "node:net";

export function startDevOwnerIngress(port: number, webPort: number, proof: string, hostname = "localhost") {
  const host = `${hostname}:${port}`;
  const origin = `http://${host}`;
  const server = createServer((incoming, response) => {
    if (incoming.headers.host !== host || !incoming.url?.startsWith("/") ||
        (incoming.headers.origin !== undefined && incoming.headers.origin !== origin)) {
      response.writeHead(403).end();
      return;
    }
    const upstream = request({
      hostname: "127.0.0.1",
      port: webPort,
      method: incoming.method,
      path: incoming.url,
      headers: {
        ...incoming.headers,
        "x-forwarded-host": host,
        "x-forwarded-proto": "http",
        "x-quantself-owner-proof": proof,
      },
    }, result => {
      response.writeHead(result.statusCode ?? 502, result.headers);
      result.pipe(response);
      response.on("close", () => result.destroy());
    });
    upstream.on("error", () => {
      if (response.headersSent) response.destroy();
      else response.writeHead(502).end();
    });
    response.on("close", () => upstream.destroy());
    incoming.pipe(upstream);
  });

  // Next's development server uses a separate WebSocket for hot reload.
  server.on("upgrade", (incoming, client, head) => {
    if (incoming.headers.host !== host || incoming.headers.origin !== origin ||
        incoming.url?.split("?", 1)[0] !== "/_next/webpack-hmr") {
      client.destroy();
      return;
    }
    const upstream = request({
      hostname: "127.0.0.1",
      port: webPort,
      path: incoming.url,
      headers: {
        host,
        origin,
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-key": incoming.headers["sec-websocket-key"] ?? "",
        "sec-websocket-version": incoming.headers["sec-websocket-version"] ?? "13",
      },
    });
    upstream.on("response", () => client.destroy());
    upstream.on("error", () => client.destroy());
    upstream.on("upgrade", (result, socket, buffered) => {
      client.write(`HTTP/1.1 ${result.statusCode} ${result.statusMessage}\r\n`);
      for (let i = 0; i < result.rawHeaders.length; i += 2) {
        client.write(`${result.rawHeaders[i]}: ${result.rawHeaders[i + 1]}\r\n`);
      }
      client.write("\r\n");
      if (buffered.length) client.write(buffered);
      if (head.length) socket.write(head);
      client.pipe(socket).pipe(client);
      client.on("close", () => socket.destroy());
      socket.on("close", () => client.destroy());
      socket.on("error", () => client.destroy());
    });
    client.on("error", () => upstream.destroy());
    client.on("close", () => upstream.destroy());
    upstream.end();
  });
  return server.listen(port, "127.0.0.1");
}

/** Reserve the first available web port, or an OS-assigned API port (start=0). */
export async function reservePort(start = 3000): Promise<{ port: number; release: () => Promise<void> }> {
  for (let port = start; port <= 65535; port++) {
    const server = createTcpServer(socket => socket.destroy());
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
      });
      const address = server.address();
      if (!address || typeof address === "string") throw Error("Cannot determine development port.");
      return { port: address.port, release: () => new Promise<void>(resolve => server.close(() => resolve())) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE" || start === 0) throw error;
    }
  }
  throw Error("No available development port.");
}
