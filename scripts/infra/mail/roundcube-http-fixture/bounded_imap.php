<?php
declare(strict_types=1);

use const Quantself\Mail\ORIGINAL_MIME_PART;

/** Reader for one combined identity and body FETCH on the selected connection. */
class fixture_bounded_imap extends rcube_imap_generic
{
    private const MAX_LITERAL = 1024;
    private const MAX_IDENTITY = 320;
    private const MAX_MIME = 4096;
    private const MAX_LINE = 256;
    private const MAX_SPOOLED_LITERAL = 8 * 1024 * 1024;
    private const MAX_SOURCE_HEADER = 64 * 1024;
    private const MAX_DISPLAY_WIRE = 256 * 1024;
    private const MAX_DISPLAY_BYTES = 64 * 1024;
    private const ATTACHMENT_CHUNK = 64 * 1024;
    private const MAX_MAIL_LINE = 998;
    private const MAX_QUOTED_PRINTABLE_LINE = 76;
    private const FETCH_NANOSECONDS = 5_000_000_000;

    private ?Closure $denyNativeBody = null;
    private int $fetchDeadline = 0;
    private ?string $spoolDirectory = null;

    public static function private_spool_directory(string $path): bool
    {
        clearstatcache(true, $path);
        return function_exists('posix_geteuid') && $path !== '' && $path[0] === '/' && realpath($path) === $path
            && is_dir($path) && is_writable($path) && @fileowner($path) === posix_geteuid()
            && ((@fileperms($path) ?: 0) & 0777) === 0700;
    }

    /** @return resource|false Verified raw message spool, rewound on success. */
    public function fetch_source(string $folder, int $epoch, int $uid, string $messageId)
    {
        $spool = $this->open_spool();
        if ($spool === false) {
            return false;
        }
        $ready = false;
        try {
            $response = $this->fetch_verified($folder, $epoch, $uid, '', $messageId, self::MAX_SPOOLED_LITERAL,
                fn (int $length) => $this->spool_literal($spool, $length));
            if ($response === false || !rewind($spool)) {
                return false;
            }
            $headerWindow = stream_get_contents($spool, self::MAX_SOURCE_HEADER);
            if ($headerWindow === false || !$this->matches_message_id($headerWindow, $messageId, false)) {
                return $this->reject_fetch();
            }
            $ready = rewind($spool);
            return $ready ? $spool : false;
        } finally {
            if (!$ready) {
                fclose($spool);
            }
        }
    }

    public function use_spool_directory(string $path): void
    {
        $this->spoolDirectory = $path;
    }

    public function forbid_native_body(Closure $deny): void
    {
        $this->denyNativeBody = $deny;
    }

    public function handlePartBody($mailbox, $id, $is_uid = false, $part = '', $encoding = null, $print = null,
        $file = null, $formatted = false, $max_bytes = 0)
    {
        if ($this->denyNativeBody !== null) {
            ($this->denyNativeBody)();
        }
        return parent::handlePartBody($mailbox, $id, $is_uid, $part, $encoding, $print, $file, $formatted, $max_bytes);
    }

    public function fetch_original(string $folder, int $epoch, int $uid, string $section, string $messageId): string|false
    {
        if ($section !== '' && $section !== '1') {
            return false;
        }
        $response = $this->fetch_verified($folder, $epoch, $uid, $section, $messageId, self::MAX_LITERAL,
            fn (int $length) => $this->fetch_bytes($length));
        if ($response === false) {
            return false;
        }
        [$literal] = $response;
        return $section !== '' || $this->matches_message_id($literal, $messageId, false)
            ? $literal
            : $this->reject_fetch();
    }

    /** @return resource|false Anonymous decoded spool, rewound and transferred to the caller on success. */
    public function fetch_attachment(string $folder, int $epoch, int $uid, string $section, string $messageId)
    {
        return $this->fetch_decoded_part($folder, $epoch, $uid, $section, $messageId);
    }

    /** Return null for validated HTML whose only supported view is its signed source. */
    public function fetch_display(string $folder, int $epoch, int $uid, string $messageId,
        bool $allowHtmlFallback): string|false|null
    {
        $part = $this->fetch_decoded_part($folder, $epoch, $uid, '1', $messageId, true, $allowHtmlFallback);
        if ($part === false) {
            return false;
        }
        [$spool, $ascii, $html] = $part;
        try {
            $body = stream_get_contents($spool, self::MAX_DISPLAY_BYTES + 1);
            if ($body === false || strlen($body) > self::MAX_DISPLAY_BYTES || preg_match('//u', $body) !== 1
                || preg_match('/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/', $body)
                || ($ascii && preg_match('/[\x80-\xFF]/', $body))) {
                return $this->reject_fetch();
            }
            return $html ? null : $body;
        } finally {
            fclose($spool);
        }
    }

    /** @return resource|array{resource, bool, bool}|false */
    private function fetch_decoded_part(string $folder, int $epoch, int $uid, string $section, string $messageId,
        bool $display = false, bool $allowHtmlFallback = false)
    {
        if (!preg_match('/\A' . ORIGINAL_MIME_PART . '\z/', $section)) {
            return false;
        }
        $source = $this->open_spool();
        if ($source === false) {
            return false;
        }
        $result = false;
        try {
            $limit = $display ? self::MAX_DISPLAY_WIRE : self::MAX_SPOOLED_LITERAL;
            $response = $this->fetch_verified($folder, $epoch, $uid, $section, $messageId, $limit,
                fn (int $length) => $this->spool_literal($source, $length), true);
            if ($response === false || !rewind($source)) {
                return false;
            }
            [, $mime] = $response;
            $values = $this->header_values($mime, 'content-transfer-encoding', true);
            $encoding = $values === [] ? '7bit' : (count($values ?: []) === 1 ? strtolower($values[0]) : null);
            $ascii = false;
            $html = false;
            if ($display) {
                $types = $this->header_values($mime, 'content-type', true);
                $disposition = $this->header_values($mime, 'content-disposition', true);
                if (count($types ?: []) !== 1
                    || !preg_match('~\Atext/(plain|html)[ \t]*;[ \t]*charset[ \t]*=[ \t]*(?:"(utf-8|us-ascii)"|(utf-8|us-ascii))\z~i',
                        $types[0], $type)
                    || ($disposition !== [] && (count($disposition ?: []) !== 1 || strcasecmp($disposition[0], 'inline') !== 0))
                    || $encoding === 'binary') {
                    return $this->reject_fetch();
                }
                $html = strcasecmp($type[1], 'html') === 0;
                if ($html && !$allowHtmlFallback) {
                    return $this->reject_fetch();
                }
                $ascii = strcasecmp($type[2] !== '' ? $type[2] : $type[3], 'us-ascii') === 0;
            }
            $result = match ($encoding) {
                'base64', 'quoted-printable' => $this->decode_attachment($source, $encoding),
                '7bit', '8bit' => $this->validate_identity($source, $encoding === '7bit') && rewind($source)
                    ? $source : false,
                'binary' => $source,
                default => false,
            };
            if ($result === false) {
                return $this->reject_fetch();
            }
            return $display ? [$result, $ascii, $html] : $result;
        } finally {
            if ($result !== $source) {
                fclose($source);
            }
        }
    }

    /** @return resource|false */
    private function open_spool()
    {
        if ($this->spoolDirectory !== null) {
            if (!self::private_spool_directory($this->spoolDirectory)) {
                return false;
            }
            $path = $this->spoolDirectory . '/qs-' . bin2hex(random_bytes(16));
            $spool = @fopen($path, 'x+b');
            if ($spool === false) {
                return false;
            }
            $secured = @chmod($path, 0600);
            $unlinked = @unlink($path);
            $stat = fstat($spool);
            if (!$secured || !$unlinked || !$stat || ($stat['mode'] & 0170777) !== 0100600
                || $stat['uid'] !== posix_geteuid()) {
                fclose($spool);
                return false;
            }
            return $spool;
        }
        $spool = @tmpfile();
        if ($spool === false) {
            return false;
        }
        // Remove the name before writing any protected bytes.
        $file = stream_get_meta_data($spool)['uri'];
        $mode = fstat($spool)['mode'] ?? 0;
        if (($mode & 0777) !== 0600 || !@unlink($file)) {
            fclose($spool);
            return false;
        }
        return $spool;
    }

    private function fetch_verified(string $folder, int $epoch, int $uid, string $section, string $messageId,
        int $bodyLimit, Closure $readBody, bool $withMime = false): array|false
    {
        if (!$this->connected() || $this->selected !== $folder
            || (int) ($this->data['UIDVALIDITY'] ?? 0) !== $epoch
            || $uid < 1 || $uid > 4294967295) {
            return false;
        }

        $this->fetchDeadline = hrtime(true) + self::FETCH_NANOSECONDS;
        $tag = $this->nextTag();
        $mimeRequest = $withMime ? " BODY.PEEK[{$section}.MIME]" : '';
        if (!$this->putLine("{$tag} UID FETCH {$uid} (UID BODY.PEEK[HEADER.FIELDS (MESSAGE-ID)] BODY.PEEK[{$section}]" . $mimeRequest . ")")) {
            return $this->reject_fetch();
        }

        $line = $this->fetch_line();
        if ($line === false || !preg_match('/\A\* [1-9][0-9]{0,9} FETCH \(/i', $line, $prefix)) {
            return $this->reject_fetch();
        }

        // Accept any attribute order in the same FETCH response.
        $pending = substr($line, strlen($prefix[0]));
        $seenUid = false;
        $identityField = 'BODY[HEADER.FIELDS (MESSAGE-ID)]';
        $bodyField = "BODY[{$section}]";
        $mimeField = "BODY[{$section}.MIME]";
        $limits = [$identityField => self::MAX_IDENTITY, $bodyField => $bodyLimit];
        if ($withMime) {
            $limits[$mimeField] = self::MAX_MIME;
        }
        $literals = [];
        for ($i = 0; $i <= count($limits); ++$i) {
            if (preg_match('/\AUID ' . $uid . '(?= |\)\r\n\z)/i', $pending, $matched) && !$seenUid) {
                $seenUid = true;
                $pending = substr($pending, strlen($matched[0]));
            } else {
                if (!preg_match('/\A(BODY\[[^\]\r\n]*\]) \{([1-9][0-9]{0,7})\}\r\n\z/i', $pending, $item)) {
                    return $this->reject_fetch();
                }
                $field = strtoupper($item[1]);
                $length = (int) $item[2];
                if (!isset($limits[$field]) || isset($literals[$field]) || $length > $limits[$field]) {
                    return $this->reject_fetch();
                }
                $bytes = $field === $bodyField ? $readBody($length) : $this->fetch_bytes($length);
                if ($bytes === false || ($pending = $this->fetch_line()) === false) {
                    return $this->reject_fetch();
                }
                $literals[$field] = $bytes;
            }

            if ($i < count($limits)) {
                if (!str_starts_with($pending, ' ')) {
                    return $this->reject_fetch();
                }
                $pending = substr($pending, 1);
            }
        }
        if (!$seenUid || count($literals) !== count($limits) || $pending !== ")\r\n") {
            return $this->reject_fetch();
        }

        $completion = $this->fetch_line();
        if ($completion === false || hrtime(true) >= $this->fetchDeadline
            || !preg_match('/\\A' . preg_quote($tag, '/') . ' OK(?: [^\\[\\r\\n][^\\r\\n]*)?\\r\\n\\z/', $completion)) {
            return $this->reject_fetch();
        }

        if (!$this->matches_message_id($literals[$identityField], $messageId, true)) {
            return $this->reject_fetch();
        }

        return [$literals[$bodyField], $literals[$mimeField] ?? null];
    }

    private function spool_literal($spool, int $length): bool
    {
        for ($remaining = $length; $remaining > 0; $remaining -= $size) {
            $size = min(self::ATTACHMENT_CHUNK, $remaining);
            $bytes = $this->fetch_bytes($size);
            // A standard IMAP BODY literal cannot carry NUL, even with MIME CTE binary.
            if ($bytes === false || str_contains($bytes, "\0") || @fwrite($spool, $bytes) !== $size) {
                return false;
            }
        }
        return true;
    }

    private function validate_identity($source, bool $sevenBit): bool
    {
        while (($line = fgets($source, self::MAX_MAIL_LINE + 3)) !== false) {
            $terminated = str_ends_with($line, "\r\n");
            $content = $terminated ? substr($line, 0, -2) : $line;
            if (strlen($content) > self::MAX_MAIL_LINE || (!$terminated && !feof($source))
                || preg_match($sevenBit ? '/[\r\n\x80-\xFF]/' : '/[\r\n]/', $content)) {
                return false;
            }
        }
        return feof($source);
    }

    /** @return resource|false */
    private function decode_attachment($source, string $encoding)
    {
        $spool = $this->open_spool();
        if ($spool === false) {
            return false;
        }
        $ready = false;
        try {
            $copied = $encoding === 'base64' ? $this->copy_base64($source, $spool)
                : $this->copy_quoted_printable($source, $spool);
            $ready = $copied && rewind($spool);
            return $ready ? $spool : false;
        } finally {
            if (!$ready) {
                fclose($spool);
            }
        }
    }

    private function copy_quoted_printable($source, $spool): bool
    {
        $softBreak = false;
        $output = '';
        // Allow bounded transport padding. Check the encoded length after removing it.
        while (($line = fgets($source, self::MAX_MAIL_LINE + 3)) !== false) {
            $terminated = str_ends_with($line, "\r\n");
            $content = rtrim($terminated ? substr($line, 0, -2) : $line, " \t");
            if (strlen($line) > self::MAX_MAIL_LINE + ($terminated ? 2 : 0)
                || strlen($content) > self::MAX_QUOTED_PRINTABLE_LINE || (!$terminated && !feof($source))) {
                return false;
            }
            $softBreak = str_ends_with($content, '=');
            if ($softBreak) {
                if (!$terminated) {
                    return false;
                }
                $content = substr($content, 0, -1);
            }
            if (!preg_match('/\A(?:[\t\x20-\x3C\x3E-\x7E]|=[0-9A-F]{2})*\z/', $content)) {
                return false;
            }
            $decoded = preg_replace_callback('/=([0-9A-F]{2})/', fn ($escape) => chr(hexdec($escape[1])), $content);
            if ($decoded === null) {
                return false;
            }
            if ($terminated && !$softBreak) {
                $decoded .= "\r\n";
            }
            $output .= $decoded;
            if (strlen($output) >= self::ATTACHMENT_CHUNK) {
                if (@fwrite($spool, $output) !== strlen($output)) {
                    return false;
                }
                $output = '';
            }
        }
        return feof($source) && !$softBreak
            && @fwrite($spool, $output) === strlen($output) && ftell($spool) > 0;
    }

    private function copy_base64($source, $spool): bool
    {
        $tail = '';
        $padded = false;
        while (!feof($source)) {
            $bytes = fread($source, self::ATTACHMENT_CHUNK);
            if ($bytes === false || ($bytes === '' && !feof($source))) {
                return false;
            }
            $encoded = str_replace(["\r", "\n", " ", "\t"], '', $bytes);
            if ($encoded === '') {
                continue;
            }
            if ($padded) {
                return false;
            }
            $encoded = $tail . $encoded;
            $complete = strlen($encoded) & ~3;
            $tail = substr($encoded, $complete);
            $quartets = substr($encoded, 0, $complete);
            $decoded = base64_decode($quartets, true);
            if ($decoded === false || base64_encode($decoded) !== $quartets
                || @fwrite($spool, $decoded) !== strlen($decoded)) {
                return false;
            }
            $padded = str_ends_with($quartets, '=');
        }
        return $tail === '' && ftell($spool) > 0;
    }

    private function fetch_bytes(int $length): string|false
    {
        $bytes = '';
        while (strlen($bytes) < $length) {
            if (!$this->within_fetch_deadline()) {
                return false;
            }
            $chunk = fread($this->fp, $length - strlen($bytes));
            if ($chunk === false || $chunk === '') {
                return false;
            }
            $bytes .= $chunk;
        }
        return $bytes;
    }

    private function within_fetch_deadline(): bool
    {
        $left = $this->fetchDeadline - hrtime(true);
        return $left > 0 && stream_set_timeout($this->fp, intdiv($left, 1_000_000_000),
            max(1, intdiv($left % 1_000_000_000, 1000)));
    }

    private function matches_message_id(string $bytes, string $expected, bool $projection): bool
    {
        return $this->header_values($bytes, 'message-id', $projection, $projection) === [$expected];
    }

    private function header_values(string $bytes, string $name, bool $headerOnly, bool $singleField = false): array|false
    {
        if ($headerOnly && !$singleField && $bytes === "\r\n") {
            return [];
        }
        $end = strpos($bytes, "\r\n\r\n");
        if ($end === false || ($headerOnly && $end + 4 !== strlen($bytes))) {
            return false;
        }
        $headers = substr($bytes, 0, $end);
        if (preg_match('/\r(?!\n)|(?<!\r)\n|[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/', $headers)) {
            return false;
        }
        if ($name === 'content-transfer-encoding'
            && preg_match('/\r\n[ \t]+content-transfer-encoding[ \t]*:/i', $headers)) {
            return false;
        }

        $lines = explode("\r\n", preg_replace('/\r\n[ \t]+/', ' ', $headers));
        if ($singleField && count($lines) !== 1) {
            return false;
        }
        $values = [];
        foreach ($lines as $line) {
            if (!preg_match('/\A([!-9;-~]+):[ \t]*(.*)\z/', $line, $field)) {
                return false;
            }
            if (strcasecmp($field[1], $name) === 0) {
                $values[] = rtrim($field[2], " \t");
            }
        }
        return $values;
    }

    private function fetch_line(): string|false
    {
        // fgets can perform multiple socket reads under the same idle timeout.
        $line = '';
        for ($i = 0; $i < self::MAX_LINE; ++$i) {
            $byte = $this->fetch_bytes(1);
            if ($byte === false) {
                return false;
            }
            $line .= $byte;
            if ($byte === "\n") {
                return str_ends_with($line, "\r\n") ? $line : false;
            }
        }
        return false;
    }

    private function reject_fetch(): false
    {
        $this->closeSocket();
        return false;
    }
}
