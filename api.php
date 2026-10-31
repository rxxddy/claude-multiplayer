<?php

/**
 * Claude Multiplayer community server.
 *
 * One deployment = one community: a single PHP file plus an SQLite database that is created
 * automatically in ../private_cyberdeck/ (outside the web root). Protocol: docs/API.md.
 *
 * Quick setup: edit the three constants below and upload the file. They are re-applied whenever
 * they change; edits made later by the owner in the app are kept until you change them here again.
 * Environment variables take precedence over the constants:
 *
 *   DECK_SERVER_NAME   community name
 *   DECK_JOIN_KEY      secret required to register ('' = anyone with the address can join)
 *   DECK_SETUP_TOKEN   required for the first registration, which becomes the owner
 *   DECK_SECRET        64 hex chars; otherwise a random key file is created next to the database
 *   ANTHROPIC_API_KEY  fallback key for the @claude bot when the owner has not set one
 *
 * CLI helpers used by the test suite: `php api.php perft <depth> "<fen>"`, `php api.php case_ev`.
 */

declare(strict_types=1);

namespace ClaudeDeck\Backend;

use DateTimeImmutable;
use DateTimeZone;
use PDO;
use PDOException;
use Throwable;

const SERVER_NAME = 'Claude Multiplayer';
const JOIN_KEY    = '';
const SETUP_TOKEN = '';

// The Friday 16:30 showdown is defined in Italian time, independent of the host's locale.
date_default_timezone_set('Europe/Rome');

// Any origin may call, but only via POST and never with cookies: the session token travels in a header.
if (PHP_SAPI !== 'cli') {
    header_remove('X-Powered-By');
    header('Access-Control-Allow-Origin: *');
    header('Access-Control-Allow-Methods: POST, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type, X-Deck-Token');
    header('Access-Control-Max-Age: 86400');
    header('Content-Type: application/json; charset=utf-8');
    header('X-Content-Type-Options: nosniff');
    header('X-Frame-Options: DENY');
    header('Referrer-Policy: no-referrer');
    header("Content-Security-Policy: default-src 'none'; frame-ancestors 'none'");
    header('Cache-Control: no-store');

    $method = $_SERVER['REQUEST_METHOD'] ?? '';
    if ($method === 'OPTIONS') {
        http_response_code(204);
        exit;
    }
    if ($method !== 'POST') {
        http_response_code(405);
        header('Allow: POST, OPTIONS');
        echo json_encode(['ok' => false, 'error_code' => 'METHOD_NOT_ALLOWED', 'error' => 'Use POST.']);
        exit;
    }
}

final class ApiException extends \RuntimeException
{
    public function __construct(
        string $message,
        public readonly int $httpStatus = 400,
        public readonly string $errorCode = 'BAD_REQUEST'
    ) {
        parent::__construct($message);
    }
}

final class Config
{
    public const API_VERSION = '3';
    public const ROOM = 'MAIN';
    public const MAX_BODY = 65536;
    public const ONLINE_WINDOW = 22;
    public const AVATAR_PRESETS = ['CLAUDE_CRAB', 'CLAUDE_GHOST', 'CLAUDE_BOT', 'CLAUDE_CAT'];

    /** Used when the owner has not stored a key in the server settings. */
    public static function anthropicKey(): string
    {
        return (string)(getenv('ANTHROPIC_API_KEY') ?: '');
    }

    public static function resolveStorageDir(): string
    {
        // Prefer a folder next to the web root; shared hosts with a strict open_basedir may refuse it.
        $parentDir = dirname(__DIR__) . DIRECTORY_SEPARATOR . 'private_cyberdeck';
        if (@is_dir($parentDir) || @mkdir($parentDir, 0750, true)) {
            if (@is_writable($parentDir)) {
                return $parentDir;
            }
        }

        // Otherwise keep the data next to api.php, behind deny-all rules.
        $localVault = __DIR__ . DIRECTORY_SEPARATOR . '.ht_cyberdeck_vault';
        if (!is_dir($localVault)) {
            mkdir($localVault, 0750, true);
        }

        $htaccess = $localVault . DIRECTORY_SEPARATOR . '.htaccess';
        if (!file_exists($htaccess)) {
            file_put_contents($htaccess, "Require all denied\nDeny from all\n");
        }

        $index = $localVault . DIRECTORY_SEPARATOR . 'index.html';
        if (!file_exists($index)) {
            file_put_contents($index, '');
        }

        return $localVault;
    }

    /** 32-byte server secret: env DECK_SECRET, else a random key file next to the DB (created 0600). */
    public static function serverSecret(): string
    {
        static $secret = null;
        if ($secret !== null) {
            return $secret;
        }
        $env = (string)(getenv('DECK_SECRET') ?: '');
        if ($env !== '') {
            return $secret = hash('sha256', $env, true);
        }
        $file = self::resolveStorageDir() . DIRECTORY_SEPARATOR . 'deck_secret.key';
        if (!is_file($file)) {
            $old = umask(0077);
            $fh = @fopen($file, 'x');
            if ($fh !== false) {
                fwrite($fh, bin2hex(random_bytes(32)));
                fclose($fh);
            }
            umask($old);
            @chmod($file, 0600);
        }
        $raw = trim((string)@file_get_contents($file));
        if (strlen($raw) !== 64 || !ctype_xdigit($raw)) {
            throw new \RuntimeException('Server secret file unreadable.');
        }
        return $secret = hex2bin($raw);
    }
}

final class Crypto
{
    public static function encrypt(string $plain): string
    {
        if (!function_exists('sodium_crypto_secretbox')) {
            throw new ApiException('Server is missing the sodium extension.', 500, 'NO_SODIUM');
        }
        $nonce = random_bytes(SODIUM_CRYPTO_SECRETBOX_NONCEBYTES);
        return 'v1:' . base64_encode($nonce . sodium_crypto_secretbox($plain, $nonce, Config::serverSecret()));
    }

    public static function decrypt(string $enc): string
    {
        if (!str_starts_with($enc, 'v1:') || !function_exists('sodium_crypto_secretbox_open')) {
            return '';
        }
        $raw = base64_decode(substr($enc, 3), true);
        if ($raw === false || strlen($raw) <= SODIUM_CRYPTO_SECRETBOX_NONCEBYTES) {
            return '';
        }
        $nonce = substr($raw, 0, SODIUM_CRYPTO_SECRETBOX_NONCEBYTES);
        $plain = sodium_crypto_secretbox_open(substr($raw, SODIUM_CRYPTO_SECRETBOX_NONCEBYTES), $nonce, Config::serverSecret());
        return $plain === false ? '' : $plain;
    }

    public static function mask(string $key): string
    {
        return strlen($key) > 14 ? substr($key, 0, 7) . '...' . substr($key, -4) : '';
    }
}

final class Storage
{
    private static ?PDO $pdo = null;

    public static function db(): PDO
    {
        if (self::$pdo !== null) {
            return self::$pdo;
        }

        $dbPath = Config::resolveStorageDir() . DIRECTORY_SEPARATOR . 'deck_state_v2.sqlite';
        $pdo = new PDO('sqlite:' . $dbPath, null, null, [
            PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES   => false,
        ]);

        // Prevent SQLITE_BUSY under concurrent polling from multiple clients
        $pdo->exec('PRAGMA journal_mode = WAL;');
        $pdo->exec('PRAGMA synchronous = NORMAL;');
        $pdo->exec('PRAGMA busy_timeout = 5000;');
        $pdo->exec('PRAGMA foreign_keys = ON;');

        self::migrate($pdo);
        self::migrateV3($pdo);
        self::migrateV4($pdo);
        self::migrateV5($pdo);
        self::migrateV6($pdo);
        self::migrateV7($pdo);
        self::migrateV8($pdo);
        self::migrateV9($pdo);
        self::applySiteConfig($pdo);
        self::$pdo = $pdo;

        return $pdo;
    }

    /** Applies SERVER_NAME / JOIN_KEY (or DECK_* env) whenever the configured values change. */
    private static function applySiteConfig(PDO $pdo): void
    {
        $name = trim((string)(getenv('DECK_SERVER_NAME') ?: SERVER_NAME));
        $key = (string)(getenv('DECK_JOIN_KEY') ?: JOIN_KEY);
        $sig = hash('sha256', $name . '|' . $key);
        $get = $pdo->prepare('SELECT v FROM server_meta WHERE k = ?');
        $get->execute(['site_config_sig']);
        $stored = (string)$get->fetchColumn();
        if ($stored === $sig) {
            return;
        }
        $set = $pdo->prepare('INSERT INTO server_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v');
        $owner = $pdo->query("SELECT v FROM server_meta WHERE k = 'owner_user_id'")->fetchColumn();
        if ($stored === '' && (int)$owner > 0) {
            // First run after an upgrade: keep what the owner already configured in the app.
            $set->execute(['site_config_sig', $sig]);
            return;
        }
        if ($name !== '') {
            $set->execute(['name', mb_substr($name, 0, 40)]);
        }
        $set->execute(['join_key_hash', $key === '' ? '' : Security::hashPassword($key)]);
        $set->execute(['site_config_sig', $sig]);
    }

    /** v8: drops the columns of an experimental GitHub commit source (present only on some dev databases). */
    private static function migrateV8(PDO $pdo): void
    {
        if ((int)$pdo->query('PRAGMA user_version;')->fetchColumn() >= 8) {
            return;
        }
        foreach (['commits_day_src', 'commits_week_src', 'github_login'] as $column) {
            try {
                $pdo->exec("ALTER TABLE room_members DROP COLUMN {$column}");
            } catch (PDOException) {
                // column was never added
            }
        }
        $pdo->exec('PRAGMA user_version = 8;');
    }

    /** v9: translation key + params for system messages (clients render them in their own language). */
    private static function migrateV9(PDO $pdo): void
    {
        if ((int)$pdo->query('PRAGMA user_version;')->fetchColumn() >= 9) {
            return;
        }
        try {
            $pdo->exec("ALTER TABLE messages ADD COLUMN i18n TEXT NOT NULL DEFAULT ''");
        } catch (PDOException) {
        }
        $pdo->exec('PRAGMA user_version = 9;');
    }

    private static function migrateV7(PDO $pdo): void
    {
        if ((int)$pdo->query('PRAGMA user_version;')->fetchColumn() >= 7) {
            return;
        }
        foreach ([
            "ALTER TABLE chess_games ADD COLUMN history TEXT NOT NULL DEFAULT '[]'",
            "ALTER TABLE commit_feed ADD COLUMN created_ts INTEGER NOT NULL DEFAULT 0",
        ] as $sql) {
            try { $pdo->exec($sql); } catch (PDOException) {}
        }
        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_commits_room_ts ON commit_feed(room_id, created_ts)');
        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_chess_status ON chess_games(status, updated_at)');
        $pdo->exec('PRAGMA user_version = 7;');
    }

    private static function migrateV6(PDO $pdo): void
    {
        if ((int)$pdo->query('PRAGMA user_version;')->fetchColumn() >= 6) {
            return;
        }
        $pdo->beginTransaction();
        try {
            foreach ([
                "ALTER TABLE room_members ADD COLUMN shares_usage INTEGER NOT NULL DEFAULT 0",
                "ALTER TABLE room_members ADD COLUMN shares_commits INTEGER NOT NULL DEFAULT 0",
                "ALTER TABLE room_members ADD COLUMN shares_focus INTEGER NOT NULL DEFAULT 0",
                "ALTER TABLE room_members ADD COLUMN usage_reset_w TEXT NOT NULL DEFAULT ''",
            ] as $sql) {
                try { $pdo->exec($sql); } catch (PDOException) {}
            }
            $pdo->exec("
                CREATE TABLE IF NOT EXISTS server_meta (
                    k TEXT PRIMARY KEY,
                    v TEXT NOT NULL DEFAULT ''
                );
                CREATE TABLE IF NOT EXISTS game_log (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    kind TEXT NOT NULL,
                    ts INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_game_log_user ON game_log(user_id, kind, ts);
                CREATE TABLE IF NOT EXISTS bs_games (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    a_id INTEGER NOT NULL,
                    b_id INTEGER NOT NULL,
                    stake INTEGER NOT NULL DEFAULT 0,
                    status TEXT NOT NULL DEFAULT 'INVITED',
                    turn_id INTEGER NOT NULL DEFAULT 0,
                    a_ships TEXT NOT NULL DEFAULT '',
                    b_ships TEXT NOT NULL DEFAULT '',
                    a_shots TEXT NOT NULL DEFAULT '[]',
                    b_shots TEXT NOT NULL DEFAULT '[]',
                    winner_id INTEGER NOT NULL DEFAULT 0,
                    created_ts INTEGER NOT NULL,
                    updated_ts INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_bs_a ON bs_games(a_id, status);
                CREATE INDEX IF NOT EXISTS idx_bs_b ON bs_games(b_id, status);
                CREATE INDEX IF NOT EXISTS idx_bs_status ON bs_games(status, updated_ts);
                CREATE INDEX IF NOT EXISTS idx_messages_room_id ON messages(room_id, id);
                CREATE INDEX IF NOT EXISTS idx_messages_room_ts ON messages(room_id, created_ts);
                CREATE INDEX IF NOT EXISTS idx_users_points ON users(points DESC);
                CREATE INDEX IF NOT EXISTS idx_members_room_seen ON room_members(room_id, banned, last_seen);

                CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
                    content, snippet_body, content='messages', content_rowid='id'
                );
                CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
                    INSERT INTO messages_fts(rowid, content, snippet_body) VALUES (new.id, new.content, new.snippet_body);
                END;
                CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
                    INSERT INTO messages_fts(messages_fts, rowid, content, snippet_body) VALUES ('delete', old.id, old.content, old.snippet_body);
                END;
                CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE ON messages BEGIN
                    INSERT INTO messages_fts(messages_fts, rowid, content, snippet_body) VALUES ('delete', old.id, old.content, old.snippet_body);
                    INSERT INTO messages_fts(rowid, content, snippet_body) VALUES (new.id, new.content, new.snippet_body);
                END;
            ");
            $pdo->exec("INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')");

            // One server = one community: fold the legacy TESTROOM (or the busiest room) into MAIN
            $now = time();
            $pdo->prepare("INSERT OR IGNORE INTO rooms (room_id, password_hash, burn_date, created_at, title) VALUES (?, '', ?, ?, 'Claude Multiplayer')")
                ->execute([Config::ROOM, date('Y-m-d'), $now]);
            $src = $pdo->query("SELECT r.* FROM rooms r WHERE r.room_id <> 'MAIN'
                ORDER BY (r.room_id = 'TESTROOM') DESC, (SELECT COUNT(*) FROM room_members rm WHERE rm.room_id = r.room_id) DESC LIMIT 1")->fetch();

            $meta = [
                'name' => 'Claude Multiplayer', 'motd' => '', 'owner_user_id' => '0', 'join_key_hash' => '',
                'settings' => '{}', 'anthropic_key_enc' => '', 'members_rev' => '1', 'online_sig' => '',
            ];
            if ($src) {
                $sid = (string)$src['room_id'];
                $pdo->prepare("
                    INSERT OR IGNORE INTO room_members (room_id, user_id, project, branch, task_it, status, ctx_pct, quota_pct,
                        commits_day, commits_week, trophies, last_seen, usage_s, usage_w, usage_reset, usage_ts, role, muted_until, banned, last_msg_ts)
                    SELECT 'MAIN', user_id, project, branch, task_it, status, ctx_pct, quota_pct,
                        commits_day, commits_week, trophies, last_seen, usage_s, usage_w, usage_reset, usage_ts, role, muted_until, banned, last_msg_ts
                    FROM room_members WHERE room_id = ?
                ")->execute([$sid]);
                foreach (['messages', 'chess_games', 'duels'] as $t) {
                    $pdo->prepare("UPDATE {$t} SET room_id = 'MAIN' WHERE room_id = ?")->execute([$sid]);
                }
                $pdo->prepare("UPDATE OR IGNORE commit_feed SET room_id = 'MAIN' WHERE room_id = ?")->execute([$sid]);
                $pdo->prepare('UPDATE rooms SET champion_user_id = ?, last_awarded_week = ? WHERE room_id = ?')
                    ->execute([(int)$src['champion_user_id'], (string)$src['last_awarded_week'], Config::ROOM]);

                $meta['name'] = (string)($src['title'] ?: 'Claude Multiplayer');
                $meta['motd'] = (string)$src['motd'];
                $meta['owner_user_id'] = (string)(int)$src['owner_id'];
                $legacy = json_decode((string)$src['settings'], true);
                if (is_array($legacy)) {
                    unset($legacy['locked']);
                    $meta['settings'] = json_encode($legacy);
                }
                $legacyKey = trim((string)$src['anthropic_key_enc']);
                if (str_starts_with($legacyKey, 'sk-ant-') && function_exists('sodium_crypto_secretbox')) {
                    $meta['anthropic_key_enc'] = Crypto::encrypt($legacyKey);
                }
            }
            // Never leave plaintext keys at rest
            $pdo->exec("UPDATE rooms SET anthropic_key_enc = ''");

            $owner = (int)$meta['owner_user_id'];
            if ($owner === 0 || !$pdo->query('SELECT 1 FROM users WHERE id = ' . $owner)->fetchColumn()) {
                $owner = (int)$pdo->query('SELECT COALESCE(MIN(id), 0) FROM users')->fetchColumn();
            }
            $meta['owner_user_id'] = (string)$owner;
            if ($owner > 0) {
                $pdo->prepare("INSERT OR IGNORE INTO room_members (room_id, user_id, last_seen) VALUES ('MAIN', ?, 0)")->execute([$owner]);
                $pdo->prepare("UPDATE room_members SET role = 'admin' WHERE room_id = 'MAIN' AND role = 'owner' AND user_id <> ?")->execute([$owner]);
                $pdo->prepare("UPDATE room_members SET role = 'owner', banned = 0 WHERE room_id = 'MAIN' AND user_id = ?")->execute([$owner]);
            }
            $pdo->prepare('UPDATE rooms SET owner_id = ?, title = ? WHERE room_id = ?')->execute([$owner, $meta['name'], Config::ROOM]);

            $ins = $pdo->prepare('INSERT OR IGNORE INTO server_meta (k, v) VALUES (?, ?)');
            foreach ($meta as $k => $v) {
                $ins->execute([$k, $v]);
            }
            $pdo->exec('PRAGMA user_version = 6;');
            $pdo->commit();
        } catch (Throwable $e) {
            $pdo->rollBack();
            throw $e;
        }
    }

    private static function migrateV5(PDO $pdo): void
    {
        if ((int)$pdo->query('PRAGMA user_version;')->fetchColumn() >= 5) {
            return;
        }
        foreach ([
            "ALTER TABLE rooms ADD COLUMN owner_id INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE rooms ADD COLUMN title TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE rooms ADD COLUMN motd TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE rooms ADD COLUMN settings TEXT NOT NULL DEFAULT '{}'",
            "ALTER TABLE room_members ADD COLUMN role TEXT NOT NULL DEFAULT 'member'",
            "ALTER TABLE room_members ADD COLUMN muted_until INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE room_members ADD COLUMN banned INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE room_members ADD COLUMN last_msg_ts INTEGER NOT NULL DEFAULT 0",
        ] as $sql) {
            try { $pdo->exec($sql); } catch (PDOException) {}
        }
        // Existing rooms: the first member becomes owner
        $pdo->exec("UPDATE rooms SET owner_id = (SELECT user_id FROM room_members rm WHERE rm.room_id = rooms.room_id ORDER BY rowid LIMIT 1) WHERE owner_id = 0");
        $pdo->exec("UPDATE room_members SET role = 'owner' WHERE EXISTS (SELECT 1 FROM rooms r WHERE r.room_id = room_members.room_id AND r.owner_id = room_members.user_id)");
        $pdo->exec('PRAGMA user_version = 5;');
    }

    private static function migrateV4(PDO $pdo): void
    {
        if ((int)$pdo->query('PRAGMA user_version;')->fetchColumn() >= 4) {
            return;
        }
        try { $pdo->exec('ALTER TABLE chess_games ADD COLUMN stake INTEGER NOT NULL DEFAULT 0'); } catch (PDOException) {}
        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_users_points ON users(points DESC)');
        $pdo->exec('PRAGMA user_version = 4;');
    }

    private static function migrateV3(PDO $pdo): void
    {
        if ((int)$pdo->query('PRAGMA user_version;')->fetchColumn() >= 3) {
            return;
        }
        foreach ([
            "ALTER TABLE users ADD COLUMN points INTEGER NOT NULL DEFAULT 1000",
            "ALTER TABLE users ADD COLUMN bio TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE users ADD COLUMN usage_hidden INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE room_members ADD COLUMN usage_s INTEGER NOT NULL DEFAULT -1",
            "ALTER TABLE room_members ADD COLUMN usage_w INTEGER NOT NULL DEFAULT -1",
            "ALTER TABLE room_members ADD COLUMN usage_reset TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE room_members ADD COLUMN usage_ts INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE messages ADD COLUMN reply_to INTEGER NOT NULL DEFAULT 0",
        ] as $sql) {
            try { $pdo->exec($sql); } catch (PDOException) { /* column already exists */ }
        }
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS duels (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                room_id TEXT NOT NULL,
                creator_id INTEGER NOT NULL,
                stake INTEGER NOT NULL,
                max_players INTEGER NOT NULL DEFAULT 2,
                players TEXT NOT NULL DEFAULT '[]',
                result TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'OPEN',
                created_ts INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_duels_room ON duels(room_id, status);
        ");
        $pdo->exec('PRAGMA user_version = 3;');
    }

    private static function migrate(PDO $pdo): void
    {
        $version = (int)$pdo->query('PRAGMA user_version;')->fetchColumn();
        if ($version >= 2) {
            return;
        }

        $pdo->exec("
            CREATE TABLE IF NOT EXISTS rate_limits (
                ip_hash TEXT NOT NULL,
                bucket TEXT NOT NULL,
                hits INTEGER NOT NULL DEFAULT 1,
                reset_at INTEGER NOT NULL,
                PRIMARY KEY (ip_hash, bucket)
            );

            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL UNIQUE COLLATE NOCASE,
                password_hash TEXT NOT NULL,
                display_nick TEXT NOT NULL UNIQUE COLLATE NOCASE,
                avatar_preset TEXT NOT NULL DEFAULT 'CLAUDE_CRAB',
                avatar_color TEXT NOT NULL DEFAULT '#D97757',
                custom_svg TEXT NOT NULL DEFAULT '',
                elo INTEGER NOT NULL DEFAULT 1200,
                token_sha256 TEXT UNIQUE,
                created_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS rooms (
                room_id TEXT PRIMARY KEY,
                password_hash TEXT NOT NULL,
                anthropic_key_enc TEXT NOT NULL DEFAULT '',
                champion_user_id INTEGER NOT NULL DEFAULT 0,
                last_awarded_week TEXT NOT NULL DEFAULT '',
                api_tokens_rem INTEGER NOT NULL DEFAULT 80000,
                api_tokens_limit INTEGER NOT NULL DEFAULT 80000,
                api_reqs_rem INTEGER NOT NULL DEFAULT 100,
                api_reqs_limit INTEGER NOT NULL DEFAULT 100,
                tokens_burned_today INTEGER NOT NULL DEFAULT 0,
                burn_date TEXT NOT NULL DEFAULT '',
                created_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS room_members (
                room_id TEXT NOT NULL,
                user_id INTEGER NOT NULL,
                project TEXT NOT NULL DEFAULT 'workspace',
                branch TEXT NOT NULL DEFAULT 'main',
                task_it TEXT NOT NULL DEFAULT 'In attesa di attività',
                status TEXT NOT NULL DEFAULT 'IDLE',
                ctx_pct INTEGER NOT NULL DEFAULT 0,
                quota_pct INTEGER NOT NULL DEFAULT 0,
                commits_day INTEGER NOT NULL DEFAULT 0,
                commits_week INTEGER NOT NULL DEFAULT 0,
                trophies INTEGER NOT NULL DEFAULT 0,
                last_seen INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (room_id, user_id),
                FOREIGN KEY (room_id) REFERENCES rooms(room_id) ON DELETE CASCADE,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                room_id TEXT NOT NULL,
                user_id INTEGER NOT NULL DEFAULT 0,
                sender_nick TEXT NOT NULL,
                sender_elo INTEGER NOT NULL DEFAULT 1200,
                avatar_preset TEXT NOT NULL DEFAULT 'CLAUDE_CRAB',
                avatar_color TEXT NOT NULL DEFAULT '#D97757',
                custom_svg TEXT NOT NULL DEFAULT '',
                is_champion INTEGER NOT NULL DEFAULT 0,
                msg_type TEXT NOT NULL DEFAULT 'CHAT',
                content TEXT NOT NULL,
                snippet_body TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                created_ts INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_messages_room_id ON messages(room_id, id);

            CREATE TABLE IF NOT EXISTS commit_feed (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                room_id TEXT NOT NULL,
                user_id INTEGER NOT NULL,
                handle TEXT NOT NULL,
                project TEXT NOT NULL,
                branch TEXT NOT NULL,
                short_hash TEXT NOT NULL,
                message TEXT NOT NULL,
                created_at TEXT NOT NULL,
                UNIQUE(room_id, short_hash)
            );
            CREATE INDEX IF NOT EXISTS idx_commits_room ON commit_feed(room_id, id DESC);

            CREATE TABLE IF NOT EXISTS chess_games (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                room_id TEXT NOT NULL,
                white_user_id INTEGER NOT NULL,
                black_user_id INTEGER NOT NULL,
                status TEXT NOT NULL DEFAULT 'INVITED',
                fen TEXT NOT NULL DEFAULT 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
                last_move TEXT NOT NULL DEFAULT '',
                winner_user_id INTEGER NOT NULL DEFAULT 0,
                updated_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_chess_room ON chess_games(room_id, status);
        ");

        $pdo->exec('PRAGMA user_version = 2;');
    }
}

final class Security
{
    /** Fixed-window limiter. $subject defaults to the client IP; pass e.g. 'u:42' for per-user buckets. */
    public static function enforceRateLimit(PDO $pdo, string $bucket, int $maxHits, int $windowSec, ?string $subject = null): void
    {
        $subject ??= 'ip:' . ($_SERVER['REMOTE_ADDR'] ?? '0.0.0.0');
        $ipHash = hash_hmac('sha256', $subject, Config::serverSecret());
        $now = time();

        // Opportunistic cleanup (~2% probability) to keep table tiny without cron
        if (random_int(1, 50) === 1) {
            $pdo->prepare('DELETE FROM rate_limits WHERE reset_at < ?')->execute([$now]);
        }

        $stmt = $pdo->prepare('SELECT hits, reset_at FROM rate_limits WHERE ip_hash = ? AND bucket = ?');
        $stmt->execute([$ipHash, $bucket]);
        $row = $stmt->fetch();

        if (!$row || (int)$row['reset_at'] <= $now) {
            $pdo->prepare('
                INSERT INTO rate_limits (ip_hash, bucket, hits, reset_at)
                VALUES (?, ?, 1, ?)
                ON CONFLICT(ip_hash, bucket) DO UPDATE SET hits = 1, reset_at = excluded.reset_at
            ')->execute([$ipHash, $bucket, $now + $windowSec]);
            return;
        }

        if ((int)$row['hits'] >= $maxHits) {
            throw new ApiException('Rate limit exceeded. Try again shortly.', 429, 'RATE_LIMITED');
        }

        $pdo->prepare('UPDATE rate_limits SET hits = hits + 1 WHERE ip_hash = ? AND bucket = ?')
            ->execute([$ipHash, $bucket]);
    }

    public static function hashPassword(string $plain): string
    {
        $algo = defined('PASSWORD_ARGON2ID') ? PASSWORD_ARGON2ID : PASSWORD_BCRYPT;
        return password_hash($plain, $algo);
    }

    public static function sanitizeColor(string $hex): string
    {
        return preg_match('/^#[0-9A-Fa-f]{6}$/', $hex) ? strtoupper($hex) : '#D97757';
    }

    public static function text(mixed $v, int $max): string
    {
        $s = is_scalar($v) ? trim((string)$v) : '';
        $s = (string)preg_replace('/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/u', '', $s);
        return mb_substr($s, 0, $max);
    }
}

/**
 * Compact chess rules engine. Squares are 0..63 (a1 = 0, h8 = 63), pieces are FEN letters, '' = empty.
 * A move is [from, to, promotion('' | q r b n)].
 */
final class Chess
{
    public const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    private const KNIGHT = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
    private const KING = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
    private const DIAG = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
    private const ORTH = [[1, 0], [-1, 0], [0, 1], [0, -1]];

    public static function parse(string $fen): array
    {
        $p = explode(' ', trim($fen));
        $rows = explode('/', $p[0] ?? '');
        if (count($p) !== 6 || count($rows) !== 8 || !in_array($p[1], ['w', 'b'], true) || !preg_match('/^(-|K?Q?k?q?)$/', $p[2])) {
            throw new ApiException('Invalid FEN.', 400, 'INVALID_FEN');
        }
        $b = array_fill(0, 64, '');
        foreach ($rows as $i => $row) {
            $f = 0;
            foreach (str_split($row) as $ch) {
                if ($ch >= '1' && $ch <= '8') {
                    $f += (int)$ch;
                } elseif (str_contains('pnbrqkPNBRQK', $ch) && $f < 8) {
                    $b[(7 - $i) * 8 + $f++] = $ch;
                } else {
                    throw new ApiException('Invalid FEN.', 400, 'INVALID_FEN');
                }
            }
            if ($f !== 8) {
                throw new ApiException('Invalid FEN.', 400, 'INVALID_FEN');
            }
        }
        $counts = array_count_values(array_filter($b));
        if (($counts['K'] ?? 0) !== 1 || ($counts['k'] ?? 0) !== 1) {
            throw new ApiException('Invalid FEN.', 400, 'INVALID_FEN');
        }
        return [
            'b' => $b, 'turn' => $p[1], 'castle' => $p[2] === '-' ? '' : $p[2],
            'ep' => $p[3] === '-' ? -1 : self::sq($p[3]), 'half' => max(0, (int)$p[4]), 'full' => max(1, (int)$p[5]),
        ];
    }

    public static function sq(string $s): int
    {
        return preg_match('/^[a-h][1-8]$/', $s) ? (ord($s[1]) - 49) * 8 + ord($s[0]) - 97 : -1;
    }

    public static function name(int $sq): string
    {
        return chr(97 + $sq % 8) . chr(49 + intdiv($sq, 8));
    }

    public static function fen(array $p): string
    {
        $rows = [];
        for ($r = 7; $r >= 0; $r--) {
            $row = '';
            $e = 0;
            for ($f = 0; $f < 8; $f++) {
                $c = $p['b'][$r * 8 + $f];
                if ($c === '') {
                    $e++;
                    continue;
                }
                $row .= ($e ?: '') . $c;
                $e = 0;
            }
            $rows[] = $row . ($e ?: '');
        }
        return implode('/', $rows) . ' ' . $p['turn'] . ' ' . ($p['castle'] ?: '-') . ' '
            . ($p['ep'] < 0 ? '-' : self::name($p['ep'])) . ' ' . $p['half'] . ' ' . $p['full'];
    }

    /** Position identity for repetition detection (board, side, castling, ep). */
    public static function key(array $p): string
    {
        return implode(' ', array_slice(explode(' ', self::fen($p)), 0, 4));
    }

    private static function own(string $c, string $side): bool
    {
        return $c !== '' && (ctype_upper($c) === ($side === 'w'));
    }

    public static function attacked(array $b, int $sq, string $by): bool
    {
        $f = $sq % 8;
        $r = intdiv($sq, 8);
        $w = $by === 'w';
        $at = static fn(int $ff, int $rr): string => ($ff >= 0 && $ff < 8 && $rr >= 0 && $rr < 8) ? $b[$rr * 8 + $ff] : '#';

        $pr = $w ? $r - 1 : $r + 1;
        if ($at($f - 1, $pr) === ($w ? 'P' : 'p') || $at($f + 1, $pr) === ($w ? 'P' : 'p')) {
            return true;
        }
        foreach ([[self::KNIGHT, $w ? 'N' : 'n'], [self::KING, $w ? 'K' : 'k']] as [$offs, $pc]) {
            foreach ($offs as [$df, $dr]) {
                if ($at($f + $df, $r + $dr) === $pc) {
                    return true;
                }
            }
        }
        foreach ([[self::DIAG, $w ? 'BQ' : 'bq'], [self::ORTH, $w ? 'RQ' : 'rq']] as [$dirs, $pcs]) {
            foreach ($dirs as [$df, $dr]) {
                for ($i = 1; ; $i++) {
                    $c = $at($f + $df * $i, $r + $dr * $i);
                    if ($c === '') {
                        continue;
                    }
                    if (str_contains($pcs, $c)) {
                        return true;
                    }
                    break;
                }
            }
        }
        return false;
    }

    private static function kingSq(array $b, string $side): int
    {
        return (int)array_search($side === 'w' ? 'K' : 'k', $b, true);
    }

    public static function inCheck(array $p): bool
    {
        return self::attacked($p['b'], self::kingSq($p['b'], $p['turn']), $p['turn'] === 'w' ? 'b' : 'w');
    }

    private static function pseudo(array $p): array
    {
        $b = $p['b'];
        $s = $p['turn'];
        $opp = $s === 'w' ? 'b' : 'w';
        $moves = [];
        for ($sq = 0; $sq < 64; $sq++) {
            $c = $b[$sq];
            if (!self::own($c, $s)) {
                continue;
            }
            $f = $sq % 8;
            $r = intdiv($sq, 8);
            $t = strtolower($c);
            if ($t === 'p') {
                $dir = $s === 'w' ? 1 : -1;
                $nr = $r + $dir;
                $promo = $nr === ($s === 'w' ? 7 : 0);
                $add = function (int $to) use (&$moves, $sq, $promo): void {
                    foreach ($promo ? ['q', 'r', 'b', 'n'] : [''] as $pr) {
                        $moves[] = [$sq, $to, $pr];
                    }
                };
                $one = $nr * 8 + $f;
                if ($b[$one] === '') {
                    $add($one);
                    if ($r === ($s === 'w' ? 1 : 6) && $b[$one + 8 * $dir] === '') {
                        $moves[] = [$sq, $one + 8 * $dir, ''];
                    }
                }
                foreach ([-1, 1] as $df) {
                    $nf = $f + $df;
                    if ($nf >= 0 && $nf < 8 && (self::own($b[$nr * 8 + $nf], $opp) || $nr * 8 + $nf === $p['ep'])) {
                        $add($nr * 8 + $nf);
                    }
                }
                continue;
            }
            if ($t === 'n' || $t === 'k') {
                foreach ($t === 'n' ? self::KNIGHT : self::KING as [$df, $dr]) {
                    $nf = $f + $df;
                    $nr = $r + $dr;
                    if ($nf >= 0 && $nf < 8 && $nr >= 0 && $nr < 8 && !self::own($b[$nr * 8 + $nf], $s)) {
                        $moves[] = [$sq, $nr * 8 + $nf, ''];
                    }
                }
            } else {
                $dirs = $t === 'b' ? self::DIAG : ($t === 'r' ? self::ORTH : [...self::DIAG, ...self::ORTH]);
                foreach ($dirs as [$df, $dr]) {
                    for ($nf = $f + $df, $nr = $r + $dr; $nf >= 0 && $nf < 8 && $nr >= 0 && $nr < 8; $nf += $df, $nr += $dr) {
                        $to = $nr * 8 + $nf;
                        if (self::own($b[$to], $s)) {
                            break;
                        }
                        $moves[] = [$sq, $to, ''];
                        if ($b[$to] !== '') {
                            break;
                        }
                    }
                }
            }
            $home = $s === 'w' ? 0 : 56;
            if ($t === 'k' && $sq === $home + 4 && !self::attacked($b, $sq, $opp)) {
                $rook = $s === 'w' ? 'R' : 'r';
                if (str_contains($p['castle'], $s === 'w' ? 'K' : 'k') && $b[$home + 5] === '' && $b[$home + 6] === '' && $b[$home + 7] === $rook
                    && !self::attacked($b, $home + 5, $opp) && !self::attacked($b, $home + 6, $opp)) {
                    $moves[] = [$sq, $home + 6, ''];
                }
                if (str_contains($p['castle'], $s === 'w' ? 'Q' : 'q') && $b[$home + 1] === '' && $b[$home + 2] === '' && $b[$home + 3] === '' && $b[$home] === $rook
                    && !self::attacked($b, $home + 3, $opp) && !self::attacked($b, $home + 2, $opp)) {
                    $moves[] = [$sq, $home + 2, ''];
                }
            }
        }
        return $moves;
    }

    public static function make(array $p, array $m): array
    {
        [$from, $to, $promo] = $m;
        $b = $p['b'];
        $c = $b[$from];
        $s = $p['turn'];
        $t = strtolower($c);
        $capture = $b[$to] !== '';
        if ($t === 'p' && $to === $p['ep'] && !$capture) {
            $b[$to + ($s === 'w' ? -8 : 8)] = '';
            $capture = true;
        }
        $b[$to] = $promo !== '' ? ($s === 'w' ? strtoupper($promo) : $promo) : $c;
        $b[$from] = '';
        if ($t === 'k' && abs($to - $from) === 2) {
            [$rf, $rt] = $to > $from ? [$from + 3, $from + 1] : [$from - 4, $from - 1];
            $b[$rt] = $b[$rf];
            $b[$rf] = '';
        }
        $castle = $p['castle'];
        if ($t === 'k') {
            $castle = str_replace($s === 'w' ? ['K', 'Q'] : ['k', 'q'], '', $castle);
        }
        foreach ([0 => 'Q', 7 => 'K', 56 => 'q', 63 => 'k'] as $corner => $right) {
            if ($from === $corner || $to === $corner) {
                $castle = str_replace($right, '', $castle);
            }
        }
        return [
            'b' => $b, 'turn' => $s === 'w' ? 'b' : 'w', 'castle' => $castle,
            'ep' => ($t === 'p' && abs($to - $from) === 16) ? intdiv($from + $to, 2) : -1,
            'half' => ($t === 'p' || $capture) ? 0 : $p['half'] + 1,
            'full' => $p['full'] + ($s === 'b' ? 1 : 0),
        ];
    }

    public static function legal(array $p): array
    {
        $out = [];
        foreach (self::pseudo($p) as $m) {
            $n = self::make($p, $m);
            if (!self::attacked($n['b'], self::kingSq($n['b'], $p['turn']), $n['turn'])) {
                $out[] = $m;
            }
        }
        return $out;
    }

    public static function perft(array $p, int $depth): int
    {
        if ($depth === 0) {
            return 1;
        }
        $moves = self::legal($p);
        if ($depth === 1) {
            return count($moves);
        }
        $n = 0;
        foreach ($moves as $m) {
            $n += self::perft(self::make($p, $m), $depth - 1);
        }
        return $n;
    }

    private static function insufficient(array $b): bool
    {
        $minors = [];
        foreach ($b as $sq => $c) {
            $t = strtolower($c);
            if ($c === '' || $t === 'k') {
                continue;
            }
            if ($t !== 'b' && $t !== 'n') {
                return false;
            }
            $minors[] = [$t, ($sq % 8 + intdiv($sq, 8)) % 2];
        }
        if (count($minors) <= 1) {
            return true;
        }
        // Only bishops, all on the same square colour
        return !in_array('n', array_column($minors, 0), true) && count(array_unique(array_column($minors, 1))) === 1;
    }

    /** '' while the game goes on, else checkmate | stalemate | fifty-move rule | insufficient material | threefold repetition. */
    public static function outcome(array $p, array $history): string
    {
        if (!self::legal($p)) {
            return self::inCheck($p) ? 'checkmate' : 'stalemate';
        }
        if ($p['half'] >= 100) {
            return 'fifty-move rule';
        }
        if (self::insufficient($p['b'])) {
            return 'insufficient material';
        }
        $counts = array_count_values($history);
        return ($counts[self::key($p)] ?? 0) >= 3 ? 'threefold repetition' : '';
    }
}

final class EloEngine
{
    public static function compute(int $whiteElo, int $blackElo, float $whiteScore): array
    {
        $k = 32.0;
        $expectedWhite = 1.0 / (1.0 + (10.0 ** (($blackElo - $whiteElo) / 400.0)));
        $expectedBlack = 1.0 - $expectedWhite;
        $blackScore = 1.0 - $whiteScore;

        $newWhite = max(100, (int)round($whiteElo + $k * ($whiteScore - $expectedWhite)));
        $newBlack = max(100, (int)round($blackElo + $k * ($blackScore - $expectedBlack)));

        return [$newWhite, $newBlack];
    }
}

final class DeckKernel
{
    private const R = Config::ROOM;
    private const FLEET = [2, 3, 3, 4, 5];
    private const LEGACY_SENDERS = ['CLAUDE_CODE' => 'CLAUDE', 'CHESS_ARENA' => 'ARENA', 'ARENA_CORE' => 'ARENA'];

    public const DEFAULT_SETTINGS = [
        'games_enabled'     => true,
        'chess_stakes'      => true,
        'max_stake'         => 100000,
        'slow_mode'         => 0,
        'spins_5h'          => 60,
        'spins_week'        => 400,
        'registration_open' => true,
        'claude_daily_tokens' => 200000,
        'move_timeout_hours'  => 24,
    ];

    // Loot case: [multiplier, weight]; negative = lose the stake plus that many extra stakes. EV ~0.95.
    public const CASE_TABLE = [
        [-5, 2], [-2, 6], [0, 280], [0.25, 150], [0.5, 180], [0.75, 140],
        [1.25, 120], [1.5, 80], [2, 60], [3, 30], [5, 14], [10, 6], [25, 2], [50, 1], [100, 1],
    ];

    // Verified against when the username does not exist, so login timing does not reveal accounts
    private const DUMMY_HASH = '$argon2id$v=19$m=65536,t=4,p=1$ZmtlVGFJZ3I0NW8yUGFYdQ$e9xNjH9ZX4oahlEUZ0bYMR1tmViZp9wdNLtqzDxM1Lk';

    private int $txDepth = 0;

    public function __construct(private readonly PDO $pdo) {}

    public function handle(array $input): array
    {
        $action = is_string($input['action'] ?? null) ? $input['action'] : '';

        return match ($action) {
            'server_info' => $this->serverInfo(),
            'register'    => $this->register($input),
            'login'       => $this->login($input),
            default       => $this->handleAuthenticated($action, $input),
        };
    }

    // ---------------------------------------------------------------- server meta

    private function meta(string $k): string
    {
        $stmt = $this->pdo->prepare('SELECT v FROM server_meta WHERE k = ?');
        $stmt->execute([$k]);
        return (string)($stmt->fetchColumn() ?: '');
    }

    private function setMeta(string $k, string $v): void
    {
        $this->pdo->prepare('INSERT INTO server_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')->execute([$k, $v]);
    }

    private function settings(): array
    {
        $saved = json_decode($this->meta('settings') ?: '{}', true);
        $s = array_merge(self::DEFAULT_SETTINGS, is_array($saved) ? array_intersect_key($saved, self::DEFAULT_SETTINGS) : []);
        foreach (['games_enabled', 'chess_stakes', 'registration_open'] as $b) {
            $s[$b] = (bool)$s[$b];
        }
        foreach (['max_stake', 'slow_mode', 'spins_5h', 'spins_week', 'claude_daily_tokens', 'move_timeout_hours'] as $i) {
            $s[$i] = (int)$s[$i];
        }
        return $s;
    }

    private function bumpRev(): void
    {
        $this->pdo->exec("UPDATE server_meta SET v = CAST(v AS INTEGER) + 1 WHERE k = 'members_rev'");
    }

    /** BEGIN IMMEDIATE transaction (takes the write lock up front, so check-then-write sequences cannot race). */
    private function tx(callable $fn): mixed
    {
        if ($this->txDepth > 0) {
            return $fn();
        }
        $this->pdo->exec('BEGIN IMMEDIATE');
        $this->txDepth = 1;
        try {
            $result = $fn();
            $this->pdo->exec('COMMIT');
            return $result;
        } catch (Throwable $e) {
            try { $this->pdo->exec('ROLLBACK'); } catch (Throwable) {}
            throw $e;
        } finally {
            $this->txDepth = 0;
        }
    }

    private function memberCount(): int
    {
        return (int)$this->pdo->query("SELECT COUNT(*) FROM room_members WHERE room_id = 'MAIN' AND banned = 0")->fetchColumn();
    }

    private function serverInfo(): array
    {
        Security::enforceRateLimit($this->pdo, 'server_info', 60, 60);
        $s = $this->settings();
        return [
            'ok'                => true,
            'name'              => $this->meta('name') ?: 'Claude Multiplayer',
            'motd'              => $this->meta('motd'),
            'version'           => Config::API_VERSION,
            'requires_join_key' => $this->meta('join_key_hash') !== '',
            'requires_setup_token' => (int)$this->meta('owner_user_id') <= 0 && (string)(getenv('DECK_SETUP_TOKEN') ?: SETUP_TOKEN) !== '',
            'member_count'      => $this->memberCount(),
            'registration_open' => $s['registration_open'],
        ];
    }

    // ---------------------------------------------------------------- auth

    private function userOut(array $u, ?string $role = null): array
    {
        return [
            'id'            => (int)$u['id'],
            'username'      => (string)$u['username'],
            'display_nick'  => (string)$u['display_nick'],
            'avatar_preset' => in_array($u['avatar_preset'], Config::AVATAR_PRESETS, true) ? $u['avatar_preset'] : 'CLAUDE_CRAB',
            'avatar_color'  => (string)$u['avatar_color'],
            'bio'           => (string)$u['bio'],
            'points'        => (int)$u['points'],
            'elo'           => (int)$u['elo'],
            'role'          => $role ?? $this->roleOf((int)$u['id']),
            'usage_hidden'  => (bool)$u['usage_hidden'],
        ];
    }

    private function roleOf(int $userId): string
    {
        $stmt = $this->pdo->prepare("SELECT role FROM room_members WHERE room_id = 'MAIN' AND user_id = ?");
        $stmt->execute([$userId]);
        return (string)($stmt->fetchColumn() ?: 'member');
    }

    private function loadUser(int $id): array
    {
        $stmt = $this->pdo->prepare('SELECT * FROM users WHERE id = ?');
        $stmt->execute([$id]);
        return $stmt->fetch() ?: [];
    }

    private function register(array $in): array
    {
        Security::enforceRateLimit($this->pdo, 'auth_register', 8, 300);

        $username = Security::text($in['username'] ?? '', 64);
        $password = is_string($in['password'] ?? null) ? $in['password'] : '';
        $confirm  = is_string($in['password_confirm'] ?? null) ? $in['password_confirm'] : '';
        $nick     = Security::text($in['default_nick'] ?? $username, 64);
        $joinKey  = is_string($in['join_key'] ?? null) ? $in['join_key'] : '';

        if (!preg_match('/^[a-zA-Z0-9_.-]{3,24}$/', $username)) {
            throw new ApiException('Username must be 3-24 characters (letters, digits, _ . -).');
        }
        if (strlen($password) < 6 || strlen($password) > 256) {
            throw new ApiException('Password must be 6-256 characters.');
        }
        if ($password !== $confirm) {
            throw new ApiException('Password confirmation does not match.');
        }
        if (!preg_match('/^[a-zA-Z0-9_.-]{2,18}$/', $nick)) {
            $nick = substr((string)preg_replace('/[^a-zA-Z0-9_.-]/', '', $username), 0, 18) ?: 'Operator';
        }

        $hasOwner = (int)$this->meta('owner_user_id') > 0;
        $setupToken = (string)(getenv('DECK_SETUP_TOKEN') ?: SETUP_TOKEN);
        if (!$hasOwner && $setupToken !== '' && !hash_equals($setupToken, is_string($in['setup_token'] ?? null) ? $in['setup_token'] : '')) {
            throw new ApiException('The first (owner) registration requires the server setup token.', 403, 'SETUP_TOKEN_REQUIRED');
        }
        if ($hasOwner && !$this->settings()['registration_open']) {
            throw new ApiException('Registration is closed on this server.', 403, 'REGISTRATION_CLOSED');
        }
        $keyHash = $this->meta('join_key_hash');
        if ($keyHash !== '' && ($joinKey === '' || strlen($joinKey) > 256 || !password_verify($joinKey, $keyHash))) {
            throw new ApiException('A valid join key is required to register on this server.', 403, 'JOIN_KEY_INVALID');
        }

        $rawToken = bin2hex(random_bytes(32));
        $passHash = Security::hashPassword($password);

        [$id, $role] = $this->tx(function () use ($username, $passHash, $nick, $rawToken): array {
            try {
                $this->pdo->prepare('
                    INSERT INTO users (username, password_hash, display_nick, avatar_color, token_sha256, created_at)
                    VALUES (?, ?, ?, ?, ?, ?)
                ')->execute([$username, $passHash, $nick, '#D97757', hash('sha256', $rawToken), time()]);
            } catch (PDOException) {
                throw new ApiException('Username or display nickname is already registered.', 409, 'CONFLICT');
            }
            $id = (int)$this->pdo->lastInsertId();
            $isOwner = (int)$this->meta('owner_user_id') === 0;
            if ($isOwner) {
                $this->setMeta('owner_user_id', (string)$id);
                $this->pdo->prepare("UPDATE rooms SET owner_id = ? WHERE room_id = 'MAIN'")->execute([$id]);
            }
            $role = $isOwner ? 'owner' : 'member';
            $this->pdo->prepare("INSERT INTO room_members (room_id, user_id, last_seen, role) VALUES ('MAIN', ?, ?, ?)")
                ->execute([$id, time(), $role]);
            $this->bumpRev();
            return [$id, $role];
        });

        return ['ok' => true, 'auth_token' => $rawToken, 'user' => $this->userOut($this->loadUser($id), $role)];
    }

    private function login(array $in): array
    {
        Security::enforceRateLimit($this->pdo, 'auth_login', 12, 300);

        $username = Security::text($in['username'] ?? '', 64);
        $password = is_string($in['password'] ?? null) ? $in['password'] : '';

        $stmt = $this->pdo->prepare('SELECT * FROM users WHERE username = ?');
        $stmt->execute([$username]);
        $user = $stmt->fetch();

        $valid = password_verify(substr($password, 0, 256), $user ? (string)$user['password_hash'] : self::DUMMY_HASH);
        if (!$user || !$valid || strlen($password) > 256) {
            throw new ApiException('Invalid credentials.', 401, 'INVALID_CREDENTIALS');
        }
        $this->assertNotBanned((int)$user['id']);

        $rawToken = bin2hex(random_bytes(32));
        $this->pdo->prepare('UPDATE users SET token_sha256 = ? WHERE id = ?')
            ->execute([hash('sha256', $rawToken), $user['id']]);

        return ['ok' => true, 'auth_token' => $rawToken, 'user' => $this->userOut($user)];
    }

    private function assertNotBanned(int $userId): void
    {
        $stmt = $this->pdo->prepare("SELECT banned FROM room_members WHERE room_id = 'MAIN' AND user_id = ?");
        $stmt->execute([$userId]);
        if ((int)$stmt->fetchColumn() === 1) {
            throw new ApiException('You are banned from this server.', 403, 'BANNED');
        }
    }

    private function handleAuthenticated(string $action, array $in): array
    {
        $rawToken = trim((string)($_SERVER['HTTP_X_DECK_TOKEN'] ?? ''));
        if (!preg_match('/^[0-9a-f]{64}$/', $rawToken)) {
            throw new ApiException('Missing or malformed session token.', 401, 'UNAUTHORIZED');
        }

        $stmt = $this->pdo->prepare('SELECT * FROM users WHERE token_sha256 = ?');
        $stmt->execute([hash('sha256', $rawToken)]);
        $user = $stmt->fetch();
        if (!$user) {
            throw new ApiException('Session expired or invalidated.', 401, 'UNAUTHORIZED');
        }

        // Auto-join MAIN (legacy users, or users who were kicked and logged in again)
        $this->pdo->prepare("INSERT OR IGNORE INTO room_members (room_id, user_id, last_seen) VALUES ('MAIN', ?, 0)")
            ->execute([(int)$user['id']]);
        $m = $this->pdo->prepare("SELECT * FROM room_members WHERE room_id = 'MAIN' AND user_id = ?");
        $m->execute([(int)$user['id']]);
        $member = $m->fetch();
        if ((int)$member['banned'] === 1) {
            throw new ApiException('You are banned from this server.', 403, 'BANNED');
        }

        if (str_starts_with($action, 'game_') || str_starts_with($action, 'duel_') || str_starts_with($action, 'chess_') || str_starts_with($action, 'bs_')) {
            Security::enforceRateLimit($this->pdo, 'games', 30, 10, 'u:' . $user['id']);
        }

        $limits = ['sync' => [60, 30], 'members' => [30, 10], 'history' => [30, 10], 'search_messages' => [10, 10]];
        if (isset($limits[$action])) {
            Security::enforceRateLimit($this->pdo, $action, $limits[$action][0], $limits[$action][1], 'u:' . $user['id']);
        }

        return match ($action) {
            'logout'          => $this->logout((int)$user['id']),
            'update_profile'  => $this->updateProfile($user, $in),
            'change_password' => $this->changePassword($user, $in),
            'sync'            => $this->sync($user, $member, $in),
            'members'         => $this->members($user, $in),
            'history'         => $this->history($in),
            'search_messages' => $this->searchMessages($in),
            'send_message'    => $this->sendMessage($user, $member, $in),
            'chess_invite'    => $this->chessInvite($user, $in),
            'chess_accept'    => $this->chessAccept($user, $in),
            'chess_decline'   => $this->chessDecline($user, $in),
            'chess_move'      => $this->chessMove($user, $in),
            'game_spin'       => $this->gameSpin($user, $in),
            'duel_create'     => $this->duelCreate($user, $in),
            'duel_join'       => $this->duelJoin($user, $in),
            'duel_cancel'     => $this->duelCancel($user, $in),
            'bs_invite'       => $this->bsInvite($user, $in),
            'bs_accept'       => $this->bsAccept($user, $in),
            'bs_decline'      => $this->bsDecline($user, $in),
            'bs_place'        => $this->bsPlace($user, $in),
            'bs_fire'         => $this->bsFire($user, $in),
            'bs_resign'       => $this->bsResign($user, $in),
            'admin'           => $this->admin($user, $member, $in),
            'transfer_points' => $this->transferPoints($user, $member, $in),
            'admin_banned'    => $this->adminBanned($member),
            default           => throw new ApiException('Unknown action.', 400, 'UNKNOWN_ACTION'),
        };
    }

    private function logout(int $userId): array
    {
        $this->pdo->prepare('UPDATE users SET token_sha256 = NULL WHERE id = ?')->execute([$userId]);
        return ['ok' => true];
    }

    /** Clients send a PBKDF2 derivation of the password (never the plaintext); this just re-hashes it. */
    private function changePassword(array $user, array $in): array
    {
        $old = substr((string)($in['old_password'] ?? ''), 0, 256);
        $new = (string)($in['new_password'] ?? '');
        if (!password_verify($old, (string)$user['password_hash'])) {
            throw new ApiException('Current password is wrong.', 403, 'INVALID_CREDENTIALS');
        }
        if (strlen($new) < 6 || strlen($new) > 256) {
            throw new ApiException('New password must be 6-256 characters.');
        }
        $this->pdo->prepare('UPDATE users SET password_hash = ? WHERE id = ?')
            ->execute([Security::hashPassword($new), (int)$user['id']]);
        return ['ok' => true];
    }

    private function updateProfile(array $user, array $in): array
    {
        $userId = (int)$user['id'];
        $newNick = array_key_exists('display_nick', $in) ? Security::text($in['display_nick'], 64) : (string)$user['display_nick'];
        $preset  = array_key_exists('avatar_preset', $in) ? Security::text($in['avatar_preset'], 32) : (string)$user['avatar_preset'];
        $color   = array_key_exists('avatar_color', $in) ? Security::sanitizeColor(Security::text($in['avatar_color'], 7)) : (string)$user['avatar_color'];
        $bio     = array_key_exists('bio', $in) ? Security::text($in['bio'], 160) : (string)$user['bio'];
        $usageHidden = array_key_exists('usage_hidden', $in) ? ((bool)$in['usage_hidden'] ? 1 : 0) : (int)$user['usage_hidden'];

        if (!preg_match('/^[a-zA-Z0-9_.-]{2,18}$/', $newNick)) {
            throw new ApiException('Nickname must be 2-18 characters (letters, digits, _ . -).');
        }
        if (!in_array($preset, Config::AVATAR_PRESETS, true)) {
            if (array_key_exists('avatar_preset', $in)) {
                throw new ApiException('Unknown avatar preset.', 400, 'INVALID_AVATAR');
            }
            $preset = 'CLAUDE_CRAB';
        }

        try {
            $this->pdo->prepare('UPDATE users SET display_nick = ?, avatar_preset = ?, avatar_color = ?, bio = ?, usage_hidden = ? WHERE id = ?')
                ->execute([$newNick, $preset, $color, $bio, $usageHidden, $userId]);
        } catch (PDOException) {
            throw new ApiException('That nickname is already claimed by another operator.', 409, 'NICK_TAKEN');
        }
        $this->bumpRev();

        return ['ok' => true, 'user' => $this->userOut($this->loadUser($userId))];
    }

    // ---------------------------------------------------------------- sync

    private function sync(array $user, array $member, array $in): array
    {
        $userId = (int)$user['id'];
        $nowTs = time();
        $t = is_array($in['telemetry'] ?? null) ? $in['telemetry'] : [];
        $sleeping = (bool)($t['is_sleeping'] ?? false);

        $row = [
            'status'         => $sleeping ? 'OFFLINE' : (isset($t['status']) ? (Security::text($t['status'], 20) ?: 'IDLE') : 'IDLE'),
            'ctx_pct'        => array_key_exists('ctx_pct', $t) && is_numeric($t['ctx_pct']) ? max(0, min(100, (int)$t['ctx_pct'])) : -1,
            'shares_usage'   => 0,
            'shares_commits' => 0,
            'shares_focus'   => 0,
            'usage_s'        => (int)$member['usage_s'],
            'usage_w'        => (int)$member['usage_w'],
            'usage_reset'    => (string)$member['usage_reset'],
            'usage_reset_w'  => (string)$member['usage_reset_w'],
            'usage_ts'       => (int)$member['usage_ts'],
            'commits_day'    => (int)$member['commits_day'],
            'commits_week'   => (int)$member['commits_week'],
            'project'        => (string)$member['project'],
            'branch'         => (string)$member['branch'],
            'task_it'        => (string)$member['task_it'],
        ];
        if (is_array($t['usage'] ?? null)) {
            $u = $t['usage'];
            $row['shares_usage'] = 1;
            $row['usage_s'] = max(-1, min(100, (int)($u['s'] ?? -1)));
            $row['usage_w'] = max(-1, min(100, (int)($u['w'] ?? -1)));
            $row['usage_reset'] = Security::text($u['reset_s'] ?? '', 60);
            $row['usage_reset_w'] = Security::text($u['reset_w'] ?? '', 60);
            $row['usage_ts'] = max(0, (int)($u['ts'] ?? $nowTs));
        }
        if (is_array($t['commits'] ?? null)) {
            $row['shares_commits'] = 1;
            $row['commits_day'] = max(0, min(100000, (int)($t['commits']['day'] ?? 0)));
            $row['commits_week'] = max(0, min(100000, (int)($t['commits']['week'] ?? 0)));
        }
        if (is_array($t['focus'] ?? null)) {
            $row['shares_focus'] = 1;
            $row['project'] = Security::text($t['focus']['project'] ?? '', 40);
            $row['branch'] = Security::text($t['focus']['branch'] ?? '', 40);
            $row['task_it'] = Security::text($t['focus']['task'] ?? '', 90);
        }

        $changed = false;
        foreach ($row as $k => $v) {
            if ($k !== 'ctx_pct' && (string)$member[$k] !== (string)$v) {
                $changed = true;
                break;
            }
        }
        $cols = implode(', ', array_map(fn($k) => "{$k} = ?", array_keys($row)));
        $this->pdo->prepare("UPDATE room_members SET {$cols}, last_seen = ? WHERE room_id = 'MAIN' AND user_id = ?")
            ->execute([...array_values($row), $sleeping ? $nowTs - 120 : $nowTs, $userId]);

        if (is_array($in['new_commits'] ?? null)) {
            $cStmt = $this->pdo->prepare('
                INSERT OR IGNORE INTO commit_feed (room_id, user_id, handle, project, branch, short_hash, message, created_at, created_ts)
                VALUES (\'MAIN\', ?, ?, ?, ?, ?, ?, ?, ?)
            ');
            foreach (array_slice($in['new_commits'], 0, 20) as $c) {
                $hash = is_array($c) ? Security::text($c['short_hash'] ?? '', 12) : '';
                if ($hash === '') {
                    continue;
                }
                $cStmt->execute([
                    $userId,
                    $user['display_nick'],
                    Security::text($c['project'] ?? '', 40),
                    Security::text($c['branch'] ?? '', 40),
                    $hash,
                    Security::text($c['message'] ?? '', 100),
                    Security::text($c['timestamp'] ?? date('H:i'), 20),
                    $nowTs,
                ]);
            }
        }

        // Online set changes are detected lazily by comparing a signature of online member ids
        $on = $this->pdo->prepare("SELECT user_id FROM room_members WHERE room_id = 'MAIN' AND banned = 0 AND last_seen >= ? ORDER BY user_id");
        $on->execute([$nowTs - Config::ONLINE_WINDOW]);
        $onlineIds = $on->fetchAll(PDO::FETCH_COLUMN);
        $sig = md5(implode(',', $onlineIds));
        if ($sig !== $this->meta('online_sig')) {
            $this->setMeta('online_sig', $sig);
            $changed = true;
        }
        if ($changed) {
            $this->bumpRev();
        }

        $room = $this->pdo->query("SELECT * FROM rooms WHERE room_id = 'MAIN'")->fetch();
        $this->evaluateFridayShowdown($room);
        $this->expireStaleBattleship();
        $this->expireStaleChess();

        $lastMsgId = max(0, (int)($in['last_msg_id'] ?? 0));
        if ($lastMsgId === 0) {
            $mStmt = $this->pdo->prepare("SELECT * FROM (SELECT * FROM messages WHERE room_id = 'MAIN' ORDER BY id DESC LIMIT 50) ORDER BY id ASC");
            $mStmt->execute();
        } else {
            $mStmt = $this->pdo->prepare("SELECT * FROM messages WHERE room_id = 'MAIN' AND id > ? ORDER BY id ASC LIMIT 250");
            $mStmt->execute([$lastMsgId]);
        }

        $cgStmt = $this->pdo->prepare('
            SELECT cg.id, cg.room_id, cg.white_user_id, cg.black_user_id, cg.status, cg.fen, cg.last_move,
                   cg.winner_user_id, cg.updated_at, cg.stake,
                   uw.display_nick AS white_nick, uw.elo AS white_elo, uw.avatar_color AS white_color,
                   ub.display_nick AS black_nick, ub.elo AS black_elo, ub.avatar_color AS black_color
            FROM chess_games cg
            JOIN users uw ON uw.id = cg.white_user_id
            JOIN users ub ON ub.id = cg.black_user_id
            WHERE cg.room_id = \'MAIN\' AND cg.status IN (\'INVITED\', \'ACTIVE\')
              AND (cg.white_user_id = ? OR cg.black_user_id = ?)
            ORDER BY cg.updated_at DESC
        ');
        $cgStmt->execute([$userId, $userId]);

        $fStmt = $this->pdo->query("SELECT id, user_id, handle, project, branch, short_hash, message, created_at FROM commit_feed WHERE room_id = 'MAIN' ORDER BY id DESC LIMIT 25");

        $me = $this->loadUser($userId);
        $settings = $this->settings();
        $server = [
            'name'     => $this->meta('name') ?: 'Claude Multiplayer',
            'motd'     => $this->meta('motd'),
            'settings' => $settings + ['requires_join_key' => $this->meta('join_key_hash') !== ''],
            'my_role'  => (string)$member['role'],
        ];
        if (in_array($member['role'], ['owner', 'admin'], true)) {
            $server['anthropic_key_masked'] = Crypto::mask(Crypto::decrypt($this->meta('anthropic_key_enc')));
        }

        return [
            'ok'            => true,
            'me'            => $this->userOut($me, (string)$member['role']) + ['muted_until' => (int)$member['muted_until']],
            'server'        => $server,
            'new_messages'  => array_map([$this, 'messageOut'], $mStmt->fetchAll()),
            'online_count'  => count($onlineIds),
            'members_rev'   => (int)$this->meta('members_rev'),
            'duels'         => $this->listDuels(),
            'chess'         => $cgStmt->fetchAll(),
            'battleship'    => $this->listBattleship($userId),
            'commit_feed'   => $fStmt->fetchAll(),
            'game_limits'   => $this->spinLimits($userId, $settings)['out'],
        ];
    }

    private function evaluateFridayShowdown(array $room): void
    {
        $now = new DateTimeImmutable('now', new DateTimeZone('Europe/Rome'));
        $dayOfWeek = (int)$now->format('N'); // 5 = Friday
        $hour = (int)$now->format('G');
        $minute = (int)$now->format('i');
        $weekKey = $now->format('o-\WW');

        $isPastTrigger = ($dayOfWeek === 5 && ($hour > 16 || ($hour === 16 && $minute >= 30))) || ($dayOfWeek > 5);
        if (!$isPastTrigger || $room['last_awarded_week'] === $weekKey) {
            return;
        }

        // Weekly commits are counted server-side from commit_feed rows received this ISO week (server clock),
        // so client-reported counters never influence prizes.
        $weekStart = $now->modify('monday this week')->setTime(0, 0)->getTimestamp();
        $stmt = $this->pdo->prepare("
            SELECT cf.user_id, COUNT(*) AS n, u.display_nick
            FROM commit_feed cf
            JOIN room_members rm ON rm.room_id = 'MAIN' AND rm.user_id = cf.user_id AND rm.banned = 0
            JOIN users u ON u.id = cf.user_id
            WHERE cf.room_id = 'MAIN' AND cf.created_ts >= ?
            GROUP BY cf.user_id
            ORDER BY n DESC, MIN(cf.id) ASC
            LIMIT 3
        ");
        $stmt->execute([$weekStart]);
        $top = $stmt->fetchAll();
        if (!$top) {
            return;
        }

        $this->tx(function () use ($top, $weekKey): void {
            // Claim the week first so concurrent syncs cannot award twice
            $claim = $this->pdo->prepare("UPDATE rooms SET last_awarded_week = ?, champion_user_id = ? WHERE room_id = 'MAIN' AND last_awarded_week <> ?");
            $claim->execute([$weekKey, (int)$top[0]['user_id'], $weekKey]);
            if ($claim->rowCount() !== 1) {
                return;
            }
            foreach ($top as $i => $w) {
                $this->addPoints((int)$w['user_id'], [1000, 500, 250][$i]);
            }
            $this->pdo->prepare("UPDATE room_members SET trophies = trophies + 1 WHERE room_id = 'MAIN' AND user_id = ?")
                ->execute([(int)$top[0]['user_id']]);
            $this->insertSystemMessage('ARENA', 'TROPHY_EVENT', sprintf(
                '🏆 FRIDAY 16:30 SHOWDOWN (%s): %s takes the Crown & Golden Frame with %d commits this week! (+1 Trophy, +1000 pts | 2nd +500 | 3rd +250)',
                $weekKey,
                $top[0]['display_nick'],
                (int)$top[0]['n']
            ), ['showdown', ['week' => $weekKey, 'nick' => $top[0]['display_nick'], 'n' => (int)$top[0]['n']]]);
        });
    }

    private function members(array $user, array $in): array
    {
        $q = Security::text($in['q'] ?? '', 40);
        $page = max(1, min(100000, (int)($in['page'] ?? 1)));
        $limit = max(1, min(50, (int)($in['limit'] ?? 50)));
        $nowTs = time();

        $where = [];
        $args = [];
        $ql = strtolower($q);
        if ($ql === 'owner' || !empty($in['owner'])) {
            $where[] = "role = 'owner'";
        } elseif ($ql === 'admin' || !empty($in['admin'])) {
            $where[] = "role = 'admin'";
        }
        if ($ql === 'online' || !empty($in['online'])) {
            $where[] = 'last_seen >= ?';
            $args[] = $nowTs - Config::ONLINE_WINDOW;
        }
        if ($q !== '' && !in_array($ql, ['owner', 'admin', 'online'], true)) {
            $where[] = "display_nick LIKE ? ESCAPE '\\'";
            $args[] = '%' . addcslashes($q, '%_\\') . '%';
        }
        $filter = $where ? 'WHERE ' . implode(' AND ', $where) : '';
        $base = "
            WITH ranked AS (
                SELECT rm.*, u.display_nick, u.avatar_color, u.avatar_preset, u.bio, u.points, u.elo, u.usage_hidden,
                       RANK() OVER (ORDER BY u.points DESC) AS rank
                FROM room_members rm JOIN users u ON u.id = rm.user_id
                WHERE rm.room_id = 'MAIN' AND rm.banned = 0
            )
        ";
        $cnt = $this->pdo->prepare($base . "SELECT COUNT(*) FROM ranked {$filter}");
        $cnt->execute($args);
        $total = (int)$cnt->fetchColumn();

        $stmt = $this->pdo->prepare($base . "SELECT * FROM ranked {$filter} ORDER BY points DESC, user_id ASC LIMIT ? OFFSET ?");
        $stmt->execute([...$args, $limit, ($page - 1) * $limit]);

        $viewerId = (int)$user['id'];
        $viewerHidden = (int)$user['usage_hidden'] === 1;
        $items = [];
        foreach ($stmt->fetchAll() as $r) {
            $self = (int)$r['user_id'] === $viewerId;
            $online = ($nowTs - (int)$r['last_seen']) <= Config::ONLINE_WINDOW;
            $masked = !$self && ((int)$r['usage_hidden'] === 1 || $viewerHidden);
            $usage = (int)$r['shares_usage'] === 1 && !$masked;
            $commits = (int)$r['shares_commits'] === 1;
            $focus = (int)$r['shares_focus'] === 1;
            $items[] = [
                'user_id'       => (int)$r['user_id'],
                'display_nick'  => (string)$r['display_nick'],
                'avatar_color'  => (string)$r['avatar_color'],
                'avatar_preset' => in_array($r['avatar_preset'], Config::AVATAR_PRESETS, true) ? $r['avatar_preset'] : 'CLAUDE_CRAB',
                'bio'           => (string)$r['bio'],
                'points'        => (int)$r['points'],
                'elo'           => (int)$r['elo'],
                'trophies'      => (int)$r['trophies'],
                'role'          => (string)$r['role'],
                'is_online'     => $online,
                'status'        => $online ? (string)$r['status'] : 'OFFLINE',
                'usage_s'       => $usage && (int)$r['usage_s'] >= 0 ? (int)$r['usage_s'] : null,
                'usage_w'       => $usage && (int)$r['usage_w'] >= 0 ? (int)$r['usage_w'] : null,
                'usage_ts'      => $usage ? (int)$r['usage_ts'] : null,
                'usage_masked'  => $masked,
                'ctx_pct'       => (int)$r['ctx_pct'] >= 0 ? (int)$r['ctx_pct'] : null,
                'commits_day'   => $commits ? (int)$r['commits_day'] : null,
                'commits_week'  => $commits ? (int)$r['commits_week'] : null,
                'project'       => $focus ? (string)$r['project'] : null,
                'branch'        => $focus ? (string)$r['branch'] : null,
                'task'          => $focus ? (string)$r['task_it'] : null,
                'rank'          => (int)$r['rank'],
            ];
        }

        return ['ok' => true, 'total' => $total, 'page' => $page, 'items' => $items];
    }

    private function messageOut(array $m): array
    {
        $type = (string)$m['msg_type'];
        $nick = (string)$m['sender_nick'];
        if (in_array($type, ['CLAUDE_BOT', 'BOT_ERROR'], true)) {
            $type = 'SYSTEM';
            $nick = 'CLAUDE';
        } elseif (!in_array($type, ['CHAT', 'SNIPPET', 'SYSTEM', 'CHESS_EVENT', 'TROPHY_EVENT', 'BATTLESHIP_EVENT'], true)) {
            $type = 'SYSTEM';
        }
        if ((int)$m['user_id'] === 0) {
            $nick = self::LEGACY_SENDERS[$nick] ?? $nick;
        }
        return [
            'id'           => (int)$m['id'],
            'user_id'      => (int)$m['user_id'],
            'sender_nick'  => $nick,
            'avatar_color' => (string)$m['avatar_color'],
            'msg_type'     => $type,
            'content'      => (string)$m['content'],
            'snippet_body' => (string)$m['snippet_body'],
            'reply_to'     => (int)$m['reply_to'],
            'i18n'         => ($m['i18n'] ?? '') !== '' ? json_decode((string)$m['i18n'], true) : null,
            'created_ts'   => (int)$m['created_ts'],
        ];
    }

    private function history(array $in): array
    {
        $before = (int)($in['before_id'] ?? 0);
        $limit = max(1, min(100, (int)($in['limit'] ?? 50)));
        $stmt = $this->pdo->prepare("SELECT * FROM messages WHERE room_id = 'MAIN' AND id < ? ORDER BY id DESC LIMIT ?");
        $stmt->execute([$before > 0 ? $before : PHP_INT_MAX, $limit]);
        return ['ok' => true, 'messages' => array_map([$this, 'messageOut'], array_reverse($stmt->fetchAll()))];
    }

    private function searchMessages(array $in): array
    {
        $q = Security::text($in['q'] ?? '', 120);
        $fromNick = ltrim(Security::text($in['from_nick'] ?? '', 40), '@');
        $dateFrom = (int)($in['date_from'] ?? 0);
        $dateTo = (int)($in['date_to'] ?? 0);
        $limit = max(1, min(100, (int)($in['limit'] ?? 50)));

        $where = ["m.room_id = 'MAIN'"];
        $args = [];
        $join = '';
        if ($q !== '' && mb_strlen($q) < 2) {
            throw new ApiException('Search text must be at least 2 characters.');
        }
        if ($q !== '') {
            // Every user token becomes a quoted FTS5 string (no operators/columns can be injected); last one is a prefix
            $tokens = array_slice(preg_split('/\s+/u', $q, -1, PREG_SPLIT_NO_EMPTY) ?: [], 0, 8);
            $parts = array_map(fn($t) => '"' . str_replace('"', '""', $t) . '"', $tokens);
            if ($parts) {
                $parts[count($parts) - 1] .= '*';
                $join = 'JOIN messages_fts f ON f.rowid = m.id';
                $where[] = 'messages_fts MATCH ?';
                $args[] = implode(' ', $parts);
            }
        }
        if ($fromNick !== '') {
            $where[] = 'm.sender_nick = ? COLLATE NOCASE';
            $args[] = $fromNick;
        }
        if ($dateFrom > 0) {
            $where[] = 'm.created_ts >= ?';
            $args[] = $dateFrom;
        }
        if ($dateTo > 0) {
            $where[] = 'm.created_ts <= ?';
            $args[] = $dateTo;
        }
        if (count($where) === 1) {
            throw new ApiException('Provide at least one search filter.');
        }
        $stmt = $this->pdo->prepare("SELECT m.* FROM messages m {$join} WHERE " . implode(' AND ', $where) . ' ORDER BY m.id DESC LIMIT ?');
        $stmt->execute([...$args, $limit]);
        return ['ok' => true, 'messages' => array_map([$this, 'messageOut'], array_reverse($stmt->fetchAll()))];
    }

    private function sendMessage(array $user, array $member, array $in): array
    {
        $userId = (int)$user['id'];
        Security::enforceRateLimit($this->pdo, 'send_message', 20, 10, 'u:' . $userId);

        $content = Security::text($in['content'] ?? '', 2000);
        $snippet = is_string($in['snippet_body'] ?? null) ? mb_substr($in['snippet_body'], 0, 12000) : '';
        $msgType = ($in['msg_type'] ?? 'CHAT') === 'SNIPPET' ? 'SNIPPET' : 'CHAT';
        if ($msgType === 'CHAT') {
            $snippet = '';
        }
        if ($content === '' && trim($snippet) === '') {
            throw new ApiException('Message content cannot be empty.');
        }
        if ((int)$member['muted_until'] > time()) {
            throw new ApiException('You are muted until ' . date('H:i', (int)$member['muted_until']) . '.', 403, 'MUTED');
        }
        $slow = $this->settings()['slow_mode'];
        if ($slow > 0 && $member['role'] === 'member' && time() - (int)$member['last_msg_ts'] < $slow) {
            throw new ApiException("Slow mode: one message every {$slow}s.", 429, 'SLOW_MODE');
        }
        $this->pdo->prepare("UPDATE room_members SET last_msg_ts = ? WHERE room_id = 'MAIN' AND user_id = ?")->execute([time(), $userId]);

        $room = $this->pdo->query("SELECT champion_user_id FROM rooms WHERE room_id = 'MAIN'")->fetch();
        $this->pdo->prepare('
            INSERT INTO messages (
                room_id, user_id, sender_nick, sender_elo, avatar_preset, avatar_color,
                is_champion, msg_type, content, snippet_body, created_at, created_ts, reply_to
            ) VALUES (\'MAIN\', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ')->execute([
            $userId,
            $user['display_nick'],
            (int)$user['elo'],
            $user['avatar_preset'],
            $user['avatar_color'],
            (int)$room['champion_user_id'] === $userId ? 1 : 0,
            $msgType,
            $content,
            $snippet,
            date('H:i:s'),
            time(),
            max(0, (int)($in['reply_to'] ?? 0)),
        ]);
        $msgId = (int)$this->pdo->lastInsertId();

        if (stripos($content, '@claude') !== false) {
            $this->dispatchClaudeBot($userId, (string)$user['display_nick'], $content);
        }

        return ['ok' => true, 'id' => $msgId];
    }

    private function dispatchClaudeBot(int $userId, string $askerNick, string $rawContent): void
    {
        $prompt = trim((string)preg_replace('/@claude\b/i', '', $rawContent));
        if ($prompt === '') {
            return;
        }
        $apiKey = Crypto::decrypt($this->meta('anthropic_key_enc')) ?: Config::anthropicKey();
        if ($apiKey === '') {
            $this->insertSystemMessage('CLAUDE', 'SYSTEM', '⚠️ Anthropic API key is not configured for this server. An admin can set it in Server Settings.', ['claudeNoKey']);
            return;
        }
        try {
            Security::enforceRateLimit($this->pdo, 'claude_bot', 5, 3600, 'u:' . $userId);
        } catch (ApiException) {
            $this->insertSystemMessage('CLAUDE', 'SYSTEM', "@{$askerNick} you reached the @claude limit (5 questions per hour).", ['claudeLimit', ['nick' => $askerNick]]);
            return;
        }
        $room = $this->pdo->query("SELECT tokens_burned_today, burn_date FROM rooms WHERE room_id = 'MAIN'")->fetch();
        $burned = (int)$room['tokens_burned_today'];
        if ($room['burn_date'] !== date('Y-m-d')) {
            $this->pdo->prepare("UPDATE rooms SET tokens_burned_today = 0, burn_date = ? WHERE room_id = 'MAIN'")->execute([date('Y-m-d')]);
            $burned = 0;
        }
        if ($burned >= $this->settings()['claude_daily_tokens']) {
            $this->insertSystemMessage('CLAUDE', 'SYSTEM', 'The daily @claude token budget for this server is used up. Try again tomorrow.', ['claudeBudget']);
            return;
        }

        $payload = json_encode([
            'model'      => 'claude-3-7-sonnet-latest',
            'max_tokens' => 700,
            'system'     => "You are CLAUDE_CODE, an embedded senior engineering AI inside a multiplayer developer terminal room. Reply concisely with clean code or architectural answers. Addressing operator: {$askerNick}.",
            'messages'   => [['role' => 'user', 'content' => mb_substr($prompt, 0, 2000)]],
        ]);

        $ch = curl_init('https://api.anthropic.com/v1/messages');
        curl_setopt_array($ch, [
            CURLOPT_POST           => true,
            CURLOPT_POSTFIELDS     => $payload,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => 25,
            CURLOPT_HTTPHEADER     => [
                'Content-Type: application/json',
                'x-api-key: ' . $apiKey,
                'anthropic-version: 2023-06-01',
            ],
        ]);
        $rawResp = curl_exec($ch);
        $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);

        $decoded = is_string($rawResp) ? json_decode($rawResp, true) : null;
        $replyText = $decoded['content'][0]['text'] ?? null;
        if ($code !== 200 || !is_string($replyText)) {
            // Upstream errors may contain account details: log them, never post them
            error_log('[multiplayer] @claude upstream failure, HTTP ' . $code);
            $this->insertSystemMessage('CLAUDE', 'SYSTEM', '⚠️ Claude is unavailable right now. Please try again later.', ['claudeDown']);
            return;
        }
        $used = (int)($decoded['usage']['input_tokens'] ?? 0) + (int)($decoded['usage']['output_tokens'] ?? 0);
        $this->pdo->prepare("UPDATE rooms SET tokens_burned_today = tokens_burned_today + ? WHERE room_id = 'MAIN'")->execute([$used]);
        $this->insertSystemMessage('CLAUDE', 'SYSTEM', mb_substr($replyText, 0, 8000));
    }

    private function findMember(string $nick): ?array
    {
        $stmt = $this->pdo->prepare("
            SELECT u.id, u.display_nick, u.elo FROM users u
            JOIN room_members rm ON rm.user_id = u.id
            WHERE rm.room_id = 'MAIN' AND rm.banned = 0 AND u.display_nick = ? COLLATE NOCASE
        ");
        $stmt->execute([ltrim(Security::text($nick, 40), '@')]);
        return $stmt->fetch() ?: null;
    }

    private function chessInvite(array $user, array $in): array
    {
        $userId = (int)$user['id'];
        $opponent = $this->findMember((string)($in['target_nick'] ?? ''));
        if (!$opponent || (int)$opponent['id'] === $userId) {
            throw new ApiException('Target operator not found on this server.');
        }
        $oppId = (int)$opponent['id'];
        $cfg = $this->settings();
        if (!$cfg['games_enabled']) {
            throw new ApiException('Games are disabled on this server.', 403, 'GAMES_DISABLED');
        }
        $stake = max(0, (int)($in['stake'] ?? 0));
        if ($stake > 0) {
            if (!$cfg['chess_stakes']) {
                throw new ApiException('Chess stakes are disabled on this server.', 403, 'STAKES_DISABLED');
            }
            $this->readStake(['stake' => $stake], $userId);
        }

        $gameId = $this->tx(function () use ($user, $userId, $opponent, $oppId, $stake): int {
            $chk = $this->pdo->prepare('
                SELECT id FROM chess_games
                WHERE room_id = \'MAIN\' AND status IN (\'INVITED\', \'ACTIVE\')
                  AND ((white_user_id = ? AND black_user_id = ?) OR (white_user_id = ? AND black_user_id = ?))
            ');
            $chk->execute([$userId, $oppId, $oppId, $userId]);
            if ($chk->fetchColumn()) {
                throw new ApiException('A chess match with this operator is already active or awaiting acceptance.', 409, 'CONFLICT');
            }
            if ($stake > 0) {
                $this->debit($userId, $stake); // escrow, refunded on decline/expiry
            }
            $this->pdo->prepare('
                INSERT INTO chess_games (room_id, white_user_id, black_user_id, status, fen, updated_at, stake)
                VALUES (\'MAIN\', ?, ?, \'INVITED\', ?, ?, ?)
            ')->execute([$userId, $oppId, Chess::START, time(), $stake]);
            $id = (int)$this->pdo->lastInsertId();
            $this->logGame($userId, 'chess');
            $this->insertSystemMessage('ARENA', 'CHESS_EVENT', sprintf(
                '⚔️ %s [%d ELO] challenged @%s [%d ELO] to a rated Chess match' . ($stake > 0 ? " for {$stake} pts (opponent must match)" : '') . '! Type /accept %s to begin or /decline %s.',
                $user['display_nick'],
                (int)$user['elo'],
                $opponent['display_nick'],
                (int)$opponent['elo'],
                $user['display_nick'],
                $user['display_nick']
            ), [$stake > 0 ? 'chessChallengeStake' : 'chessChallenge', ['from' => $user['display_nick'], 'fromElo' => (int)$user['elo'], 'to' => $opponent['display_nick'], 'toElo' => (int)$opponent['elo'], 'stake' => $stake]]);
            return $id;
        });

        return ['ok' => true, 'game_id' => $gameId];
    }

    private function chessAccept(array $user, array $in): array
    {
        $userId = (int)$user['id'];
        if (!$this->settings()['games_enabled']) {
            throw new ApiException('Games are disabled on this server.', 403, 'GAMES_DISABLED');
        }
        $challengerNick = ltrim(Security::text($in['challenger_nick'] ?? '', 40), '@');
        $gameId = (int)($in['game_id'] ?? 0);

        return $this->tx(function () use ($user, $userId, $challengerNick, $gameId): array {
            $stmt = $this->pdo->prepare('
                SELECT cg.id, cg.stake, cg.fen, cg.status, cg.white_user_id, u.display_nick, u.elo
                FROM chess_games cg
                JOIN users u ON u.id = cg.white_user_id
                WHERE cg.room_id = \'MAIN\' AND cg.black_user_id = ? AND cg.status IN (\'INVITED\', \'TAKEN\')
                  AND (cg.id = ? OR u.display_nick = ? COLLATE NOCASE)
                ORDER BY (cg.status = \'INVITED\') DESC, cg.id DESC
            ');
            $stmt->execute([$userId, $gameId, $challengerNick]);
            $game = $stmt->fetch();
            if (!$game) {
                throw new ApiException('No pending chess challenge found from that operator.');
            }
            if ($game['status'] === 'TAKEN') {
                throw new ApiException("Sorry — {$game['display_nick']} is already playing with someone else.", 409, 'PLAYER_BUSY');
            }
            $whiteId = (int)$game['white_user_id'];
            $busy = $this->pdo->prepare("SELECT COUNT(*) FROM chess_games WHERE room_id = 'MAIN' AND status = 'ACTIVE' AND (white_user_id IN (?, ?) OR black_user_id IN (?, ?))");
            $busy->execute([$whiteId, $userId, $whiteId, $userId]);
            if ((int)$busy->fetchColumn() > 0) {
                throw new ApiException("Sorry — {$game['display_nick']} or you are already in a game.", 409, 'PLAYER_BUSY');
            }
            $upd = $this->pdo->prepare("UPDATE chess_games SET status = 'ACTIVE', history = ?, updated_at = ? WHERE id = ? AND status = 'INVITED'");
            $upd->execute([json_encode([Chess::key(Chess::parse((string)$game['fen']))]), time(), (int)$game['id']]);
            if ($upd->rowCount() !== 1) {
                throw new ApiException('Challenge is no longer pending.', 409, 'CONFLICT');
            }
            $stake = (int)$game['stake'];
            if ($stake > 0) {
                $this->debit($userId, $stake);
            }
            $this->logGame($userId, 'chess');
            // First accept wins: the inviter's other open challenges are withdrawn and their stakes refunded
            $others = $this->pdo->prepare("SELECT cg.id, cg.stake, u.display_nick FROM chess_games cg JOIN users u ON u.id = cg.black_user_id WHERE cg.room_id = 'MAIN' AND cg.white_user_id = ? AND cg.status = 'INVITED' AND cg.id != ?");
            $others->execute([$whiteId, (int)$game['id']]);
            foreach ($others->fetchAll() as $o) {
                $this->pdo->prepare("UPDATE chess_games SET status = 'TAKEN', updated_at = ? WHERE id = ? AND status = 'INVITED'")->execute([time(), (int)$o['id']]);
                $this->addPoints($whiteId, (int)$o['stake']);
                $this->insertSystemMessage('ARENA', 'CHESS_EVENT', sprintf("♟️ %s's challenge to %s was withdrawn — %s accepted first.", $game['display_nick'], $o['display_nick'], $user['display_nick']), ['chessTaken', ['from' => $game['display_nick'], 'to' => $o['display_nick'], 'by' => $user['display_nick']]]);
            }
            $this->insertSystemMessage('ARENA', 'CHESS_EVENT', sprintf(
                '♟️ Rated Match Started: %s (White, %d ELO) vs %s (Black, %d ELO)!',
                $game['display_nick'],
                (int)$game['elo'],
                $user['display_nick'],
                (int)$user['elo']
            ), ['chessStarted', ['white' => $game['display_nick'], 'whiteElo' => (int)$game['elo'], 'black' => $user['display_nick'], 'blackElo' => (int)$user['elo']]]);
            return ['ok' => true, 'game_id' => (int)$game['id']];
        });
    }

    /** Server-authoritative move: {game_id, from, to, promotion?} or {game_id, resign:true}. */
    private function chessMove(array $user, array $in): array
    {
        $userId = (int)$user['id'];
        $gameId = (int)($in['game_id'] ?? 0);

        return $this->tx(function () use ($userId, $gameId, $in): array {
            $stmt = $this->pdo->prepare('
                SELECT * FROM chess_games
                WHERE id = ? AND room_id = \'MAIN\' AND status = \'ACTIVE\'
                  AND (white_user_id = ? OR black_user_id = ?)
            ');
            $stmt->execute([$gameId, $userId, $userId]);
            $game = $stmt->fetch();
            if (!$game) {
                throw new ApiException('Active chess session not found.', 404, 'NOT_FOUND');
            }
            $isWhite = (int)$game['white_user_id'] === $userId;
            $oppId = $isWhite ? (int)$game['black_user_id'] : (int)$game['white_user_id'];

            if (!empty($in['resign'])) {
                $this->chessFinish($game, $oppId, 'resignation');
                return ['ok' => true, 'fen' => $game['fen'], 'last_move' => $game['last_move'], 'game_over' => true, 'outcome' => 'resignation', 'winner_id' => $oppId];
            }

            $pos = Chess::parse((string)$game['fen']);
            if (($pos['turn'] === 'w') !== $isWhite) {
                throw new ApiException('Not your turn.', 409, 'NOT_YOUR_TURN');
            }
            $from = Chess::sq(is_string($in['from'] ?? null) ? $in['from'] : '');
            $to = Chess::sq(is_string($in['to'] ?? null) ? $in['to'] : '');
            $promo = strtolower(is_string($in['promotion'] ?? null) ? $in['promotion'] : '');
            if ($from < 0 || $to < 0 || ($promo !== '' && !in_array($promo, ['q', 'r', 'b', 'n'], true))) {
                throw new ApiException('Move must be squares like from "e2" to "e4", promotion q|r|b|n.');
            }
            $move = null;
            foreach (Chess::legal($pos) as $m) {
                if ($m[0] === $from && $m[1] === $to && ($m[2] === '' || $m[2] === ($promo ?: 'q'))) {
                    $move = $m;
                    break;
                }
            }
            if ($move === null) {
                throw new ApiException('Illegal move.', 400, 'ILLEGAL_MOVE');
            }

            $next = Chess::make($pos, $move);
            $history = json_decode((string)$game['history'], true) ?: [Chess::key($pos)];
            $history = array_slice([...$history, Chess::key($next)], -150);
            $fen = Chess::fen($next);
            $uci = Chess::name($from) . Chess::name($to) . $move[2];

            $upd = $this->pdo->prepare("UPDATE chess_games SET fen = ?, last_move = ?, history = ?, updated_at = ? WHERE id = ? AND status = 'ACTIVE' AND fen = ?");
            $upd->execute([$fen, $uci, json_encode($history), time(), $gameId, $game['fen']]);
            if ($upd->rowCount() !== 1) {
                throw new ApiException('Game changed, try again.', 409, 'CONFLICT');
            }

            $outcome = Chess::outcome($next, $history);
            $winner = null;
            if ($outcome !== '') {
                $winner = $outcome === 'checkmate' ? $userId : 0;
                $this->chessFinish(['fen' => $fen, 'last_move' => $uci] + $game, $winner, $outcome);
            }
            return [
                'ok' => true, 'fen' => $fen, 'last_move' => $uci, 'game_over' => $outcome !== '',
                'outcome' => $outcome ?: null, 'winner_id' => $winner ?: null,
            ];
        });
    }

    /** Ends an ACTIVE game (winner 0 = draw): ELO, payout, banner. Must run inside tx(). */
    private function chessFinish(array $game, int $winnerId, string $reason): void
    {
        $fin = $this->pdo->prepare("UPDATE chess_games SET status = 'FINISHED', winner_user_id = ?, updated_at = ? WHERE id = ? AND status = 'ACTIVE'");
        $fin->execute([$winnerId, time(), (int)$game['id']]);
        if ($fin->rowCount() !== 1) {
            throw new ApiException('Game already finished.', 409, 'CONFLICT');
        }
        $wId = (int)$game['white_user_id'];
        $bId = (int)$game['black_user_id'];
        $players = [$wId => $this->loadUser($wId), $bId => $this->loadUser($bId)];
        $whiteScore = $winnerId === $wId ? 1.0 : ($winnerId === $bId ? 0.0 : 0.5);
        [$newWhiteElo, $newBlackElo] = EloEngine::compute((int)$players[$wId]['elo'], (int)$players[$bId]['elo'], $whiteScore);
        $this->pdo->prepare('UPDATE users SET elo = ? WHERE id = ?')->execute([$newWhiteElo, $wId]);
        $this->pdo->prepare('UPDATE users SET elo = ? WHERE id = ?')->execute([$newBlackElo, $bId]);

        $diffW = $newWhiteElo - (int)$players[$wId]['elo'];
        $diffB = $newBlackElo - (int)$players[$bId]['elo'];

        // Points: winner takes both stakes + 25 + 2x ELO gained; draw refunds stakes + 10 each
        $stake = (int)$game['stake'];
        if ($winnerId > 0) {
            $prize = 2 * $stake + 25 + 2 * max(0, $winnerId === $wId ? $diffW : $diffB);
            $this->addPoints($winnerId, $prize);
            $ptsNote = " | +{$prize} pts";
            $ptsKey = ['pts' => $prize, 'each' => false];
        } else {
            $this->addPoints($wId, $stake + 10);
            $this->addPoints($bId, $stake + 10);
            $ptsNote = ' | +' . ($stake + 10) . ' pts each';
            $ptsKey = ['pts' => $stake + 10, 'each' => true];
        }
        $fmtW = ($diffW >= 0 ? '+' : '') . $diffW;
        $fmtB = ($diffB >= 0 ? '+' : '') . $diffB;

        if ($winnerId > 0) {
            $loserId = $winnerId === $wId ? $bId : $wId;
            $i18n = ['chessWin', $ptsKey + [
                'reason' => $reason,
                'winner' => $players[$winnerId]['display_nick'], 'loser' => $players[$loserId]['display_nick'],
                'winnerElo' => $winnerId === $wId ? $newWhiteElo : $newBlackElo, 'winnerDiff' => $winnerId === $wId ? $fmtW : $fmtB,
                'loserElo' => $loserId === $wId ? $newWhiteElo : $newBlackElo, 'loserDiff' => $loserId === $wId ? $fmtW : $fmtB,
            ]];
            $banner = sprintf(
                '♟️ %s // %s defeated %s! Rating update: %s -> %d ELO (%s) | %s -> %d ELO (%s)',
                strtoupper($reason),
                $players[$winnerId]['display_nick'],
                $players[$loserId]['display_nick'],
                $players[$winnerId]['display_nick'],
                $winnerId === $wId ? $newWhiteElo : $newBlackElo,
                $winnerId === $wId ? $fmtW : $fmtB,
                $players[$loserId]['display_nick'],
                $loserId === $wId ? $newWhiteElo : $newBlackElo,
                $loserId === $wId ? $fmtW : $fmtB
            );
        } else {
            $i18n = ['chessDraw', $ptsKey + [
                'reason' => $reason,
                'white' => $players[$wId]['display_nick'], 'whiteElo' => $newWhiteElo, 'whiteDiff' => $fmtW,
                'black' => $players[$bId]['display_nick'], 'blackElo' => $newBlackElo, 'blackDiff' => $fmtB,
            ]];
            $banner = sprintf(
                '♟️ DRAW (%s) // %s [%d ELO (%s)] and %s [%d ELO (%s)]',
                $reason,
                $players[$wId]['display_nick'],
                $newWhiteElo,
                $fmtW,
                $players[$bId]['display_nick'],
                $newBlackElo,
                $fmtB
            );
        }
        $this->insertSystemMessage('ARENA', 'CHESS_EVENT', $banner . $ptsNote, $i18n);
    }

    private function chessDecline(array $user, array $in): array
    {
        $userId = (int)$user['id'];
        $nick = ltrim(Security::text($in['nick'] ?? '', 40), '@');
        $gameId = (int)($in['game_id'] ?? 0);

        $this->tx(function () use ($userId, $nick, $gameId): void {
            $stmt = $this->pdo->prepare('
                SELECT cg.*, w.display_nick AS white_nick, b.display_nick AS black_nick FROM chess_games cg
                JOIN users w ON w.id = cg.white_user_id
                JOIN users b ON b.id = cg.black_user_id
                WHERE cg.room_id = \'MAIN\' AND cg.status = \'INVITED\'
                  AND ((cg.black_user_id = ? AND (cg.id = ? OR w.display_nick = ? COLLATE NOCASE))
                    OR (cg.white_user_id = ? AND (cg.id = ? OR b.display_nick = ? COLLATE NOCASE)))
            ');
            $stmt->execute([$userId, $gameId, $nick, $userId, $gameId, $nick]);
            $game = $stmt->fetch();
            if (!$game || !$this->cancelChessInvite($game)) {
                throw new ApiException('No pending chess challenge with that operator.');
            }
            $this->insertSystemMessage('ARENA', 'CHESS_EVENT', "♟️ Challenge between {$game['white_nick']} and {$game['black_nick']} was withdrawn. Stake refunded.", ['chessWithdrawn', ['white' => $game['white_nick'], 'black' => $game['black_nick']]]);
        });

        return ['ok' => true];
    }

    private function cancelChessInvite(array $game): bool
    {
        $upd = $this->pdo->prepare("UPDATE chess_games SET status = 'CANCELLED', updated_at = ? WHERE id = ? AND status = 'INVITED'");
        $upd->execute([time(), (int)$game['id']]);
        if ($upd->rowCount() !== 1) {
            return false;
        }
        $this->addPoints((int)$game['white_user_id'], (int)$game['stake']);
        return true;
    }

    private function expireStaleChess(): void
    {
        // Invites expire after 24h (stake refunded); the side to move loses after move_timeout_hours without moving
        $now = time();
        $old = $this->pdo->prepare("SELECT * FROM chess_games WHERE status = 'INVITED' AND updated_at < ?");
        $old->execute([$now - 86400]);
        foreach ($old->fetchAll() as $g) {
            $this->tx(fn() => $this->cancelChessInvite($g));
        }
        $dead = $this->pdo->prepare("SELECT * FROM chess_games WHERE status = 'ACTIVE' AND updated_at < ?");
        $dead->execute([$now - $this->settings()['move_timeout_hours'] * 3600]);
        foreach ($dead->fetchAll() as $g) {
            try {
                $this->tx(function () use ($g): void {
                    try {
                        $turn = Chess::parse((string)$g['fen'])['turn'];
                    } catch (ApiException) {
                        $turn = 'w';
                    }
                    $this->chessFinish($g, $turn === 'w' ? (int)$g['black_user_id'] : (int)$g['white_user_id'], 'timeout');
                });
            } catch (ApiException) {
                // already finished by a concurrent request
            }
        }
    }

    private function admin(array $user, array $member, array $in): array
    {
        if (!in_array($member['role'], ['owner', 'admin'], true)) {
            throw new ApiException('Admins only.', 403, 'FORBIDDEN');
        }
        $userId = (int)$user['id'];
        $isOwner = $member['role'] === 'owner';
        $op = (string)($in['op'] ?? '');

        if ($op === 'banned') {
            return $this->adminBanned($member);
        }
        if ($op === 'settings') {
            $new = is_array($in['settings'] ?? null) ? array_merge($in, $in['settings']) : $in;
            $cur = $this->settings();
            foreach (['games_enabled', 'chess_stakes', 'registration_open'] as $b) {
                if (array_key_exists($b, $new)) {
                    $cur[$b] = (bool)$new[$b];
                }
            }
            $ranges = ['max_stake' => [10, 1000000], 'slow_mode' => [0, 600], 'spins_5h' => [0, 10000], 'spins_week' => [0, 100000],
                'claude_daily_tokens' => [0, 100000000], 'move_timeout_hours' => [1, 336]];
            foreach ($ranges as $k => [$lo, $hi]) {
                if (array_key_exists($k, $new)) {
                    $cur[$k] = max($lo, min($hi, (int)$new[$k]));
                }
            }
            $this->setMeta('settings', (string)json_encode($cur));
            if (array_key_exists('name', $new)) {
                $name = Security::text($new['name'], 40);
                if ($name === '') {
                    throw new ApiException('Server name cannot be empty.');
                }
                $this->setMeta('name', $name);
            }
            if (array_key_exists('motd', $new)) {
                $this->setMeta('motd', Security::text($new['motd'], 280));
            }
            if (array_key_exists('join_key', $new)) {
                $jk = is_string($new['join_key']) ? $new['join_key'] : '';
                if ($jk !== '' && (strlen($jk) < 4 || strlen($jk) > 128)) {
                    throw new ApiException('Join key must be 4-128 characters (empty to remove).');
                }
                $this->setMeta('join_key_hash', $jk === '' ? '' : Security::hashPassword($jk));
            }
            if (array_key_exists('anthropic_key', $new)) {
                $ak = is_string($new['anthropic_key']) ? trim($new['anthropic_key']) : '';
                if ($ak !== '' && (!str_starts_with($ak, 'sk-ant-') || strlen($ak) > 256 || !preg_match('/^[A-Za-z0-9_-]+$/', $ak))) {
                    throw new ApiException('Invalid Anthropic API key format.');
                }
                $this->setMeta('anthropic_key_enc', $ak === '' ? '' : Crypto::encrypt($ak));
            }
            $this->insertSystemMessage('ADMIN', 'SYSTEM', "{$user['display_nick']} updated server settings.", ['settingsUpdated', ['nick' => $user['display_nick']]]);
            return ['ok' => true, 'settings' => $cur];
        }

        $targetId = (int)($in['target_user_id'] ?? 0);
        $t = $this->pdo->prepare("SELECT rm.role, u.display_nick FROM room_members rm JOIN users u ON u.id = rm.user_id WHERE rm.room_id = 'MAIN' AND rm.user_id = ?");
        $t->execute([$targetId]);
        $target = $t->fetch();
        $selfGrant = $op === 'grant_points' && $isOwner;
        if (!$target || ($targetId === $userId && !$selfGrant)) {
            throw new ApiException('Invalid target.');
        }
        // Admins may only act on members; the owner may act on anyone
        if (!$isOwner && $target['role'] !== 'member') {
            throw new ApiException('Only the owner can moderate admins.', 403, 'FORBIDDEN');
        }
        $nick = $target['display_nick'];
        $upd = fn(string $sql, array $args) => $this->pdo->prepare($sql)->execute($args);
        $ownerOnly = function () use ($isOwner): void {
            if (!$isOwner) {
                throw new ApiException('Only the owner can do that.', 403, 'FORBIDDEN');
            }
        };

        switch ($op) {
            case 'promote':
            case 'demote':
                $ownerOnly();
                $upd("UPDATE room_members SET role = ? WHERE room_id = 'MAIN' AND user_id = ?", [$op === 'promote' ? 'admin' : 'member', $targetId]);
                $msg = $op === 'promote' ? "{$nick} is now an admin." : "{$nick} is no longer an admin.";
                $i18n = [$op === 'promote' ? 'adminPromoted' : 'adminDemoted', ['nick' => $nick]];
                break;
            case 'transfer':
                $ownerOnly();
                $upd("UPDATE room_members SET role = 'admin' WHERE room_id = 'MAIN' AND user_id = ?", [$userId]);
                $upd("UPDATE room_members SET role = 'owner', banned = 0 WHERE room_id = 'MAIN' AND user_id = ?", [$targetId]);
                $upd("UPDATE rooms SET owner_id = ? WHERE room_id = 'MAIN'", [$targetId]);
                $this->setMeta('owner_user_id', (string)$targetId);
                $msg = "{$nick} is the new server owner.";
                $i18n = ['adminOwner', ['nick' => $nick]];
                break;
            case 'mute':
                $mins = max(1, min(10080, (int)($in['minutes'] ?? 10)));
                $upd("UPDATE room_members SET muted_until = ? WHERE room_id = 'MAIN' AND user_id = ?", [time() + $mins * 60, $targetId]);
                $msg = "{$nick} was muted for {$mins} min.";
                $i18n = ['adminMuted', ['nick' => $nick, 'min' => $mins]];
                break;
            case 'unmute':
                $upd("UPDATE room_members SET muted_until = 0 WHERE room_id = 'MAIN' AND user_id = ?", [$targetId]);
                $msg = "{$nick} was unmuted.";
                $i18n = ['adminUnmuted', ['nick' => $nick]];
                break;
            case 'kick':
                $upd("DELETE FROM room_members WHERE room_id = 'MAIN' AND user_id = ?", [$targetId]);
                $upd('UPDATE users SET token_sha256 = NULL WHERE id = ?', [$targetId]);
                $msg = "{$nick} was kicked.";
                $i18n = ['adminKicked', ['nick' => $nick]];
                break;
            case 'ban':
                $upd("UPDATE room_members SET banned = 1, role = 'member' WHERE room_id = 'MAIN' AND user_id = ?", [$targetId]);
                $upd('UPDATE users SET token_sha256 = NULL WHERE id = ?', [$targetId]);
                $msg = "{$nick} was banned.";
                $i18n = ['adminBanned', ['nick' => $nick]];
                break;
            case 'unban':
                $upd("UPDATE room_members SET banned = 0 WHERE room_id = 'MAIN' AND user_id = ?", [$targetId]);
                $msg = "{$nick} was unbanned.";
                $i18n = ['adminUnbanned', ['nick' => $nick]];
                break;
            case 'grant_points':
                $ownerOnly();
                $amount = max(-1000000, min(1000000, (int)($in['amount'] ?? 0)));
                $this->addPoints($targetId, $amount);
                return ['ok' => true, 'points' => $this->userPoints($targetId)];
            default:
                throw new ApiException('Unknown admin operation.');
        }

        $this->bumpRev();
        $this->insertSystemMessage('ADMIN', 'SYSTEM', "[{$user['display_nick']}] {$msg}", [$i18n[0], $i18n[1] + ['by' => $user['display_nick']]]);
        return ['ok' => true];
    }

    /** Member-to-member gift: atomic, never overdraws, announced in chat. */
    private function transferPoints(array $user, array $member, array $in): array
    {
        $userId = (int)$user['id'];
        Security::enforceRateLimit($this->pdo, 'transfer', 10, 60, 'u:' . $userId);
        if ((int)$member['muted_until'] > time()) {
            throw new ApiException('You are muted.', 403, 'MUTED');
        }
        $targetId = (int)($in['target_user_id'] ?? 0);
        $amount = (int)($in['amount'] ?? 0);
        if ($amount < 1 || $amount > 1000000) {
            throw new ApiException('Amount must be between 1 and 1000000 points.');
        }
        if ($targetId === $userId) {
            throw new ApiException('You cannot send points to yourself.');
        }
        $t = $this->pdo->prepare("SELECT u.display_nick FROM room_members rm JOIN users u ON u.id = rm.user_id
            WHERE rm.room_id = 'MAIN' AND rm.user_id = ? AND rm.banned = 0");
        $t->execute([$targetId]);
        $nick = $t->fetchColumn();
        if ($nick === false) {
            throw new ApiException('Invalid target.');
        }

        $this->tx(function () use ($userId, $targetId, $amount): void {
            $this->debit($userId, $amount);
            $this->addPoints($targetId, $amount);
        });
        $this->insertSystemMessage('POINTS', 'SYSTEM', sprintf('%s sent %d pts to %s.', $user['display_nick'], $amount, $nick), ['pointsSent', ['from' => $user['display_nick'], 'n' => $amount, 'to' => $nick]]);

        return ['ok' => true, 'points' => $this->userPoints($userId)];
    }

    private function adminBanned(array $member): array
    {
        if (!in_array($member['role'], ['owner', 'admin'], true)) {
            throw new ApiException('Admins only.', 403, 'FORBIDDEN');
        }
        $rows = $this->pdo->query("SELECT u.id AS user_id, u.display_nick FROM room_members rm JOIN users u ON u.id = rm.user_id WHERE rm.room_id = 'MAIN' AND rm.banned = 1 ORDER BY u.display_nick")->fetchAll();
        return ['ok' => true, 'items' => array_map(fn($r) => ['user_id' => (int)$r['user_id'], 'display_nick' => (string)$r['display_nick']], $rows)];
    }

    // ---------------------------------------------------------------- points & casino

    private function userPoints(int $userId): int
    {
        $stmt = $this->pdo->prepare('SELECT points FROM users WHERE id = ?');
        $stmt->execute([$userId]);
        return (int)$stmt->fetchColumn();
    }

    private function readStake(array $in, int $userId): int
    {
        $bet = (int)($in['bet'] ?? $in['stake'] ?? 0);
        $cfg = $this->settings();
        if (!$cfg['games_enabled']) {
            throw new ApiException('Games are disabled on this server.', 403, 'GAMES_DISABLED');
        }
        $max = $cfg['max_stake'];
        if ($bet < 10 || $bet > $max) {
            throw new ApiException("Stake must be between 10 and {$max} points.");
        }
        if ($this->userPoints($userId) < $bet) {
            throw new ApiException('Not enough points.', 400, 'NO_POINTS');
        }
        return $bet;
    }

    /** Atomic debit: fails instead of overdrawing when two requests race. */
    private function debit(int $userId, int $amount): void
    {
        $stmt = $this->pdo->prepare('UPDATE users SET points = points - ? WHERE id = ? AND points >= ?');
        $stmt->execute([$amount, $userId, $amount]);
        if ($stmt->rowCount() !== 1) {
            throw new ApiException('Not enough points.', 400, 'NO_POINTS');
        }
        if ($amount !== 0) {
            $this->bumpRev();
        }
    }

    private function addPoints(int $userId, int $delta): void
    {
        if ($delta === 0) {
            return;
        }
        // Balance never goes negative
        $this->pdo->prepare('UPDATE users SET points = MAX(0, points + ?) WHERE id = ?')->execute([$delta, $userId]);
        $this->bumpRev();
    }

    private function logGame(int $userId, string $kind): void
    {
        $this->pdo->prepare('INSERT INTO game_log (user_id, kind, ts) VALUES (?, ?, ?)')->execute([$userId, $kind, time()]);
    }

    /** Rolling-window spin quotas from game_log; returns counts plus the oldest spin of each window. */
    private function spinLimits(int $userId, array $settings): array
    {
        $now = time();
        $res = ['out' => []];
        foreach (['5h' => [5 * 3600, $settings['spins_5h']], 'week' => [7 * 86400, $settings['spins_week']]] as $k => [$win, $cap]) {
            $stmt = $this->pdo->prepare("SELECT COUNT(*) AS n, MIN(ts) AS oldest FROM game_log WHERE user_id = ? AND kind = 'spin' AND ts > ?");
            $stmt->execute([$userId, $now - $win]);
            $r = $stmt->fetch();
            $res[$k] = ['used' => (int)$r['n'], 'cap' => (int)$cap, 'frees_at' => (int)$r['oldest'] + $win];
            $res['out']["spins_{$k}_left"] = max(0, (int)$cap - (int)$r['n']);
        }
        return $res;
    }

    private function weightedPick(array $table): array
    {
        $total = array_sum(array_column($table, 1));
        $roll = random_int(1, $total);
        foreach ($table as $row) {
            $roll -= $row[1];
            if ($roll <= 0) {
                return $row;
            }
        }
        return $table[0];
    }

    private function gameSpin(array $user, array $in): array
    {
        $userId = (int)$user['id'];
        $kind = (string)($in['kind'] ?? '');
        $choice = (string)($in['choice'] ?? 'red');
        if (!in_array($kind, ['roulette', 'case'], true)) {
            throw new ApiException('Unknown game.');
        }
        if ($kind === 'roulette' && !in_array($choice, ['red', 'black', 'green'], true)) {
            throw new ApiException('Choice must be red, black or green.');
        }

        return $this->tx(function () use ($user, $userId, $in, $kind, $choice): array {
            $bet = $this->readStake($in, $userId);
            $lim = $this->spinLimits($userId, $this->settings());
            foreach (['5h' => '5 hours', 'week' => '7 days'] as $k => $label) {
                if ($lim[$k]['cap'] === 0) {
                    throw new ApiException('Spins are disabled on this server.', 429, 'SPIN_LIMIT');
                }
                if ($lim[$k]['used'] >= $lim[$k]['cap']) {
                    $at = $lim[$k]['frees_at'];
                    $mins = max(1, (int)ceil(($at - time()) / 60));
                    throw new ApiException(sprintf(
                        'Spin limit reached (%d per %s). Next spin available at %s (in %s).',
                        $lim[$k]['cap'],
                        $label,
                        date($k === 'week' ? 'D d/m H:i' : 'H:i', $at),
                        $mins >= 120 ? round($mins / 60, 1) . ' h' : "{$mins} min"
                    ), 429, 'SPIN_LIMIT');
                }
            }

            if ($kind === 'roulette') {
                $n = random_int(0, 36);
                $color = $n === 0 ? 'green' : ($n % 2 === 1 ? 'red' : 'black');
                $mult = $color === $choice ? ($choice === 'green' ? 14 : 2) : 0;
                $label = "{$n} {$color}";
            } else {
                [$mult, ] = $this->weightedPick(self::CASE_TABLE);
                $label = ($mult < 0 ? '-x' . abs($mult) : 'x' . $mult);
            }

            $this->debit($userId, $bet);
            $this->logGame($userId, 'spin');
            $payout = $mult >= 0 ? (int)floor($bet * $mult) : (int)($bet * $mult);
            $delta = $payout - $bet;
            $this->addPoints($userId, $payout);

            if ($mult >= 10 || $mult <= -2) {
                $verb = $mult > 0 ? 'HIT' : 'BUSTED';
                $this->insertSystemMessage('CASINO', 'SYSTEM', sprintf('[%s] %s %s %s on %d pts (%+d)', strtoupper($kind), $user['display_nick'], $verb, $label, $bet, $delta),
                    [$mult > 0 ? 'casinoHit' : 'casinoBust', ['game' => strtoupper($kind), 'nick' => $user['display_nick'], 'result' => $label, 'bet' => $bet, 'delta' => sprintf('%+d', $delta)]]);
            }

            return [
                'ok' => true, 'kind' => $kind, 'result' => $label, 'mult' => $mult, 'delta' => $delta,
                'points' => $this->userPoints($userId), 'game_limits' => $this->spinLimits($userId, $this->settings())['out'],
            ];
        });
    }

    private function listDuels(): array
    {
        $stmt = $this->pdo->prepare("SELECT * FROM duels WHERE room_id = 'MAIN' AND (status = 'OPEN' OR created_ts > ?) ORDER BY id DESC LIMIT 12");
        $stmt->execute([time() - 600]);
        $rows = $stmt->fetchAll();
        foreach ($rows as &$r) {
            $r['players'] = json_decode((string)$r['players'], true) ?: [];
            $r['result'] = json_decode((string)$r['result'], true) ?: null;
        }
        unset($r);
        return $rows;
    }

    private function loadDuel(int $id): array
    {
        $stmt = $this->pdo->prepare("SELECT * FROM duels WHERE id = ? AND room_id = 'MAIN'");
        $stmt->execute([$id]);
        $duel = $stmt->fetch();
        if (!$duel) {
            throw new ApiException('Duel not found.', 404, 'NOT_FOUND');
        }
        return $duel;
    }

    private function duelCreate(array $user, array $in): array
    {
        $userId = (int)$user['id'];
        $max = max(2, min(8, (int)($in['max_players'] ?? 2)));

        $duelId = $this->tx(function () use ($user, $userId, $in, $max): int {
            $stake = $this->readStake($in, $userId);
            $this->debit($userId, $stake);
            $players = [['id' => $userId, 'nick' => $user['display_nick']]];
            $this->pdo->prepare("INSERT INTO duels (room_id, creator_id, stake, max_players, players, created_ts) VALUES ('MAIN', ?, ?, ?, ?, ?)")
                ->execute([$userId, $stake, $max, json_encode($players), time()]);
            $id = (int)$this->pdo->lastInsertId();
            $this->logGame($userId, 'duel');
            $this->insertSystemMessage('CASINO', 'SYSTEM', sprintf('[DICE] %s opened a %d-player duel for %d pts. Join from the ARCADE tab!', $user['display_nick'], $max, $stake), ['diceOpen', ['nick' => $user['display_nick'], 'n' => $max, 'stake' => $stake]]);
            return $id;
        });

        return ['ok' => true, 'duel_id' => $duelId, 'points' => $this->userPoints($userId)];
    }

    private function duelJoin(array $user, array $in): array
    {
        $userId = (int)$user['id'];
        if (!$this->settings()['games_enabled']) {
            throw new ApiException('Games are disabled on this server.', 403, 'GAMES_DISABLED');
        }

        $this->tx(function () use ($user, $userId, $in): void {
            $duel = $this->loadDuel((int)($in['duel_id'] ?? 0));
            $players = json_decode((string)$duel['players'], true) ?: [];
            if ($duel['status'] !== 'OPEN') {
                throw new ApiException('Duel already closed.');
            }
            if (in_array($userId, array_column($players, 'id'), true)) {
                throw new ApiException('You already joined this duel.');
            }
            $stake = (int)$duel['stake'];
            $this->debit($userId, $stake);
            $players[] = ['id' => $userId, 'nick' => $user['display_nick']];

            $status = 'OPEN';
            $result = '';
            if (count($players) >= (int)$duel['max_players']) {
                // Everyone rolls 1-100; ties at the top re-roll among themselves
                $contenders = $players;
                do {
                    foreach ($contenders as &$c) {
                        $c['roll'] = random_int(1, 100);
                    }
                    unset($c);
                    $best = max(array_column($contenders, 'roll'));
                    $top = array_values(array_filter($contenders, fn($c) => $c['roll'] === $best));
                    $rolls = $contenders;
                    $contenders = $top;
                } while (count($top) > 1);

                $pot = $stake * count($players);
                $winner = $top[0];
                $this->addPoints((int)$winner['id'], $pot);
                $status = 'DONE';
                $result = json_encode(['winner' => $winner, 'rolls' => $rolls, 'pot' => $pot]);
                $line = implode(' | ', array_map(fn($r) => $r['nick'] . ':' . $r['roll'], $rolls));
                $this->insertSystemMessage('CASINO', 'SYSTEM', sprintf('[DICE] %s -> %s wins the %d pts pot!', $line, $winner['nick'], $pot), ['diceWin', ['rolls' => $line, 'nick' => $winner['nick'], 'pot' => $pot]]);
            }

            $upd = $this->pdo->prepare("UPDATE duels SET players = ?, status = ?, result = ? WHERE id = ? AND status = 'OPEN' AND players = ?");
            $upd->execute([json_encode($players), $status, $result, (int)$duel['id'], $duel['players']]);
            if ($upd->rowCount() !== 1) {
                throw new ApiException('Duel changed, try again.', 409, 'CONFLICT');
            }
            $this->logGame($userId, 'duel');
        });

        return ['ok' => true, 'points' => $this->userPoints($userId)];
    }

    private function duelCancel(array $user, array $in): array
    {
        $userId = (int)$user['id'];
        $this->tx(function () use ($userId, $in): void {
            $duel = $this->loadDuel((int)($in['duel_id'] ?? 0));
            if ((int)$duel['creator_id'] !== $userId || $duel['status'] !== 'OPEN') {
                throw new ApiException('Only the creator can cancel an open duel.', 403, 'FORBIDDEN');
            }
            $upd = $this->pdo->prepare("UPDATE duels SET status = 'CANCELLED' WHERE id = ? AND status = 'OPEN'");
            $upd->execute([(int)$duel['id']]);
            if ($upd->rowCount() === 1) {
                foreach (json_decode((string)$duel['players'], true) ?: [] as $p) {
                    $this->addPoints((int)$p['id'], (int)$duel['stake']);
                }
            }
        });

        return ['ok' => true, 'points' => $this->userPoints($userId)];
    }

    private function bsLoad(int $gameId, int $userId, array $statuses): array
    {
        $stmt = $this->pdo->prepare('SELECT * FROM bs_games WHERE id = ? AND (a_id = ? OR b_id = ?)');
        $stmt->execute([$gameId, $userId, $userId]);
        $g = $stmt->fetch();
        if (!$g) {
            throw new ApiException('Battleship game not found.', 404, 'NOT_FOUND');
        }
        if (!in_array($g['status'], $statuses, true)) {
            throw new ApiException('Game is not in a valid state for that action.', 409, 'BAD_STATE');
        }
        return $g;
    }

    private function nickOf(int $id): string
    {
        $stmt = $this->pdo->prepare('SELECT display_nick FROM users WHERE id = ?');
        $stmt->execute([$id]);
        return (string)$stmt->fetchColumn();
    }

    /** Cells of a placed ship as "x,y" keys. */
    private static function shipCells(array $s): array
    {
        $cells = [];
        for ($i = 0; $i < $s['len']; $i++) {
            $cells[] = $s['dir'] === 'h' ? ($s['x'] + $i) . ',' . $s['y'] : $s['x'] . ',' . ($s['y'] + $i);
        }
        return $cells;
    }

    private function bsInvite(array $user, array $in): array
    {
        $userId = (int)$user['id'];
        $opp = $this->findMember((string)($in['target_nick'] ?? ''));
        if (!$opp || (int)$opp['id'] === $userId) {
            throw new ApiException('Target operator not found on this server.');
        }
        $oppId = (int)$opp['id'];
        $cfg = $this->settings();
        if (!$cfg['games_enabled']) {
            throw new ApiException('Games are disabled on this server.', 403, 'GAMES_DISABLED');
        }
        $stake = max(0, (int)($in['stake'] ?? 0));
        if ($stake > 0) {
            if (!$cfg['chess_stakes']) {
                throw new ApiException('Stakes are disabled on this server.', 403, 'STAKES_DISABLED');
            }
            $this->readStake(['stake' => $stake], $userId);
        }

        $id = $this->tx(function () use ($userId, $oppId, $stake): int {
            $chk = $this->pdo->prepare("SELECT 1 FROM bs_games WHERE status IN ('INVITED','PLACING','ACTIVE') AND ((a_id = ? AND b_id = ?) OR (a_id = ? AND b_id = ?))");
            $chk->execute([$userId, $oppId, $oppId, $userId]);
            if ($chk->fetchColumn()) {
                throw new ApiException('A battleship game with this operator is already open.', 409, 'CONFLICT');
            }
            if ($stake > 0) {
                $this->debit($userId, $stake);
            }
            $now = time();
            $this->pdo->prepare('INSERT INTO bs_games (a_id, b_id, stake, status, created_ts, updated_ts) VALUES (?, ?, ?, \'INVITED\', ?, ?)')
                ->execute([$userId, $oppId, $stake, $now, $now]);
            $id = (int)$this->pdo->lastInsertId();
            $this->logGame($userId, 'battleship');
            return $id;
        });
        return ['ok' => true, 'game_id' => $id];
    }

    private function bsAccept(array $user, array $in): array
    {
        $userId = (int)$user['id'];
        if (!$this->settings()['games_enabled']) {
            throw new ApiException('Games are disabled on this server.', 403, 'GAMES_DISABLED');
        }
        return $this->tx(function () use ($userId, $in): array {
            $g = $this->bsLoad((int)($in['game_id'] ?? 0), $userId, ['INVITED']);
            if ((int)$g['b_id'] !== $userId) {
                throw new ApiException('Only the invited player can accept.', 403, 'FORBIDDEN');
            }
            $upd = $this->pdo->prepare("UPDATE bs_games SET status = 'PLACING', updated_ts = ? WHERE id = ? AND status = 'INVITED'");
            $upd->execute([time(), (int)$g['id']]);
            if ($upd->rowCount() !== 1) {
                throw new ApiException('Game changed, try again.', 409, 'CONFLICT');
            }
            if ((int)$g['stake'] > 0) {
                $this->debit($userId, (int)$g['stake']);
            }
            $this->logGame($userId, 'battleship');
            return ['ok' => true, 'game_id' => (int)$g['id']];
        });
    }

    /** Cancel with refunds: inviter only while INVITED, both once PLACING/ACTIVE. */
    private function bsCancel(array $g): bool
    {
        $upd = $this->pdo->prepare("UPDATE bs_games SET status = 'CANCELLED', updated_ts = ? WHERE id = ? AND status = ?");
        $upd->execute([time(), (int)$g['id'], $g['status']]);
        if ($upd->rowCount() !== 1) {
            return false;
        }
        $this->addPoints((int)$g['a_id'], (int)$g['stake']);
        if ($g['status'] !== 'INVITED') {
            $this->addPoints((int)$g['b_id'], (int)$g['stake']);
        }
        return true;
    }

    private function bsDecline(array $user, array $in): array
    {
        $this->tx(function () use ($user, $in): void {
            $g = $this->bsLoad((int)($in['game_id'] ?? 0), (int)$user['id'], ['INVITED', 'PLACING']);
            if (!$this->bsCancel($g)) {
                throw new ApiException('Game changed, try again.', 409, 'CONFLICT');
            }
        });
        return ['ok' => true];
    }

    private function expireStaleBattleship(): void
    {
        $now = time();
        $stmt = $this->pdo->prepare("SELECT * FROM bs_games WHERE (status = 'INVITED' AND updated_ts < ?) OR (status IN ('PLACING','ACTIVE') AND updated_ts < ?)");
        $stmt->execute([$now - 86400, $now - $this->settings()['move_timeout_hours'] * 3600]);
        foreach ($stmt->fetchAll() as $g) {
            $this->tx(function () use ($g): void {
                if ($g['status'] === 'INVITED') {
                    $this->bsCancel($g);
                    return;
                }
                if ($g['status'] === 'ACTIVE') {
                    // The side to move ran out of time
                    $loser = (int)$g['turn_id'];
                    $winner = $loser === (int)$g['a_id'] ? (int)$g['b_id'] : (int)$g['a_id'];
                    $verb = 'wins on time against';
                    $bonus = 25;
                } elseif (($g['a_ships'] === '') !== ($g['b_ships'] === '')) {
                    // Only one fleet was placed: that player takes the pot (no bonus)
                    $winner = $g['a_ships'] !== '' ? (int)$g['a_id'] : (int)$g['b_id'];
                    $loser = $winner === (int)$g['a_id'] ? (int)$g['b_id'] : (int)$g['a_id'];
                    $verb = 'forfeit';
                    $bonus = 0;
                } else {
                    $this->bsCancel($g);
                    return;
                }
                $upd = $this->pdo->prepare("UPDATE bs_games SET status = 'FINISHED', winner_id = ?, updated_ts = ? WHERE id = ? AND status = ?");
                $upd->execute([$winner, time(), (int)$g['id'], $g['status']]);
                if ($upd->rowCount() === 1) {
                    $this->bsFinish($g, $winner, $loser, $verb, $bonus);
                }
            });
        }
    }

    private function bsPlace(array $user, array $in): array
    {
        $userId = (int)$user['id'];
        $g = $this->bsLoad((int)($in['game_id'] ?? 0), $userId, ['PLACING']);
        $side = (int)$g['a_id'] === $userId ? 'a' : 'b';
        if ($g["{$side}_ships"] !== '') {
            throw new ApiException('Fleet already placed.', 409, 'BAD_STATE');
        }

        $raw = $in['ships'] ?? null;
        if (!is_array($raw) || count($raw) !== 5) {
            throw new ApiException('Fleet must contain exactly 5 ships.', 400, 'INVALID_FLEET');
        }
        $ships = [];
        $occupied = [];
        foreach ($raw as $s) {
            if (!is_array($s) || !is_int($s['x'] ?? null) || !is_int($s['y'] ?? null) || !is_int($s['len'] ?? null) || !in_array($s['dir'] ?? null, ['h', 'v'], true)) {
                throw new ApiException('Each ship needs integer x, y, len and dir h|v.', 400, 'INVALID_FLEET');
            }
            $ship = ['x' => $s['x'], 'y' => $s['y'], 'len' => $s['len'], 'dir' => $s['dir']];
            $endX = $ship['x'] + ($ship['dir'] === 'h' ? $ship['len'] - 1 : 0);
            $endY = $ship['y'] + ($ship['dir'] === 'v' ? $ship['len'] - 1 : 0);
            if ($ship['len'] < 2 || $ship['len'] > 5 || $ship['x'] < 0 || $ship['y'] < 0 || $endX > 9 || $endY > 9) {
                throw new ApiException('Ship out of bounds.', 400, 'INVALID_FLEET');
            }
            foreach (self::shipCells($ship) as $c) {
                if (isset($occupied[$c])) {
                    throw new ApiException('Ships overlap.', 400, 'INVALID_FLEET');
                }
                $occupied[$c] = true;
            }
            $ships[] = $ship;
        }
        $lens = array_column($ships, 'len');
        sort($lens);
        if ($lens !== self::FLEET) {
            throw new ApiException('Fleet must be exactly ships of length 5, 4, 3, 3, 2.', 400, 'INVALID_FLEET');
        }

        if (!$this->settings()['games_enabled']) {
            throw new ApiException('Games are disabled on this server.', 403, 'GAMES_DISABLED');
        }
        $started = $this->tx(function () use ($g, $side, $ships): bool {
            $upd = $this->pdo->prepare("UPDATE bs_games SET {$side}_ships = ?, updated_ts = ? WHERE id = ? AND status = 'PLACING' AND {$side}_ships = ''");
            $upd->execute([json_encode($ships), time(), (int)$g['id']]);
            if ($upd->rowCount() !== 1) {
                throw new ApiException('Fleet already placed.', 409, 'BAD_STATE');
            }
            $start = $this->pdo->prepare("UPDATE bs_games SET status = 'ACTIVE', turn_id = a_id WHERE id = ? AND status = 'PLACING' AND a_ships <> '' AND b_ships <> ''");
            $start->execute([(int)$g['id']]);
            $started = $start->rowCount() === 1;
            if ($started) {
                $this->insertSystemMessage('ARENA', 'BATTLESHIP_EVENT', sprintf(
                    '🚢 BATTLESHIP // %s vs %s%s — fleets deployed, %s fires first!',
                    $this->nickOf((int)$g['a_id']),
                    $this->nickOf((int)$g['b_id']),
                    (int)$g['stake'] > 0 ? " for {$g['stake']} pts each" : '',
                    $this->nickOf((int)$g['a_id'])
                ), [(int)$g['stake'] > 0 ? 'bsStartStake' : 'bsStart', ['a' => $this->nickOf((int)$g['a_id']), 'b' => $this->nickOf((int)$g['b_id']), 'stake' => (int)$g['stake']]]);
            }
            return $started;
        });
        return ['ok' => true, 'status' => $started ? 'ACTIVE' : 'PLACING'];
    }

    private function bsFire(array $user, array $in): array
    {
        $userId = (int)$user['id'];
        $x = $in['x'] ?? null;
        $y = $in['y'] ?? null;
        if (!is_int($x) || !is_int($y) || $x < 0 || $x > 9 || $y < 0 || $y > 9) {
            throw new ApiException('Coordinates must be integers 0-9.');
        }
        if (!$this->settings()['games_enabled']) {
            throw new ApiException('Games are disabled on this server.', 403, 'GAMES_DISABLED');
        }

        return $this->tx(function () use ($userId, $x, $y, $in): array {
            $g = $this->bsLoad((int)($in['game_id'] ?? 0), $userId, ['ACTIVE']);
            if ((int)$g['turn_id'] !== $userId) {
                throw new ApiException('Not your turn.', 409, 'NOT_YOUR_TURN');
            }
            $me = (int)$g['a_id'] === $userId ? 'a' : 'b';
            $foe = $me === 'a' ? 'b' : 'a';
            $foeId = (int)$g["{$foe}_id"];
            $shots = json_decode((string)$g["{$me}_shots"], true) ?: [];
            foreach ($shots as $s) {
                if ($s[0] === $x && $s[1] === $y) {
                    throw new ApiException('You already fired at that cell.', 409, 'ALREADY_FIRED');
                }
            }
            $hitShip = null;
            foreach (json_decode((string)$g["{$foe}_ships"], true) ?: [] as $ship) {
                if (in_array("{$x},{$y}", self::shipCells($ship), true)) {
                    $hitShip = $ship;
                    break;
                }
            }
            $shots[] = [$x, $y, $hitShip ? 'hit' : 'miss'];

            $hits = [];
            foreach ($shots as $s) {
                if ($s[2] === 'hit') {
                    $hits["{$s[0]},{$s[1]}"] = true;
                }
            }
            $result = 'miss';
            $sunkLen = null;
            if ($hitShip) {
                $result = 'hit';
                if (!array_diff(self::shipCells($hitShip), array_keys($hits))) {
                    $result = 'sunk';
                    $sunkLen = $hitShip['len'];
                }
            }
            $gameOver = count($hits) === array_sum(self::FLEET);

            $upd = $this->pdo->prepare("UPDATE bs_games SET {$me}_shots = ?, turn_id = ?, status = ?, winner_id = ?, updated_ts = ? WHERE id = ? AND status = 'ACTIVE' AND turn_id = ?");
            $upd->execute([json_encode($shots), $foeId, $gameOver ? 'FINISHED' : 'ACTIVE', $gameOver ? $userId : 0, time(), (int)$g['id'], $userId]);
            if ($upd->rowCount() !== 1) {
                throw new ApiException('Game changed, try again.', 409, 'CONFLICT');
            }
            if ($gameOver) {
                $this->bsFinish($g, $userId, $foeId, 'sank');
            }

            $out = ['ok' => true, 'result' => $result, 'game_over' => $gameOver];
            if ($sunkLen !== null) {
                $out['sunk_len'] = $sunkLen;
            }
            if ($gameOver) {
                $out['winner_id'] = $userId;
            }
            return $out;
        });
    }

    private function bsFinish(array $g, int $winnerId, int $loserId, string $how, int $bonus = 25): void
    {
        $verb = ['sank' => 'sank the entire fleet of', 'resign' => 'wins by resignation against',
            'forfeit' => 'wins by forfeit (fleet never placed) against'][$how] ?? $how;
        $prize = 2 * (int)$g['stake'] + $bonus;
        $this->addPoints($winnerId, $prize);
        $this->insertSystemMessage('ARENA', 'BATTLESHIP_EVENT', sprintf(
            '🚢 BATTLESHIP // %s %s %s! +%d pts',
            $this->nickOf($winnerId),
            $verb,
            $this->nickOf($loserId),
            $prize
        ), ['bsWin_' . $how, ['winner' => $this->nickOf($winnerId), 'loser' => $this->nickOf($loserId), 'prize' => $prize]]);
    }

    private function bsResign(array $user, array $in): array
    {
        $userId = (int)$user['id'];
        $this->tx(function () use ($userId, $in): void {
            $g = $this->bsLoad((int)($in['game_id'] ?? 0), $userId, ['PLACING', 'ACTIVE']);
            if ($g['status'] === 'PLACING') {
                $this->bsCancel($g);
                return;
            }
            $foeId = (int)$g['a_id'] === $userId ? (int)$g['b_id'] : (int)$g['a_id'];
            $upd = $this->pdo->prepare("UPDATE bs_games SET status = 'FINISHED', winner_id = ?, updated_ts = ? WHERE id = ? AND status = 'ACTIVE'");
            $upd->execute([$foeId, time(), (int)$g['id']]);
            if ($upd->rowCount() === 1) {
                $this->bsFinish($g, $foeId, $userId, 'resign');
            }
        });
        return ['ok' => true];
    }

    /** Per-viewer projection: own fleet + shots taken, own shots; the enemy fleet never leaves the server. */
    private function listBattleship(int $userId): array
    {
        $stmt = $this->pdo->prepare("
            SELECT * FROM bs_games
            WHERE (a_id = ? OR b_id = ?)
              AND (status IN ('INVITED','PLACING','ACTIVE') OR updated_ts > ?)
            ORDER BY id DESC LIMIT 20
        ");
        $stmt->execute([$userId, $userId, time() - 600]);
        $out = [];
        foreach ($stmt->fetchAll() as $g) {
            $me = (int)$g['a_id'] === $userId ? 'a' : 'b';
            $foe = $me === 'a' ? 'b' : 'a';
            $myShips = json_decode((string)$g["{$me}_ships"], true) ?: [];
            $foeShips = json_decode((string)$g["{$foe}_ships"], true) ?: [];

            $hitsTaken = [];
            $missesTaken = [];
            foreach (json_decode((string)$g["{$foe}_shots"], true) ?: [] as $s) {
                if ($s[2] === 'hit') {
                    $hitsTaken[] = [$s[0], $s[1]];
                } else {
                    $missesTaken[] = [$s[0], $s[1]];
                }
            }

            $myShotsRaw = json_decode((string)$g["{$me}_shots"], true) ?: [];
            $hitSet = [];
            foreach ($myShotsRaw as $s) {
                if ($s[2] === 'hit') {
                    $hitSet["{$s[0]},{$s[1]}"] = true;
                }
            }
            $sunkCells = [];
            foreach ($foeShips as $ship) {
                $cells = self::shipCells($ship);
                if (!array_diff($cells, array_keys($hitSet))) {
                    foreach ($cells as $c) {
                        $sunkCells[$c] = true;
                    }
                }
            }
            $myShots = array_map(
                fn($s) => [$s[0], $s[1], isset($sunkCells["{$s[0]},{$s[1]}"]) ? 'sunk' : $s[2]],
                $myShotsRaw
            );

            $out[] = [
                'id'            => (int)$g['id'],
                'opponent_nick' => $this->nickOf((int)$g["{$foe}_id"]),
                'is_inviter'    => $me === 'a',
                'stake'         => (int)$g['stake'],
                'status'        => (string)$g['status'],
                'my_turn'       => $g['status'] === 'ACTIVE' && (int)$g['turn_id'] === $userId,
                'i_am_ready'    => $g["{$me}_ships"] !== '',
                'my_board'      => ['ships' => $myShips, 'hits_taken' => $hitsTaken, 'misses_taken' => $missesTaken],
                'my_shots'      => $myShots,
                'winner_id'     => (int)$g['winner_id'] ?: null,
            ];
        }
        return $out;
    }

    /** $i18n = [key, params]: lets clients show the message in the reader's language; $content stays the English fallback. */
    private function insertSystemMessage(string $sender, string $type, string $content, ?array $i18n = null): void
    {
        $this->pdo->prepare('
            INSERT INTO messages (
                room_id, user_id, sender_nick, sender_elo, avatar_preset, avatar_color,
                is_champion, msg_type, content, created_at, created_ts, i18n
            ) VALUES (\'MAIN\', 0, ?, 0, ?, ?, 0, ?, ?, ?, ?, ?)
        ')->execute([
            $sender,
            'CLAUDE_CRAB',
            '#D97757',
            $type,
            $content,
            date('H:i:s'),
            time(),
            $i18n ? (string)json_encode(['k' => $i18n[0], 'p' => $i18n[1] ?? []]) : '',
        ]);
    }
}

// ---------------------------------------------------------------- entry point

if (PHP_SAPI === 'cli') {
    $cmd = $argv[1] ?? '';
    if ($cmd === 'perft') {
        echo Chess::perft(Chess::parse($argv[3] ?? Chess::START), (int)($argv[2] ?? 1)), PHP_EOL;
    } elseif ($cmd === 'case_ev') {
        $t = DeckKernel::CASE_TABLE;
        echo array_sum(array_map(fn($r) => $r[0] * $r[1], $t)) / array_sum(array_column($t, 1)), PHP_EOL;
    }
    return;
}

try {
    $rawBody = (string)file_get_contents('php://input', false, null, 0, Config::MAX_BODY + 1);
    if (strlen($rawBody) > Config::MAX_BODY) {
        throw new ApiException('Request body too large.', 413, 'TOO_LARGE');
    }
    $payload = $rawBody !== '' ? json_decode($rawBody, true, 16) : [];
    if (!is_array($payload)) {
        throw new ApiException('Body must be a JSON object.', 400, 'BAD_JSON');
    }

    $kernel = new DeckKernel(Storage::db());
    $response = $kernel->handle($payload);

    echo json_encode($response, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
} catch (ApiException $e) {
    http_response_code($e->httpStatus);
    echo json_encode([
        'ok'         => false,
        'error_code' => $e->errorCode,
        'error'      => $e->getMessage(),
    ], JSON_UNESCAPED_UNICODE);
} catch (Throwable $e) {
    error_log('[multiplayer] fatal: ' . $e->getMessage() . ' in ' . $e->getFile() . ':' . $e->getLine());
    http_response_code(500);
    echo json_encode([
        'ok'         => false,
        'error_code' => 'INTERNAL_ERROR',
        'error'      => 'Internal server error.',
    ]);
}
