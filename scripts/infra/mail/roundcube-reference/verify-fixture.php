<?php
declare(strict_types=1);

require __DIR__ . '/verify.php';

$input = json_decode(stream_get_contents(STDIN), true, 8, JSON_THROW_ON_ERROR);
$key = base64_decode($input['key'], true);
$results = [];
foreach ($input['cases'] as $case) {
    $results[] = \Quantself\Mail\verifyOriginalReference(
        $case['token'],
        $key,
        $case['audience'],
        $case['account'],
        $case['scope'],
        $case['part'],
        $case['now'],
    );
}
$bundles = [];
foreach ($input['bundles'] as $case) {
    $result = \Quantself\Mail\verifyOriginalShowHandoff(
        $case['token'], $case['bundle'] ?? null, $key, $case['audience'], $case['account'], $case['now'],
        $case['sourceSignature'] ?? null,
    );
    $bundles[] = $result === null ? null : ['parts' => (object) $result['parts'], 'source' => $result['source']];
}
echo json_encode(['references' => $results, 'bundles' => $bundles], JSON_THROW_ON_ERROR);
