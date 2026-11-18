<?php
$authority = 'atlas-browser.fixture.ts.net:18445';
$context = stream_context_create(['ssl' => [
    'local_cert' => '/fixture/front-door.crt',
    'local_pk' => '/fixture/front-door.key',
]]);
$listener = stream_socket_server('tls://127.0.0.1:18445', $errno, $error, STREAM_SERVER_BIND | STREAM_SERVER_LISTEN, $context);
if (!$listener) {
    exit(1);
}
while (true) {
    // This test relay models Serve's Host and scheme forwarding. It accepts only fixture GETs.
    $client = @stream_socket_accept($listener, 2);
    if (!$client) {
        continue;
    }
    stream_set_timeout($client, 2);
    $request = fgets($client, 4096);
    if ($request === false || !str_starts_with($request, 'GET /')) {
        fclose($client);
        continue;
    }
    $headers = [];
    while (($line = fgets($client, 4096)) !== false && trim($line) !== '') {
        $parts = explode(':', $line, 2);
        if (count($parts) === 2) {
            $headers[strtolower($parts[0])] = trim($parts[1]);
        }
    }
    $backend = stream_socket_client('tcp://127.0.0.1:18080', $errno, $error, 2);
    if ($backend) {
        $forwarded = 'Host: ' . ($headers['host'] ?? $authority) . "\r\n"
            . "X-Forwarded-Proto: https\r\nConnection: close\r\n";
        if (isset($headers['x-fixture-funnel'])) {
            $forwarded .= "Tailscale-Funnel-Request: true\r\n";
        }
        fwrite($backend, $request . $forwarded . "\r\n");
        stream_copy_to_stream($backend, $client);
        fclose($backend);
    }
    fclose($client);
}
