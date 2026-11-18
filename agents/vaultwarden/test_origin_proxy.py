import asyncio
import unittest

from origin_proxy import PinnedOriginProxy


class PinnedOriginProxyTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.dials = 0
        self.target_closed = asyncio.Event()

        async def echo(reader, writer):
            self.dials += 1
            try:
                while chunk := await reader.read(4096):
                    writer.write(chunk)
                    await writer.drain()
            finally:
                writer.close()
                self.target_closed.set()

        self.target = await asyncio.start_server(echo, "127.0.0.1", 0)
        self.addAsyncCleanup(self.target.wait_closed)
        self.addCleanup(self.target.close)
        self.origin_port = self.target.sockets[0].getsockname()[1]
        self.authority = f"saved.example:{self.origin_port}"
        self.proxy = PinnedOriginProxy(("saved.example", self.origin_port), "127.0.0.1")
        self.addAsyncCleanup(self.proxy.close)
        self.proxy_port = await self.proxy.start()

    async def connect(self, request):
        reader, writer = await asyncio.open_connection("127.0.0.1", self.proxy_port)
        self.addAsyncCleanup(writer.wait_closed)
        self.addCleanup(writer.close)
        writer.write(request.encode("ascii"))
        await writer.drain()
        return reader, writer

    async def test_tunnels_only_to_the_pinned_ip_and_port(self):
        request = f"CONNECT {self.authority} HTTP/1.1\r\nHost: {self.authority}\r\n\r\n"
        reader, writer = await self.connect(request)
        self.assertEqual(await reader.readuntil(b"\r\n\r\n"), b"HTTP/1.1 200 Connection Established\r\n\r\n")
        writer.write(b"tunnel data")
        await writer.drain()
        self.assertEqual(await reader.readexactly(11), b"tunnel data")
        self.assertEqual(self.dials, 1)

    async def test_refuses_foreign_authorities_and_malformed_requests(self):
        attempts = (
            f"CONNECT foreign.example:{self.origin_port} HTTP/1.1\r\nHost: foreign.example:{self.origin_port}",
            "CONNECT saved.example:1 HTTP/1.1\r\nHost: saved.example:1",
            f"CONNECT 127.0.0.1:{self.origin_port} HTTP/1.1\r\nHost: 127.0.0.1:{self.origin_port}",
            f"CONNECT user@{self.authority} HTTP/1.1\r\nHost: {self.authority}",
            f"CONNECT https://{self.authority} HTTP/1.1\r\nHost: {self.authority}",
            f"GET https://{self.authority}/ HTTP/1.1\r\nHost: {self.authority}",
            f"CONNECT {self.authority} HTTP/1.1\r\nHost: foreign.example:{self.origin_port}",
            f"CONNECT {self.authority} HTTP/1.1\r\nHost: {self.authority}\r\nHost: {self.authority}",
            f"CONNECT {self.authority} HTTP/1.1\r\nHost: {self.authority}\r\nContent-Length: 4",
            f"CONNECT {self.authority} HTTP/1.1\r\nHost: {self.authority}\r\nBad(Name: example",
            f"CONNECT {self.authority} HTTP/1.1\r\nHost: {self.authority}\r\nX-Test: line\nbreak",
        )
        for request in attempts:
            with self.subTest(request=request):
                reader, _ = await self.connect(request + "\r\n\r\n")
                self.assertTrue((await reader.read()).startswith(b"HTTP/1.1 403 Forbidden\r\n"))
        self.assertEqual(self.dials, 0)

    async def test_refuses_oversized_headers_before_dialing(self):
        request = f"CONNECT {self.authority} HTTP/1.1\r\nHost: {self.authority}\r\nX-Test: "
        reader, _ = await self.connect(request + "a" * 8192 + "\r\n\r\n")
        self.assertEqual(await reader.read(), b"")
        self.assertEqual(self.dials, 0)

    async def test_close_ends_open_tunnels_and_permits_restart(self):
        request = f"CONNECT {self.authority} HTTP/1.1\r\nHost: {self.authority}\r\n\r\n"
        self.assertEqual(await self.proxy.start(), self.proxy_port)
        reader, _ = await self.connect(request)
        await reader.readuntil(b"\r\n\r\n")
        await asyncio.wait_for(self.proxy.close(), 1)
        self.assertEqual(await reader.read(), b"")
        await asyncio.wait_for(self.target_closed.wait(), 1)
        await self.proxy.close()
        self.proxy_port = await self.proxy.start()
        reader, _ = await self.connect(request)
        self.assertTrue((await reader.readuntil(b"\r\n\r\n")).startswith(b"HTTP/1.1 200 "))
        self.assertEqual(self.dials, 2)
