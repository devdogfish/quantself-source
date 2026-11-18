<?php
$root = dirname(__DIR__, 2);
$runtime = '/run/quantself-roundcube';
$credentialDir = getenv('CREDENTIALS_DIRECTORY');
$key = $credentialDir ? @file_get_contents($credentialDir . '/des-key') : false;
if ($key === false || strlen($key) !== 32) {
    throw new RuntimeException('Missing browser runtime key.');
}
$site = json_decode(file_get_contents($root . '/site.json'), true, flags: JSON_THROW_ON_ERROR);
$host = $site['imap_host'];

$config['db_dsnw'] = 'sqlite:////run/quantself-roundcube/roundcube.sqlite';
$config['des_key'] = $key;
$config['cipher_method'] = 'AES-256-CBC';
$config['temp_dir'] = $runtime . '/tmp';
$config['log_dir'] = $runtime . '/logs';
$config['log_driver'] = 'file';
$config['log_logins'] = false;
$config['enable_installer'] = false;
$config['force_https'] = true;
$config['use_https'] = true;
$config['proxy_whitelist'] = ['127.0.0.1'];
$config['session_domain'] = '';
$config['session_name'] = 'qs_atlas_roundcube';
$config['session_auth_name'] = 'qs_atlas_roundcube_auth';
$config['session_samesite'] = 'Lax';
$config['session_storage'] = 'db';
$config['imap_host'] = 'ssl://' . $host . ':993';
$config['imap_conn_options'] = ['ssl' => [
    'verify_peer' => true,
    'verify_peer_name' => true,
    'allow_self_signed' => false,
    'cafile' => $root . '/imap-ca.pem',
]];
$config['imap_timeout'] = 5;
$config['imap_cache'] = null;
$config['messages_cache'] = false;
$config['mail_read_time'] = -1;
$config['create_default_folders'] = false;
$config['enable_spellcheck'] = false;
$config['disabled_actions'] = ['mail.send'];
$config['plugins'] = ['quantself_original'];
$config['quantself_original'] = [
    'mode' => 'guarded-v1',
    'audience' => parse_url($site['origin'], PHP_URL_HOST),
    'base_path' => '/',
    'public_key_base64' => base64_encode(file_get_contents($root . '/original.pub')),
    'spool_dir' => $runtime . '/spool',
];
$config['quantself_original_mailbox'] = [
    'account' => $site['mailbox'],
    'host' => $host,
    'port' => 993,
];
