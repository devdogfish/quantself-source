"""Tunnel Chromium HTTPS only to the pinned address of its saved origin."""

import asyncio
from ipaddress import ip_address
import re
import socket


HEADER_NAME = re.compile(rb"[!#$%&'*+.^_`|~0-9A-Za-z-]+")


class PinnedOriginProxy:
    def __init__(self, origin, address):
        host, self.port = origin
        host = f"[{host}]" if ":" in host else host
        self.authority = f"{host}:{self.port}".encode("ascii")
        self.address = ip_address(address)
        self.server = None
        self.clients = {}
        self.lifecycle = asyncio.Lock()

    async def start(self):
        async with self.lifecycle:
            if self.server is None:
                self.server = await asyncio.start_server(self._accept, "127.0.0.1", 0, limit=8192)
            return self.server.sockets[0].getsockname()[1]

    async def close(self):
        async with self.lifecycle:
            if self.server is None:
                return
            server, self.server = self.server, None
            server.close()
            clients = list(self.clients.items())
            for task, writer in clients:
                writer.close()
                task.cancel()
            await asyncio.gather(*(task for task, _ in clients), return_exceptions=True)
            await server.wait_closed()

    def _accept(self, reader, writer):
        if self.server is None or len(self.clients) >= 24:
            writer.close()
            return
        task = asyncio.create_task(self._handle(reader, writer))
        self.clients[task] = writer
        task.add_done_callback(self.clients.pop)

    def _permitted(self, request):
        line, *headers = request.removesuffix(b"\r\n\r\n").split(b"\r\n")
        if line.split(b" ") != [b"CONNECT", self.authority, b"HTTP/1.1"]:
            return False
        hosts = []
        for header in headers:
            name, colon, value = header.partition(b":")
            if (not colon or not HEADER_NAME.fullmatch(name)
                    or any(byte < 32 and byte != 9 or byte == 127 for byte in value)):
                return False
            name = name.lower()
            if name in {b"content-length", b"transfer-encoding"}:
                return False
            if name == b"host":
                hosts.append(value.strip())
        return hosts == [self.authority]

    async def _handle(self, reader, writer):
        upstream = None
        try:
            async with asyncio.timeout(5):
                request = await reader.readuntil(b"\r\n\r\n")
                if not self._permitted(request):
                    writer.write(b"HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
                    await writer.drain()
                    return
                family = socket.AF_INET if self.address.version == 4 else socket.AF_INET6
                incoming, upstream = await asyncio.open_connection(
                    str(self.address), self.port, family=family, flags=socket.AI_NUMERICHOST,
                )
                writer.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                await writer.drain()
            async with asyncio.timeout(60):
                await self._relay(reader, writer, incoming, upstream)
        except (OSError, asyncio.IncompleteReadError, asyncio.LimitOverrunError):
            pass
        finally:
            writer.close()
            if upstream is not None:
                upstream.close()

    @staticmethod
    async def _relay(client_reader, client_writer, upstream_reader, upstream_writer):
        async def copy(reader, writer):
            while data := await reader.read(65536):
                writer.write(data)
                await writer.drain()
            writer.write_eof()

        tasks = [asyncio.create_task(copy(client_reader, upstream_writer)),
                 asyncio.create_task(copy(upstream_reader, client_writer))]
        try:
            await asyncio.gather(*tasks)
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
