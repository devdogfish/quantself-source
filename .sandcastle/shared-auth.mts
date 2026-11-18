import {
  chmodSync, existsSync, mkdirSync, mkdtempSync,
  readFileSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

function validateAuth(contents: Buffer) {
  let auth;
  try { auth = JSON.parse(contents.toString()); }
  catch { throw new Error("Invalid Codex auth JSON; inspect the file locally."); }
  if (auth?.auth_mode !== "chatgpt" || !auth.tokens?.refresh_token) {
    throw new Error("Expected a ChatGPT login in ~/.codex/auth.json. Run codex login first.");
  }
}

/** One canonical login, serialized across repos using this same lock protocol. */
export async function withSharedCodexAuth<T>(
  run: (session: { home: string; signal: AbortSignal }) => Promise<T>,
  codexHome = path.join(homedir(), ".codex"),
): Promise<T> {
  const source = path.join(codexHome, "auth.json");
  const lock = path.join(codexHome, "sandcastle-auth.lock");
  if (!existsSync(source)) throw new Error("Missing ~/.codex/auth.json. Run codex login first.");
  try {
    mkdirSync(lock, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`Shared Codex login is locked: ${lock}. Wait for the other Sandcastle run. After a forced kill, inspect owner.json and recover the session before removing the lock.`);
    }
    throw error;
  }

  let home: string | undefined;
  let original: Buffer | undefined;
  let preserve = false;
  const controller = new AbortController();
  const stop = () => controller.abort(new Error("Sandcastle interrupted"));
  let finalized = false;
  const finalize = () => {
    if (finalized) return;
    finalized = true;
    try {
      if (home && original) {
        const refreshed = readFileSync(path.join(home, "auth.json"));
        validateAuth(refreshed);
        if (!refreshed.equals(original)) {
          if (!readFileSync(source).equals(original)) {
            throw new Error("The host Codex login changed during this run; refusing to overwrite it.");
          }
          const temporary = path.join(codexHome, `.sandcastle-auth-${randomUUID()}.tmp`);
          try {
            writeFileSync(temporary, refreshed, { mode: 0o600, flag: "wx" });
            renameSync(temporary, source);
          } finally {
            rmSync(temporary, { force: true });
          }
        }
      }
    } catch (error) {
      preserve = true;
      throw new Error(`Auth persistence failed. Session retained at ${home}; lock retained at ${lock}. ${error instanceof Error ? error.message : "Check the auth files locally."}`);
    } finally {
      process.removeListener("exit", finalize);
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
      if (!preserve) {
        if (home) rmSync(home, { recursive: true, force: true });
        rmSync(lock, { recursive: true, force: true });
      }
    }
  };
  // Sandcastle calls process.exit() during its own signal teardown.
  process.on("exit", finalize);
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ pid: process.pid, cwd: process.cwd() }), { mode: 0o600 });
    original = readFileSync(source);
    validateAuth(original);
    home = mkdtempSync(path.join(codexHome, "sandcastle-session-"));
    chmodSync(home, 0o700);
    writeFileSync(path.join(lock, "session"), home, { mode: 0o600 });
    writeFileSync(path.join(home, "auth.json"), original, { mode: 0o600 });
    writeFileSync(path.join(home, "config.toml"), 'cli_auth_credentials_store = "file"\n', { mode: 0o600 });
    return await run({ home, signal: controller.signal });
  } finally {
    finalize();
  }
}
