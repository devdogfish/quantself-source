<?php
$fixtureMode = getenv('QS_ROUNDCUBE_FIXTURE_PACKAGE');
$key = file_get_contents('/package-input/public.key');
$config['quantself_original'] = [
    'mode' => $fixtureMode === 'mode' ? 'native' : 'guarded-v1',
    'audience' => $fixtureMode === 'audience' ? 'wrong.example.test' : 'roundcube.jobs.example.test',
    'base_path' => '/',
    'spool_dir' => $fixtureMode === 'spool' ? '/tmp/missing-quantself-original' : '/tmp/quantself-original',
    'public_key_base64' => match ($fixtureMode) {
        'no-key' => '',
        'wrong-key' => base64_encode(str_repeat('x', 32)),
        default => base64_encode($key),
    },
];
$config['quantself_original_mailbox'] = [
    'account' => $fixtureMode === 'mixed-case-account' ? 'Jobs@example.test' : 'jobs@example.test',
    'host' => 'imap-fixture',
    'port' => 1993,
];
$config['imap_host'] = $fixtureMode === 'host' ? 'ssl://imap-wrong-name:1993' : 'ssl://imap-fixture:1993';
$config['imap_conn_options'] = ['ssl' => [
    'verify_peer' => true, 'verify_peer_name' => true, 'allow_self_signed' => false,
    'cafile' => '/package-input/imap.crt',
]];
$config['imap_auth_type'] = 'IMAP';
$config['imap_timeout'] = 5;
$config['create_default_folders'] = false;
$config['imap_cache'] = null;
$config['messages_cache'] = false;
$config['mail_read_time'] = -1;
$config['enable_spellcheck'] = false;
$proxy = gethostbyname('edge');
$config['proxy_whitelist'] = filter_var($proxy, FILTER_VALIDATE_IP) ? [$proxy] : [];
