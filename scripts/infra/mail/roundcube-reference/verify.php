<?php
declare(strict_types=1);

namespace Quantself\Mail;

const ORIGINAL_REFERENCE_VERSION = 'qs-original-v1';
const ORIGINAL_REFERENCE_TTL = 300;
const ORIGINAL_MIME_PART = '[1-9][0-9]{0,8}(?:\.[1-9][0-9]{0,8}){0,7}';

/**
 * Verify one Open original action before calling storage.
 *
 * Account and audience come from the authenticated session and local configuration.
 * Scope and part come from the action being authorized. Use the returned folder,
 * UID and UIDVALIDITY as the sole coordinates for the subsequent storage lookup.
 */
function verifyOriginalReference(
    string $token,
    string $publicKey,
    string $audience,
    string $account,
    string $scope,
    ?string $part,
    int $now,
): ?array {
    if (strlen($token) > 2048 || strlen($publicKey) !== SODIUM_CRYPTO_SIGN_PUBLICKEYBYTES
        || !preg_match('/\Aqs-original-v1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{86})\z/', $token, $segments)) {
        return null;
    }

    try {
        $signature = sodium_base642bin($segments[2], SODIUM_BASE64_VARIANT_URLSAFE_NO_PADDING);
        $signed = ORIGINAL_REFERENCE_VERSION . '.' . $segments[1];
        if (sodium_bin2base64($signature, SODIUM_BASE64_VARIANT_URLSAFE_NO_PADDING) !== $segments[2]
            || !sodium_crypto_sign_verify_detached($signature, $signed, $publicKey)) {
            return null;
        }

        $json = sodium_base642bin($segments[1], SODIUM_BASE64_VARIANT_URLSAFE_NO_PADDING);
        if (sodium_bin2base64($json, SODIUM_BASE64_VARIANT_URLSAFE_NO_PADDING) !== $segments[1]) {
            return null;
        }
        $claims = json_decode($json, false, 3, JSON_THROW_ON_ERROR);
    } catch (\SodiumException | \JsonException) {
        return null;
    }

    // Fixed tuple positions rule out duplicate or unknown claim names.
    if (!is_array($claims) || count($claims) !== 10) {
        return null;
    }
    [$target, $mailbox, $folder, $uid, $uidValidity, $messageId, $action, $section, $issuedAt, $expiresAt] = $claims;

    if ($target !== $audience || $mailbox !== $account || $account === '' || $audience === ''
        || $action !== $scope || !in_array($action, ['show', 'source', 'attachment'], true)
        || $section !== $part
        || ($action === 'attachment'
            ? (!is_string($section) || !preg_match('/\A' . ORIGINAL_MIME_PART . '\z/', $section))
            : $section !== null)) {
        return null;
    }

    if (!is_string($folder) || $folder === '' || strlen($folder) > 256 || preg_match('/\p{Cc}/u', $folder)
        || !is_int($uid) || $uid < 1 || $uid > 4294967295
        || !is_int($uidValidity) || $uidValidity < 1 || $uidValidity > 4294967295
        || !is_string($messageId) || strlen($messageId) > 254
        || !preg_match('/\A<[!#$%&\x27*+\/=?^_`{|}~A-Za-z0-9-]+(?:\.[!#$%&\x27*+\/=?^_`{|}~A-Za-z0-9-]+)*@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*>\z/', $messageId)
        || !is_int($issuedAt) || !is_int($expiresAt) || $issuedAt < 1 || $issuedAt > $now
        || $expiresAt <= $now || $expiresAt - $issuedAt > ORIGINAL_REFERENCE_TTL) {
        return null;
    }

    return [
        'account' => $mailbox,
        'folder' => $folder,
        'uid' => $uid,
        'uidValidity' => $uidValidity,
        'messageId' => $messageId,
        'scope' => $action,
        'part' => $section,
    ];
}

/** Verify every detached signature before returning any child capability. */
function verifyOriginalShowHandoff(
    string $token,
    ?string $bundle,
    string $publicKey,
    string $audience,
    string $account,
    int $now,
    ?string $sourceSignature = null,
): ?array {
    if (($bundle !== null && (strlen($bundle) > 2671 || substr_count($bundle, '!') >= 16))
        || ($sourceSignature !== null && !preg_match('/\A[A-Za-z0-9_-]{86}\z/', $sourceSignature))) {
        return null;
    }
    $parent = verifyOriginalReference($token, $publicKey, $audience, $account, 'show', null, $now);
    if ($parent === null) {
        return null;
    }
    $encoded = explode('.', $token)[1];
    $json = sodium_base642bin($encoded, SODIUM_BASE64_VARIANT_URLSAFE_NO_PADDING);
    // The signed v1 tuple has already been verified. Preserve its original identity bytes.
    if (!preg_match('/,"show",null,([1-9][0-9]*,[1-9][0-9]*\])\z/', $json, $suffix, PREG_OFFSET_CAPTURE)) {
        return null;
    }
    $prefix = substr($json, 0, $suffix[0][1]);
    $reference_for = static function (string $scope, ?string $part, string $signature) use (
        $prefix, $suffix, $publicKey, $audience, $account, $now, $parent,
    ): ?string {
        $child = $prefix . ',"' . $scope . '",' . ($part === null ? 'null' : '"' . $part . '"') . ',' . $suffix[1][0];
        $reference = ORIGINAL_REFERENCE_VERSION . '.'
            . sodium_bin2base64($child, SODIUM_BASE64_VARIANT_URLSAFE_NO_PADDING) . '.' . $signature;
        return verifyOriginalReference($reference, $publicKey, $audience, $account, $scope, $part, $now)
            === array_replace($parent, ['scope' => $scope, 'part' => $part]) ? $reference : null;
    };
    $source = $sourceSignature === null ? null : $reference_for('source', null, $sourceSignature);
    if ($sourceSignature !== null && $source === null) {
        return null;
    }
    $parts = [];
    foreach ($bundle === null ? [] : explode('!', $bundle) as $entry) {
        if (!preg_match('/\A(' . ORIGINAL_MIME_PART . ')~([A-Za-z0-9_-]{86})\z/', $entry, $matches)) {
            return null;
        }
        [, $part, $signature] = $matches;
        if (isset($parts[$part])) {
            return null;
        }
        $reference = $reference_for('attachment', $part, $signature);
        if ($reference === null) {
            return null;
        }
        $parts[$part] = $reference;
    }
    return ['reference' => $parent, 'parts' => $parts, 'source' => $source];
}
