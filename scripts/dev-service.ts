import { chmod, mkdir, writeFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const devServiceLabel = "dev.quantself.native-dev";
const root = resolve(import.meta.dir, "..");
const xml = (value: string) => value.replace(/[<>&"']/g, char => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[char]!);

/** Store paths only. Credentials continue to load from the existing private .env. */
export function devServicePlist(repository: string, bun: string, log: string) {
  const args = [bun, `--env-file=${join(repository, ".env")}`, "run", join(repository, "scripts/dev.ts")];
  const path = [...new Set([dirname(bun), "/opt/homebrew/bin", "/usr/local/bin", "/Applications/Docker.app/Contents/Resources/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"])].join(":");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${devServiceLabel}</string>
<key>ProgramArguments</key><array>${args.map(arg => `<string>${xml(arg)}</string>`).join("")}</array>
<key>WorkingDirectory</key><string>${xml(repository)}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(path)}</string><key>QUANTSELF_DEV_MANAGED</key><string>1</string></dict>
<key>KeepAlive</key><dict><key>Crashed</key><true/></dict>
<key>RunAtLoad</key><true/>
<key>ThrottleInterval</key><integer>300</integer>
<key>ExitTimeOut</key><integer>10</integer>
<key>AbandonProcessGroup</key><false/>
<key>Umask</key><integer>63</integer>
<key>StandardOutPath</key><string>${xml(log)}</string>
<key>StandardErrorPath</key><string>${xml(log)}</string>
</dict></plist>
`;
}

async function launchctl(args: string[], inherit = false) {
  const child = Bun.spawn(["launchctl", ...args], { stdout: inherit ? "inherit" : "pipe", stderr: inherit ? "inherit" : "pipe" });
  const code = await child.exited;
  if (code && inherit) throw Error(`launchctl ${args[0]} failed (${code}).`);
  return code;
}

export async function runDevService(command: string) {
  if (process.platform !== "darwin") throw Error("The managed development service requires macOS. Use bun run dev in a persistent terminal on other platforms.");
  if (!["start", "stop", "status", "remove"].includes(command)) throw Error("Usage: bun run dev:service <start|stop|status|remove>");
  const domain = `gui/${process.getuid!()}`;
  const target = `${domain}/${devServiceLabel}`;
  const file = join(homedir(), "Library/LaunchAgents", `${devServiceLabel}.plist`);
  const log = join(homedir(), "Library/Logs/Quantself", "dev.log");
  const loaded = await launchctl(["print", target]) === 0;
  if (command === "status") {
    console.log(loaded ? "Development service loaded." : "Development service stopped.");
    if (loaded) { await launchctl(["print", target], true); console.log("If state is stopped with a nonzero exit code, inspect the log for an open startup circuit; fix the cause, then run bun run dev:service start."); }
    console.log(`Log: ${log}`);
    return;
  }
  if (command === "stop" || command === "remove") {
    if (loaded) await launchctl(["bootout", target], true);
    if (command === "remove") await unlink(file).catch(error => { if (error.code !== "ENOENT") throw error; });
    console.log(command === "remove" ? "Development service removed." : "Development service stopped; it will start again at next login. Use remove to disable login startup.");
    return;
  }
  if (loaded) { await launchctl(["kickstart", target], true); console.log(`Development service running or restarting after a stopped circuit. Log: ${log}`); return; }
  await mkdir(dirname(file), { recursive: true });
  await mkdir(dirname(log), { recursive: true, mode: 0o700 });
  await writeFile(log, "", { flag: "a", mode: 0o600 });
  await chmod(log, 0o600);
  await writeFile(file, devServicePlist(root, process.execPath, log), { mode: 0o600 });
  await chmod(file, 0o600);
  await launchctl(["bootstrap", domain, file], true);
  console.log(`Development service started; bounded startup recovery enabled. Log: ${log}`);
}

if (import.meta.main) {
  try { await runDevService(process.argv[2] ?? "status"); }
  catch (error) { console.error(error instanceof Error ? error.message : "Development service failed."); process.exitCode = 1; }
}
