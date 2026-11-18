<?php
declare(strict_types=1);

namespace Quantself\Mail;

/** Bind guarded actions to one account and one implicitly encrypted IMAP endpoint. */
final class OriginalMailbox
{
    private function __construct(
        public readonly string $account,
        private readonly string $host,
        private readonly int $port,
    ) {
    }

    public static function fromConfig(\rcube_config $config): ?self
    {
        $mailbox = $config->get('quantself_original_mailbox');
        if (!is_array($mailbox)) {
            return null;
        }
        $account = $mailbox['account'] ?? null;
        $host = $mailbox['host'] ?? null;
        $port = $mailbox['port'] ?? null;
        if (!is_string($account) || !filter_var($account, FILTER_VALIDATE_EMAIL)
            || !is_string($host) || !filter_var($host, FILTER_VALIDATE_DOMAIN, FILTER_FLAG_HOSTNAME)
            || !is_int($port) || $port < 1 || $port > 65535
            || $config->get('imap_host') !== "ssl://{$host}:{$port}"
            || $config->get('storage_driver', 'imap') !== 'imap'
            || $config->get('username_domain')) {
            return null;
        }
        // Core applies login_lc before its user lookup. The exact session binding
        // requires the configured account to survive that transformation.
        $loginCase = $config->get('login_lc', 2);
        if ($loginCase) {
            [$local, $domain] = \rcube_utils::explode('@', $account);
            $canonical = $loginCase == 2 || $loginCase === true
                ? mb_strtolower($account)
                : $local . '@' . mb_strtolower($domain);
            if ($canonical !== $account) {
                return null;
            }
        }
        $context = $config->get('imap_conn_options');
        $ssl = is_array($context) ? ($context['ssl'] ?? null) : null;
        if (!is_array($ssl) || ($ssl['verify_peer'] ?? null) !== true
            || ($ssl['verify_peer_name'] ?? null) !== true
            || ($ssl['allow_self_signed'] ?? null) !== false
            || ($ssl['peer_name'] ?? $host) !== $host) {
            return null;
        }
        return new self($account, $host, $port);
    }

    public function permitsLogin(array $auth): bool
    {
        return ($auth['user'] ?? null) === $this->account
            && ($auth['host'] ?? null) === "ssl://{$this->host}:{$this->port}";
    }

    public function permitsSession(array $session): bool
    {
        return !empty($session['user_id'])
            && ($session['username'] ?? null) === $this->account
            && ($session['storage_host'] ?? null) === $this->host
            && ($session['storage_port'] ?? null) === $this->port
            && ($session['storage_ssl'] ?? null) === 'ssl';
    }
}
