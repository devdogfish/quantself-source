<?php
declare(strict_types=1);

const PRIOR = '/native-runtime/roundcube.sqlite';
const CANDIDATE = '/candidate-runtime/roundcube.sqlite';

function runtime(string $path): PDO
{
    if (!is_file($path)) {
        throw new RuntimeException('Missing fixture SQLite runtime');
    }
    return new PDO('sqlite:' . $path, options: [PDO::ATTR_TIMEOUT => 5]);
}

function witness(PDO $db, string $session): array
{
    $user = $db->query('SELECT users.last_login, identities.identity_id, identities.name AS identity_name
        FROM users JOIN identities ON identities.user_id = users.user_id
        WHERE identities.standard = 1 AND identities.del = 0')->fetch(PDO::FETCH_ASSOC);
    $row = $db->prepare('SELECT 1 FROM session WHERE sess_id = ?');
    $row->execute([$session]);
    return ['session' => $session, 'present' => (bool) $row->fetchColumn()] + $user;
}

switch ($argv[1]) {
    case 'witness':
        $session = trim(stream_get_contents(STDIN));
        $db = runtime(PRIOR);
        $db->exec("UPDATE identities SET name = 'Fixture late display name' WHERE standard = 1 AND del = 0");
        $late = witness($db, $session);
        $early = witness(runtime(CANDIDATE), $session);
        if (!$late['present'] || $early['present'] || $late['last_login'] <= $early['last_login']
            || $late['identity_name'] !== 'Fixture late display name' || $early['identity_name'] === $late['identity_name']) {
            throw new RuntimeException('Expected the earlier clone to miss the late login, settings and session');
        }
        echo json_encode($late, JSON_THROW_ON_ERROR);
        break;
    case 'final':
        $pending = CANDIDATE . '.cutover';
        runtime(PRIOR)->exec('VACUUM INTO ' . "'" . $pending . "'");
        foreach (['-wal', '-shm', '-journal'] as $suffix) {
            $sidecar = CANDIDATE . $suffix;
            if (file_exists($sidecar) && !unlink($sidecar)) {
                throw new RuntimeException('Failed to remove the stopped candidate SQLite sidecar');
            }
        }
        if (!rename($pending, CANDIDATE)) {
            throw new RuntimeException('Failed to replace the stopped candidate SQLite database');
        }
        break;
    case 'prior':
    case 'candidate':
        $expected = json_decode(stream_get_contents(STDIN), true, flags: JSON_THROW_ON_ERROR);
        $path = $argv[1] === 'prior' ? PRIOR : CANDIDATE;
        $actual = witness(runtime($path), $expected['session']);
        if ($actual !== $expected) {
            $changed = implode(', ', array_keys(array_diff_assoc($expected, $actual)));
            throw new RuntimeException("SQLite runtime did not preserve the late writes: $changed");
        }
        break;
    case 'candidate-only-schema':
        // Model a migration with state that the prior schema cannot represent.
        $db = runtime(CANDIDATE);
        $db->beginTransaction();
        $db->exec('CREATE TABLE fixture_candidate_identity_change (identity_id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
        $db->exec("CREATE TRIGGER fixture_candidate_identity_update AFTER UPDATE OF name ON identities
            WHEN NEW.name = 'Fixture promoted display name'
            BEGIN
                INSERT INTO fixture_candidate_identity_change (identity_id, name) VALUES (NEW.identity_id, NEW.name);
            END");
        $db->commit();
        break;
    case 'retained':
        $expected = json_decode(stream_get_contents(STDIN), true, flags: JSON_THROW_ON_ERROR);
        $prior = runtime(PRIOR);
        $candidate = runtime(CANDIDATE);
        if (witness($prior, $expected['session']) !== $expected
            || $prior->query("SELECT 1 FROM sqlite_schema WHERE name = 'fixture_candidate_identity_change'")->fetchColumn()) {
            throw new RuntimeException('Prior runtime no longer matches the pre-promotion witness');
        }
        $expected['identity_name'] = 'Fixture promoted display name';
        $changes = $candidate->query('SELECT identity_id, name FROM fixture_candidate_identity_change')->fetchAll(PDO::FETCH_ASSOC);
        if ($changes !== [['identity_id' => $expected['identity_id'], 'name' => $expected['identity_name']]]
            || witness($candidate, $expected['session']) !== $expected) {
            throw new RuntimeException('Candidate runtime lost the accepted post-promotion write or session');
        }
        break;
    default:
        exit(2);
}
