<?php
// Synthetic HTTP qualification only.
require_once '/fixture/reference-verifier.php';
require_once '/fixture/bounded_imap.php';
require_once '/fixture/mailbox-policy.php';
use Quantself\Mail\OriginalMailbox;
class original_fixture extends rcube_plugin
{
    public $task = 'mail|login';
    private const AUDIENCE = 'roundcube.jobs.example.test';
    private const FILES = [2 => 'fixture.bin', 3 => 'other.bin'];
    private ?array $reference = null;
    private ?array $partTokens = null;
    private array $attachments = [];
    private ?string $loginResume = null;
    private ?array $loginQuery = null;
    private bool $retrySignedLogin = false;
    private bool $requireTls;
    private ?OriginalMailbox $mailbox;

    public function init()
    {
        $this->requireTls = getenv('QS_ROUNDCUBE_FIXTURE_HTTPS') === '1';
        $this->mailbox = OriginalMailbox::fromConfig(rcmail::get_instance()->config);
        $this->add_hook('startup', [$this, 'capture_login_resume']);
        $this->add_hook('unauthenticated', [$this, 'remember_signed_click']);
        $this->add_hook('authenticate', [$this, 'check_login_resume']);
        $this->add_hook('login_failed', [$this, 'mark_failed_login']);
        $this->add_hook('login_after', [$this, 'check_login_redirect']);
        $this->add_hook('ready', [$this, 'check_reference']);
        $this->add_hook('message_load', [$this, 'check_message']);
        $this->add_hook('template_object_messageattachments', [$this, 'attachment_links']);
    }

    public function remember_signed_click($args)
    {
        if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'GET') {
            if ($this->retrySignedLogin && $args['http_code'] === 401 && empty($_SESSION['user_id'])) {
                $this->validate_resume($this->loginQuery, $this->mailbox?->account ?? 'jobs@example.test');
                $previous = session_id();
                rcmail::get_instance()->session->regenerate_id(true);
                if (session_id() === $previous) {
                    $this->reject();
                }
                // Core has cleared the failed session. Bind only the verified query to the new form.
                $_SESSION['original_fixture_resume'] = $this->loginResume;
            }
            return $args;
        }
        unset($_SESSION['original_fixture_resume']);
        if (!array_key_exists('_ref', $_GET)) {
            return $args;
        }

        $raw = $_SERVER['QUERY_STRING'] ?? '';
        if ($this->requireTls && $this->mailbox === null) {
            $this->reject();
        }
        $this->validate_resume($this->reference_query($raw), $this->mailbox?->account ?? 'jobs@example.test');
        $_SESSION['original_fixture_resume'] = $raw;
        return $args;
    }

    public function capture_login_resume($args)
    {
        if ($args['task'] === 'login' && $args['action'] === 'login') {
            // Stock login destroys the temporary session before authenticate.
            $this->loginResume = $_SESSION['original_fixture_resume'] ?? null;
        }
        return $args;
    }

    public function check_login_resume($args)
    {
        // Keep stock CSRF and invalid-credential handling.
        if (!$args['valid']) {
            return $args;
        }
        if ($this->requireTls && !$this->mailbox?->permitsLogin($args)) {
            $this->reject();
        }

        $posted = $_POST['_url'] ?? '';
        if ($this->loginResume === null) {
            $query = [];
            if (is_string($posted)) {
                parse_str($posted, $query);
            }
            if (array_key_exists('_ref', $query)) {
                $this->reject();
            }
            return $args;
        }

        if ($posted !== $this->loginResume || (!$this->requireTls && $args['host'] !== 'imap-fixture:1143')) {
            $this->reject();
        }
        $this->loginQuery = $this->reference_query($this->loginResume);
        $this->validate_resume($this->loginQuery, $args['user']);
        return $args;
    }

    public function mark_failed_login($args)
    {
        $this->retrySignedLogin = $this->loginQuery !== null;
        return $args;
    }

    public function check_login_redirect($args)
    {
        $redirect = $args;
        unset($redirect['abort']);
        if ($this->requireTls && !$this->mailbox?->permitsSession($_SESSION)) {
            rcmail::get_instance()->kill_session();
            $this->reject();
        }
        if ($this->loginQuery === null) {
            if (array_key_exists('_ref', $redirect)) {
                rcmail::get_instance()->kill_session();
                $this->reject();
            }
            return $args;
        }

        if ($redirect !== $this->loginQuery
            || (!$this->requireTls && (($_SESSION['storage_host'] ?? '') !== 'imap-fixture'
            || (int) ($_SESSION['storage_port'] ?? 0) !== 1143
            || !empty($_SESSION['storage_ssl'])))) {
            rcmail::get_instance()->kill_session();
            $this->reject();
        }
        $this->validate_resume($redirect, $_SESSION['username'] ?? '', true);

        // Core's redirect helper appends _token. Emit the exact already validated local query.
        header('Location: /?' . $this->loginResume, true, 302);
        exit;
    }

    private function validate_resume(array $query, string $account, bool $authenticated = false): void
    {
        $scope = match ($query['_action'] ?? null) {
            'show' => 'show',
            'viewsource' => 'source',
            'get' => 'attachment',
            default => null,
        };
        if (($query['_task'] ?? null) !== 'mail' || $scope === null
            || $this->verified_query($query, $account, $scope) === null) {
            if ($authenticated) {
                rcmail::get_instance()->kill_session();
            }
            $this->reject();
        }
    }

    private function verified_query(array $query, string $account, string $scope): ?array
    {
        $key = file_get_contents('/fixture/public.key');
        if ($key === false) {
            return null;
        }
        $token = $query['_ref'] ?? '';
        $part = $query['_part'] ?? null;
        $now = time();
        if (isset($query['_parts'])) {
            return $scope === 'show' && $part === null
                ? \Quantself\Mail\verifyOriginalShowHandoff($token, $query['_parts'], $key, self::AUDIENCE, $account, $now)
                : null;
        }
        $reference = \Quantself\Mail\verifyOriginalReference($token, $key, self::AUDIENCE, $account, $scope, $part, $now);
        return $reference === null ? null : ['reference' => $reference, 'parts' => null];
    }

    public function check_reference($args)
    {
        $action = $args['action'];
        $scope = match ($action) {
            'show' => 'show',
            'viewsource' => 'source',
            'get' => 'attachment',
            'preview', 'print' => $this->reject(),
            default => null,
        };
        if ($scope === null) {
            return $args;
        }

        if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'GET'
            || ($this->requireTls && !$this->mailbox?->permitsSession($_SESSION))) {
            $this->reject();
        }
        $query = $this->reference_query($_SERVER['QUERY_STRING'] ?? '');
        if (($query['_task'] ?? null) !== 'mail' || ($query['_action'] ?? null) !== $action) {
            $this->reject();
        }
        $verified = $this->verified_query($query, $_SESSION['username'] ?? '', $scope);
        $reference = $verified['reference'] ?? null;
        if ($reference === null) {
            $this->reject();
        }
        $this->partTokens = $verified['parts'];

        $folder = $reference['folder'];
        $uid = (string) $reference['uid'];
        $_GET['_mbox'] = $_REQUEST['_mbox'] = $folder;
        $_GET['_uid'] = $_REQUEST['_uid'] = $uid;
        $storage = rcmail::get_instance()->get_storage();
        $guardView = $action === 'show' && getenv('QS_ROUNDCUBE_FIXTURE_NATIVE_SHOW') !== '1';
        $bounded = $action !== 'show'
            && getenv('QS_ROUNDCUBE_FIXTURE_NATIVE_PROBE') !== '1'
            && getenv('QS_ROUNDCUBE_FIXTURE_STOCK_STREAM') !== '1';
        if ($bounded || $guardView) {
            if ($storage->conn->connected()) {
                $this->reject();
            }
            $storage->conn = new fixture_bounded_imap();
            if ($guardView) {
                $storage->conn->forbid_native_body(fn () => $this->reject());
            }
        }
        $current = $storage->folder_data($folder)['UIDVALIDITY'] ?? null;
        if ((string) $current !== (string) $reference['uidValidity']) {
            $this->reject();
        }
        if ($bounded) {
            $this->send_verified_fetch($storage->conn, $reference);
        }
        if ($action !== 'show') {
            $storage->set_options(['fetch_headers' => 'MESSAGE-ID']);
            $headers = $storage->get_message_headers($uid, $folder);
            if (!$headers || $headers->get('message-id', false) !== $reference['messageId']) {
                $this->reject();
            }
            if (getenv('QS_ROUNDCUBE_FIXTURE_NATIVE_PROBE') === '1') {
                $this->report_native_fetch($storage->conn, $reference);
            }
        }
        $this->reference = $reference;
        return $args;
    }

    public function check_message($args)
    {
        if ($this->reference === null) {
            return;
        }
        $message = $args['object'];
        if ($message->get_header('message-id', true) !== $this->reference['messageId']) {
            $this->reject();
        }
        $imap = rcmail::get_instance()->get_storage()->conn;
        if ($this->reference['scope'] === 'show' && $imap instanceof fixture_bounded_imap) {
            if ($message->folder !== $this->reference['folder']
                || (string) $message->headers->uid !== (string) $this->reference['uid']) {
                $this->reject();
            }
            $this->prepare_view($imap, $message);
        }
        $this->attachments = $message->attachments;
    }

    private function prepare_view(fixture_bounded_imap $imap, rcube_message $message): void
    {
        // Only the fixture's single unencoded ASCII text part can enter the stock renderer.
        $part = $message->mime_parts['1'] ?? null;
        if (!$part || count($message->parts) !== 1 || $message->parts[0] !== $part
            || $part->mimetype !== 'text/plain' || strtolower($part->encoding ?? '') !== '7bit'
            || strtoupper($part->charset ?? '') !== 'US-ASCII') {
            $this->reject();
        }
        $reference = $this->reference;
        $literal = $imap->fetch_original(
            $reference['folder'], $reference['uidValidity'], $reference['uid'], '1', $reference['messageId'],
        );
        if ($literal === false || strlen($literal) !== $part->size || preg_match('/[^\x09\x0A\x0D\x20-\x7E]/', $literal)) {
            $this->reject();
        }
        $part->body = $literal;
    }

    public function attachment_links($args)
    {
        if (($this->reference['scope'] ?? null) !== 'show') {
            return $args;
        }
        if (getenv('QS_ROUNDCUBE_FIXTURE_STOCK_LINKS') === '1') {
            return $args;
        }

        $key = file_get_contents('/fixture/public.key');
        // The standalone legacy fixture stages its own links. Joined issuance leaves that file empty.
        $tokens = $this->partTokens ?? json_decode(file_get_contents('/fixture/attachment-links.json') ?: '{}', true);
        $links = [];
        foreach ($this->attachments as $attachment) {
            $part = (string) $attachment->mime_id;
            $token = $tokens[$part] ?? null;
            if ($key === false || !is_string($token)) {
                continue;
            }
            $expected = array_replace($this->reference, ['scope' => 'attachment', 'part' => $part]);
            if (\Quantself\Mail\verifyOriginalReference(
                $token, $key, self::AUDIENCE, $expected['account'], 'attachment', $part, time(),
            ) !== $expected) {
                continue;
            }

            $href = '?' . http_build_query([
                '_task' => 'mail', '_action' => 'get', '_part' => $part, '_ref' => $token,
            ], '', '&', PHP_QUERY_RFC3986);
            $links[] = html::tag('li', [], html::a([
                'href' => $href, 'class' => 'filename', 'referrerpolicy' => 'no-referrer',
            ], rcube::Q($this->part_filename($part))));
        }

        $args['content'] = $links ? html::tag('ul', [], implode('', $links)) : '';
        return $args;
    }

    private function reference_query(string $raw): array
    {
        if (strlen($raw) > 4094) {
            $this->reject();
        }

        $query = [];
        // These fixture values are URL-safe ASCII. Reject input that PHP would coalesce or normalize.
        foreach (explode('&', $raw) as $field) {
            if (!preg_match('/\A(?:(?:_task|_action|_ref|_part)=[A-Za-z0-9_.-]+|_parts=[A-Za-z0-9_.!~-]+)\z/', $field)) {
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

    private function report_native_fetch(rcube_imap_generic $imap, array $reference): never
    {
        $part = $reference['part'];
        $body = $imap->handlePartBody(
            $reference['folder'], $reference['uid'], true, $part ?? '', $part === null ? null : 'base64',
        );
        // The probe emits parser metadata only, never the literal returned by the reader.
        header('Content-Type: application/json');
        exit(json_encode([
            'returnedLiteral' => is_string($body),
            'literalBytes' => is_string($body) ? strlen($body) : 0,
            'literalSha256' => is_string($body) ? hash('sha256', $body) : null,
            'selectedEpoch' => (int) ($imap->data['UIDVALIDITY'] ?? 0),
            'errorCode' => $imap->errornum,
        ], JSON_THROW_ON_ERROR));
    }

    private function send_verified_fetch(fixture_bounded_imap $imap, array $reference): never
    {
        $section = $reference['part'] ?? '';
        if ($section !== '') {
            $spool = $imap->fetch_attachment(
                $reference['folder'], $reference['uidValidity'], $reference['uid'], $section, $reference['messageId'],
            );
            if ($spool === false) {
                $this->reject();
            }
            $size = fstat($spool)['size'] ?? 0;
            if ($size < 1) {
                fclose($spool);
                $this->reject();
            }
            header('Cache-Control: private, no-store');
            header('Content-Type: application/octet-stream');
            header('Content-Disposition: attachment; filename="' . $this->part_filename($section) . '"');
            header('Content-Length: ' . $size);
            fpassthru($spool);
            fclose($spool);
            exit;
        }

        $literal = $imap->fetch_original(
            $reference['folder'], $reference['uidValidity'], $reference['uid'], $section, $reference['messageId'],
        );
        if ($literal === false) {
            $this->reject();
        }
        header('Content-Type: text/plain; charset=UTF-8');
        header('Content-Length: ' . strlen($literal));
        exit($literal);
    }

    private function part_filename(string $part): string
    {
        return self::FILES[$part] ?? "part-{$part}.bin";
    }

    private function reject(): never
    {
        http_response_code(409);
        header('Content-Type: text/plain; charset=UTF-8');
        exit("Fixture reference rejected\n");
    }
}
