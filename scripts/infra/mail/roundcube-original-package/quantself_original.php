<?php
declare(strict_types=1);

use Quantself\Mail\OriginalMailbox;
use function Quantself\Mail\verifyOriginalShowHandoff;
use function Quantself\Mail\verifyOriginalReference;

require_once __DIR__ . '/verify.php';
require_once __DIR__ . '/mailbox.php';
require_once __DIR__ . '/bounded_imap.php';

/** Guarded read entry points for a dedicated Jobs Roundcube instance. */
final class quantself_original extends rcube_plugin
{
    public $task = 'mail|login';

    private const RESUME = 'quantself_original_resume';
    private const SCOPES = ['show' => 'show', 'viewsource' => 'source', 'get' => 'attachment'];
    private ?OriginalMailbox $mailbox = null;
    private ?array $settings = null;
    private ?string $resume = null;
    private ?array $pending = null;
    /** @var resource|null Hold first-time provisioning until PHP closes the request. */
    private $provisionLock = null;

    public function init()
    {
        $config = rcmail::get_instance()->config;
        $this->mailbox = OriginalMailbox::fromConfig($config);
        $settings = $config->get('quantself_original');
        if ($this->mailbox && is_array($settings) && ($settings['mode'] ?? null) === 'guarded-v1') {
            $audience = $settings['audience'] ?? null;
            $path = $settings['base_path'] ?? null;
            $spool = $settings['spool_dir'] ?? null;
            $encoded = $settings['public_key_base64'] ?? null;
            $key = is_string($encoded) && strlen($encoded) === 44 ? base64_decode($encoded, true) : false;
            if (function_exists('sodium_crypto_sign_verify_detached')
                && $key !== false && strlen($key) === 32 && base64_encode($key) === $encoded
                && is_string($audience) && filter_var($audience, FILTER_VALIDATE_DOMAIN, FILTER_FLAG_HOSTNAME)
                && is_string($path) && preg_match('~\A/(?:[a-zA-Z0-9_-]+/)*\z~', $path)
                && is_string($spool) && fixture_bounded_imap::private_spool_directory($spool)) {
                $this->settings = ['audience' => $audience, 'path' => $path, 'spool' => $spool, 'key' => $key];
            }
        }

        $this->add_hook('startup', [$this, 'capture_resume']);
        $this->add_hook('unauthenticated', [$this, 'on_unauthenticated']);
        $this->add_hook('authenticate', [$this, 'on_authenticate']);
        $this->add_hook('login_after', [$this, 'on_login']);
        $this->add_hook('ready', [$this, 'guard_read']);
    }

    public function capture_resume(array $args): array
    {
        if ($args['task'] === 'login' && $args['action'] === 'login') {
            $this->resume = $_SESSION[self::RESUME] ?? null;
        }
        return $args;
    }

    public function on_unauthenticated(array $args): array
    {
        if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'GET') {
            return $args;
        }
        unset($_SESSION[self::RESUME]);
        if (isset($_GET['_ref']) || isset($_GET['_parts']) || isset($_GET['_source'])) {
            $raw = $_SERVER['QUERY_STRING'] ?? '';
            $this->verify($this->parse_query($raw));
            $_SESSION[self::RESUME] = $raw;
        }
        return $args;
    }

    public function on_authenticate(array $args): array
    {
        if (!$args['valid']) {
            return $args;
        }
        $this->require_ready();
        if (!$this->mailbox->permitsLogin($args)) {
            $this->reject();
        }
        $posted = $_POST['_url'] ?? '';
        if ($this->resume === null) {
            $query = [];
            if (is_string($posted)) {
                parse_str($posted, $query);
            }
            if (isset($query['_ref']) || isset($query['_parts']) || isset($query['_source'])) {
                $this->reject();
            }
        } else {
            if ($posted !== $this->resume) {
                $this->reject();
            }
            $this->pending = $this->parse_query($this->resume);
        }
        $this->guard_first_login($args['host']);
        if ($this->pending !== null) {
            $this->verify($this->pending);
        }
        return $args;
    }

    private function guard_first_login(string $endpoint): void
    {
        $config = rcmail::get_instance()->config;
        if (!$config->get('auto_create_user')) {
            return;
        }
        [$host] = rcube_utils::parse_host_uri($endpoint, 143, 993);
        if (rcube_user::query($this->mailbox->account, $host) !== null) {
            return;
        }

        // Core looks up the user before IMAP login and inserts it afterward.
        $lock = @fopen($this->settings['spool'] . '/provision.lock', 'c+b');
        if ($lock === false) {
            $this->reject();
        }
        $deadline = hrtime(true) + 5_000_000_000;
        do {
            if (@flock($lock, LOCK_EX | LOCK_NB, $contended)) {
                $this->provisionLock = $lock;
                return;
            }
            usleep(20_000);
        } while ($contended && hrtime(true) < $deadline);
        fclose($lock);
        $this->reject();
    }

    public function on_login(array $args): array
    {
        $this->require_ready();
        $redirect = $args;
        unset($redirect['abort']);
        if (!$this->mailbox->permitsSession($_SESSION)
            || ($this->pending === null && (isset($redirect['_ref']) || isset($redirect['_parts']) || isset($redirect['_source'])))
            || ($this->pending !== null && $redirect !== $this->pending)) {
            rcmail::get_instance()->kill_session();
            $this->reject();
        }
        if ($this->pending === null) {
            return $args;
        }
        $this->verify($redirect);
        header('Location: ' . $this->settings['path'] . '?' . $this->resume, true, 302);
        exit;
    }

    public function guard_read(array $args): array
    {
        if ($args['task'] !== 'mail') {
            return $args;
        }
        $this->require_ready();
        if (!$this->mailbox->permitsSession($_SESSION)) {
            $this->reject();
        }
        $action = $args['action'];
        if (!isset(self::SCOPES[$action])) {
            if ($action !== '' || isset($_REQUEST['_ref']) || isset($_REQUEST['_parts']) || isset($_REQUEST['_source'])) {
                $this->reject();
            }
            return $args;
        }
        if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'GET') {
            $this->reject();
        }
        $query = $this->parse_query($_SERVER['QUERY_STRING'] ?? '');
        if (($query['_action'] ?? null) !== $action) {
            $this->reject();
        }
        $verified = $this->verify($query);
        $ref = $verified['reference'];
        $storage = rcmail::get_instance()->get_storage();
        if ($storage->conn->connected()) {
            $this->reject();
        }
        $reader = new fixture_bounded_imap();
        $reader->use_spool_directory($this->settings['spool']);
        $reader->forbid_native_body(fn () => $this->reject());
        $storage->conn = $reader;
        if ((string) ($storage->folder_data($ref['folder'])['UIDVALIDITY'] ?? '') !== (string) $ref['uidValidity']) {
            $this->reject();
        }
        if ($action === 'get' || $action === 'viewsource') {
            $attachment = $action === 'get';
            $spool = $attachment
                ? $reader->fetch_attachment($ref['folder'], $ref['uidValidity'], $ref['uid'], $ref['part'], $ref['messageId'])
                : $reader->fetch_source($ref['folder'], $ref['uidValidity'], $ref['uid'], $ref['messageId']);
            if ($spool === false) {
                $this->reject();
            }
            $size = fstat($spool)['size'] ?? 0;
            if ($size < 1) {
                fclose($spool);
                $this->reject();
            }
            header('Cache-Control: private, no-store');
            header('X-Content-Type-Options: nosniff');
            header('Content-Type: ' . ($attachment ? 'application/octet-stream' : 'text/plain; charset=UTF-8'));
            if ($attachment) {
                header('Content-Disposition: attachment; filename="part-' . $ref['part'] . '.bin"');
            }
            header('Content-Length: ' . $size);
            fpassthru($spool);
            fclose($spool);
            exit;
        }
        $body = $reader->fetch_display($ref['folder'], $ref['uidValidity'], $ref['uid'], $ref['messageId'],
            $verified['source'] !== null);
        if ($body === false) {
            $this->reject();
        }
        $this->render_display($body, $verified['parts'], $verified['source']);
    }

    private function render_display(?string $body, array $parts, ?string $source): never
    {
        $links = '';
        foreach ($parts as $part => $token) {
            $href = '?' . http_build_query([
                '_task' => 'mail', '_action' => 'get', '_part' => $part, '_ref' => $token,
            ], '', '&', PHP_QUERY_RFC3986);
            $filename = htmlspecialchars('part-' . $part . '.bin', ENT_QUOTES, 'UTF-8');
            $links .= '<li><a class="filename" href="' . htmlspecialchars($href, ENT_QUOTES, 'UTF-8') . '">'
                . $filename . '</a></li>';
        }

        header('Cache-Control: private, no-store');
        header('Content-Type: text/html; charset=UTF-8');
        header('X-Content-Type-Options: nosniff');
        header('Referrer-Policy: no-referrer');
        header("Content-Security-Policy: default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
        echo '<!doctype html><html lang="en"><meta charset="UTF-8"><title>Original message</title>';
        echo '<main>';
        if ($source !== null) {
            $href = '?' . http_build_query([
                '_task' => 'mail', '_action' => 'viewsource', '_ref' => $source,
            ], '', '&', PHP_QUERY_RFC3986);
            echo '<p><a id="view-source" href="' . htmlspecialchars($href, ENT_QUOTES, 'UTF-8') . '">View source</a></p>';
        }
        if ($body === null) {
            echo '<p>HTML preview unavailable.</p>';
        } else {
            echo '<pre><span>' . htmlspecialchars($body, ENT_QUOTES, 'UTF-8') . '</span></pre>';
        }
        if ($links !== '') {
            echo '<ul aria-label="Attachments">' . $links . '</ul>';
        }
        exit('</main></html>');
    }

    private function parse_query(string $raw): array
    {
        if (strlen($this->settings['path'] ?? '/') + 1 + strlen($raw) > 4096) {
            $this->reject();
        }
        $query = [];
        foreach (explode('&', $raw) as $field) {
            if (!preg_match('/\A(?:(?:_task|_action|_ref|_part|_source)=[A-Za-z0-9_.-]+|_parts=[A-Za-z0-9_.!~-]+)\z/', $field)) {
                $this->reject();
            }
            [$name, $value] = explode('=', $field, 2);
            if (isset($query[$name])) {
                $this->reject();
            }
            $query[$name] = $value;
        }
        return $query;
    }

    private function verify(array $query): array
    {
        $this->require_ready();
        $scope = self::SCOPES[$query['_action'] ?? ''] ?? null;
        if (($query['_task'] ?? '') !== 'mail' || $scope === null) {
            $this->reject();
        }
        $key = $this->settings['key'];
        $audience = $this->settings['audience'];
        $account = $this->mailbox->account;
        $token = $query['_ref'] ?? '';
        $part = $query['_part'] ?? null;
        if (isset($query['_parts']) || isset($query['_source'])) {
            $bundle = $scope === 'show' && $part === null
                ? verifyOriginalShowHandoff($token, $query['_parts'] ?? null, $key, $audience, $account, time(),
                    $query['_source'] ?? null)
                : null;
            return $bundle ?? $this->reject();
        }
        $reference = verifyOriginalReference($token, $key, $audience, $account, $scope, $part, time());
        return ['reference' => $reference ?? $this->reject(), 'parts' => [], 'source' => null];
    }

    private function require_ready(): void
    {
        if ($this->settings === null || !rcube_utils::https_check()) {
            $this->reject();
        }
    }

    private function reject(): never
    {
        http_response_code(409);
        header('Cache-Control: private, no-store');
        header('Content-Type: text/plain; charset=UTF-8');
        exit("Original message unavailable\n");
    }
}
