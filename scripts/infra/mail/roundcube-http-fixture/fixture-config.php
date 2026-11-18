<?php
$config['imap_auth_type'] = 'IMAP';
$config['imap_timeout'] = 5;
$config['create_default_folders'] = false;
$config['imap_cache'] = null;
$config['messages_cache'] = false;
$config['mail_read_time'] = -1;
$config['enable_spellcheck'] = false;
if (getenv('QS_ROUNDCUBE_FIXTURE_HTTPS') === '1') {
    $proxy = gethostbyname('edge');
    $config['proxy_whitelist'] = filter_var($proxy, FILTER_VALIDATE_IP) ? [$proxy] : [];
    $fault = getenv('QS_ROUNDCUBE_FIXTURE_IMAP_TLS_FAULT');
    $host = $fault === 'hostname' ? 'imap-wrong-name' : 'imap-fixture';
    $config['quantself_original_mailbox'] = ['account' => 'jobs@example.test', 'host' => $host, 'port' => 1993];
    $config['imap_host'] = "ssl://{$host}:1993";
    $config['imap_conn_options'] = ['ssl' => [
        'verify_peer' => true, 'verify_peer_name' => true, 'allow_self_signed' => false,
    ]];
    if ($fault !== 'ca') {
        $config['imap_conn_options']['ssl']['cafile'] = '/fixture/imap.crt';
    }
}
