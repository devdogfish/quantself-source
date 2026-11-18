<?php
// Runs three upstream classes with synthetic session, storage, and output seams.
declare(strict_types=1);

trait rcube_uploads {}

class rcube
{
    public static rcmail $fixture;
    public $plugins;
    public $config;

    public static function get_instance($mode = 0, $env = '') { return self::$fixture; }
    public function set_user($user) {}
    public function session_init() {}
    public function shutdown() {}
    public function url($p, $absolute = false, $full = false, $secure = false) { return '/fixture'; }
    public static function raise_error($error, $log = false, $exit = false) { throw new Denied('csrf'); }
}

class rcube_utils
{
    public const INPUT_POST = 1;
}

class rcube_mime
{
    public function __construct($charset) {}
    public static function decode_address_list($from, $max) { return []; }
}

const RCUBE_INSTALL_PATH = '/fixture/';
require $argv[1] . '/rcmail.php';
require $argv[1] . '/rcube_plugin_api.php';
require $argv[1] . '/rcube_message.php';

class Denied extends RuntimeException {}
class Rendered extends RuntimeException {}

class ProbePlugins extends rcube_plugin_api
{
    // No plugin directory or autoloading. Hook registration and execution are upstream.
    public function __construct() {}
}

class ProbeMail extends rcmail
{
    public array $trace = [];
    public int $epoch = 120;
    public string $id = 'reply@example.test';

    public function __construct(public string $scenario)
    {
        self::$fixture = $this;
        $this->task = 'mail';
        $this->action = 'show';
        $this->plugins = new ProbePlugins();
        $this->config = new class {
            public function get($key, $default = null) { return $default; }
        };
        $this->output = new class {
            public function send($task)
            {
                rcube::$fixture->trace[] = 'render';
                throw new Rendered($task);
            }
        };
    }

    // The CLI test retains the mail task. Upstream maps CLI requests to the cli task.
    public function set_task($task) { $this->task = $task; }
    public function check_request($mode)
    {
        $this->trace[] = 'request-check';
        return $this->scenario !== 'csrf';
    }

    public function url($p, $absolute = false, $full = false, $secure = false) { return '/fixture'; }
    public function get_storage() { return $this; }
    public function set_folder($folder) {}
    public function set_options($options) {}
    public function get_message($uid)
    {
        $this->trace[] = 'get-message';
        if ($this->scenario === 'missing-message') {
            return null;
        }
        if ($this->scenario === 'epoch-during-fetch') {
            $this->epoch++;
        }

        return new class($this->id) {
            public string $charset = 'UTF-8';
            public string $from = 'sender@example.test';
            public function __construct(private string $id) {}
            public function get($name, $decode = true) { return $name === 'message-id' ? $this->id : 'Synthetic reply'; }
        };
    }

    public function get_body($uid)
    {
        $this->trace[] = 'get-body';
        return 'Synthetic body';
    }
}

class rcmail_action_mail_index
{
    public static array $aliases = [];
    public function run() { rcube::$fixture->trace[] = 'mail-index'; }
}

class rcmail_action_mail_show
{
    public function checks() { return true; }
    public function run($args)
    {
        $mail = rcube::$fixture;
        $mail->trace[] = 'show';
        $message = new rcube_message('42', 'INBOX');
        if (!$message->headers) {
            throw new Denied('missing');
        }
        $mail->output->send('mail');
    }
}

$allowed = ['request-check', 'ready', 'mail-index', 'show', 'get-message', 'get-body', 'message-load'];
$cases = [
    'matching' => ['rendered', [...$allowed, 'render']],
    'csrf' => ['csrf', ['request-check']],
    'wrong-account' => ['ready', ['request-check', 'ready']],
    'stale-before-fetch' => ['ready', ['request-check', 'ready']],
    'ready-abort-only' => ['rendered', [...$allowed, 'render']],
    'message-load-abort-only' => ['rendered', [...$allowed, 'render']],
    'missing-message' => ['missing', ['request-check', 'ready', 'mail-index', 'show', 'get-message']],
    'epoch-during-fetch' => ['message-load', $allowed],
    'wrong-fetched-id' => ['message-load', $allowed],
];

printf("PHP %s\n", PHP_VERSION);
foreach ($cases as $scenario => $expected) {
    $_SESSION = [
        'username' => $scenario === 'wrong-account' ? 'other@example.test' : 'jobs@example.test',
    ];
    $mail = new ProbeMail($scenario);
    if ($scenario === 'stale-before-fetch') {
        $mail->epoch++;
    }
    if ($scenario === 'wrong-fetched-id') {
        $mail->id = 'unrelated@example.test';
    }

    $mail->plugins->register_hook('ready', function ($args) use ($mail, $scenario) {
        $mail->trace[] = 'ready';
        if ($scenario === 'ready-abort-only') {
            return ['abort' => true];
        }
        if ($_SESSION['username'] !== 'jobs@example.test' || $mail->epoch !== 120) {
            throw new Denied('ready');
        }
        return $args;
    });

    $mail->plugins->register_hook('message_load', function ($args) use ($mail, $scenario) {
        $mail->trace[] = 'message-load';
        if ($scenario === 'message-load-abort-only') {
            return ['abort' => true];
        }
        if ($mail->epoch !== 120 || $args['object']->get_header('message-id', true) !== 'reply@example.test') {
            throw new Denied('message-load');
        }
    });

    try {
        $mail->action_handler();
        throw new LogicException('Dispatcher returned without a fixture outcome');
    } catch (Rendered) {
        $observed = ['rendered', $mail->trace];
    } catch (Denied $denial) {
        $observed = [$denial->getMessage(), $mail->trace];
    }
    if ($observed !== $expected) {
        throw new LogicException("$scenario: " . json_encode($observed, JSON_THROW_ON_ERROR));
    }
    printf("PASS %s: %s (%s)\n", $scenario, $observed[0], implode(' > ', $observed[1]));
}
