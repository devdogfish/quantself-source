import type { CommandDefinition } from "./command.ts";

type Dependencies = {
  env: Record<string, string | undefined>;
  stdout: (value: string) => void;
  stderr: (value: string) => void;
  fetch?: typeof globalThis.fetch;
};

const flags = ["--path", "--query", "--body", "--idempotency-key"] as const;
type Flag = (typeof flags)[number];
type Options = Partial<Record<Flag, string>>;

class InputError extends Error {}

function jsonLine(value: unknown, secret?: string): string {
  const json = JSON.stringify(value, (_, entry: unknown) => {
    if (!secret) return entry;
    if (typeof entry === "string") return entry.replaceAll(secret, "[redacted]");
    if (record(entry)) {
      return Object.fromEntries(Object.entries(entry).map(([key, item]) => [key.replaceAll(secret, "[redacted]"), item]));
    }
    return entry;
  });
  return json + "\n";
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(value: string, flag: Flag): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new InputError(`${flag} requires valid JSON.`);
  }
}

function readFields(value: string | undefined, parameters: CommandDefinition["parameters"], flag: "--path" | "--query") {
  const fields = value === undefined ? {} : readJson(value, flag);
  if (!record(fields)) throw new InputError(`${flag} requires a JSON object.`);
  for (const name of Object.keys(fields)) {
    if (!parameters.some((parameter) => parameter.name === name)) {
      throw new InputError(`Unknown field in ${flag}. Check the command help for supported fields.`);
    }
  }
  for (const parameter of parameters) {
    if (parameter.required && !Object.hasOwn(fields, parameter.name)) {
      throw new InputError(`${flag} requires ${parameter.name}.`);
    }
  }
  return fields;
}

function readOptions(args: readonly string[]): Options {
  const options: Options = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = flags.find((candidate) => candidate === args[index]);
    if (!flag) throw new InputError("Unknown option. Check the command help.");
    const value = args[index + 1];
    if (value === undefined) throw new InputError(`${flag} requires a value.`);
    if (Object.hasOwn(options, flag)) throw new InputError(`Supply ${flag} only once.`);
    options[flag] = value;
  }
  return options;
}

function readOrigin(value: string | undefined): URL {
  const url = value && URL.canParse(value) ? new URL(value) : undefined;
  const loopback = url && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (!url || !(url.protocol === "https:" || (url.protocol === "http:" && loopback)) ||
      url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new InputError("Set QUANTSELF_API_URL to the API's HTTPS origin. Local development may use loopback HTTP.");
  }
  return url;
}

function scalar(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value));
}

function idempotencyParameter(command: CommandDefinition) {
  return command.parameters.find((parameter) =>
    parameter.in === "header" && parameter.name.toLowerCase() === "idempotency-key");
}

function makeRequest(command: CommandDefinition, options: Options, origin: URL, secret: string) {
  const pathFields = readFields(options["--path"], command.parameters.filter((field) => field.in === "path"), "--path");
  const queryFields = readFields(options["--query"], command.parameters.filter((field) => field.in === "query"), "--query");
  const path = command.path.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const value = Object.hasOwn(pathFields, name) ? pathFields[name] : undefined;
    if (!scalar(value) || value === "" || value === "." || value === "..") {
      throw new InputError(`Supply a valid ${name} path value.`);
    }
    try {
      return encodeURIComponent(value);
    } catch {
      throw new InputError(`Supply a valid ${name} path value.`);
    }
  });
  const url = new URL(path, origin);
  if (url.origin !== origin.origin || url.pathname !== path || !path.startsWith("/api/v1/")) {
    throw new InputError("This command has an invalid API path.");
  }
  for (const [name, value] of Object.entries(queryFields)) {
    const schema = command.parameters.find((parameter) => parameter.in === "query" && parameter.name === name)?.schema;
    if (Array.isArray(value) && (!record(schema) || schema.type !== "array")) {
      throw new InputError(`${name} does not accept an array.`);
    }
    for (const item of Array.isArray(value) ? value : [value]) {
      if (!scalar(item)) throw new InputError(`${name} query values must be strings, numbers or booleans.`);
      url.searchParams.append(name, String(item));
    }
  }

  const headers = new Headers({ accept: "application/json", "x-api-key": secret });
  const keyParameter = idempotencyParameter(command);
  const idempotencyKey = options["--idempotency-key"]?.trim();
  if (keyParameter?.required && idempotencyKey === undefined) {
    throw new InputError("Supply --idempotency-key with a stable unique key for this request.");
  }
  if (idempotencyKey !== undefined) {
    if (!keyParameter) throw new InputError("This command does not document support for --idempotency-key.");
    if (!idempotencyKey || /[^\x20-\x7e\xa0-\xff]/.test(idempotencyKey)) {
      throw new InputError("--idempotency-key requires a nonblank HTTP header value. Use a UUID if unsure.");
    }
    const schema = keyParameter.schema;
    const maxLength = record(schema) ? schema.maxLength : undefined;
    if (typeof maxLength === "number" && idempotencyKey.length > maxLength) {
      throw new InputError(`--idempotency-key must be at most ${maxLength} characters.`);
    }
    headers.set("Idempotency-Key", idempotencyKey);
  }
  const body = options["--body"];
  if (body === undefined && command.body?.required) throw new InputError("This command requires --body JSON.");
  if (body !== undefined) {
    if (!command.body) throw new InputError("This command does not accept --body.");
    readJson(body, "--body");
    headers.set("Content-Type", "application/json");
  }
  return { url, options: { method: command.method, headers, body, redirect: "manual" as const } };
}

function actionFor(status: number, context: string, idempotencyKey: string | undefined, command: CommandDefinition): string {
  if (status === 401) return "Check QUANTSELF_API_KEY and replace the key if it was revoked or expired.";
  if (status === 403) {
    if (/owner session/i.test(context)) {
      return "Ask the Owner to review and perform this operation if appropriate.";
    }
    if (/agent.*(?:disabled|unsupported|cannot)|(?:unsupported|disabled).*agent|does not support audited|audited revision|conditional undo/i.test(context)) {
      return "Check the Quantself CLI skill for the required credential type and use it only with the Owner's authorization.";
    }
    const permissions = command.permissions?.join(", ");
    return permissions
      ? `Ask the Owner to verify the scoped key has the required permissions (${permissions}).`
      : "Check command help for required permissions and ask the Owner for the appropriate scoped key.";
  }
  if (status === 409 || status === 423) {
    if (/hands[\s_-]*off|last (?:3|three) minutes/i.test(context)) {
      return "Wait until three minutes after the Owner's last edit. Re-read the record and review the proposed edit.";
    }
    if (/agents can only edit drafts/i.test(context)) {
      return "Leave this record for the Owner to review and edit.";
    }
    if (/idempotency/i.test(context)) {
      return "Use the original key and identical input to retry that request. Give a different intent its own key.";
    }
    if (/application changed|jobs data changed|stale revision/i.test(context)) {
      return "Re-read the current record and review the conflict before retrying with its latest revision.";
    }
    return "Resolve the reported conflict before trying again.";
  }
  if (status === 429) return "Wait for Retry-After when present, then back off before trying again.";
  if (status === 404) return "Check the API origin and re-read or list records to confirm the identifier.";
  if (status >= 400 && status < 500) return "Check the command help and correct the request input.";
  return retryAction(idempotencyKey, command.method);
}

function retryAction(idempotencyKey: string | undefined, method: string): string {
  if (/^(get|head)$/i.test(method)) return "Check the API origin and service availability before retrying.";
  if (idempotencyKey) return "Check service availability. For a replay-safe operation, retry the identical request with the original idempotency key.";
  return "Check service availability and the current record before deciding whether to submit the write again.";
}

function errorContext(payload: unknown): { code?: string; message?: string } {
  if (!record(payload)) return {};
  const { code, message } = payload;
  return {
    code: typeof code === "string" ? code : undefined,
    message: typeof message === "string" ? message : undefined,
  };
}

export async function runCli(
  args: readonly string[], commands: readonly CommandDefinition[], dependencies: Dependencies,
): Promise<number> {
  const [name, ...options] = args;
  const { env, stdout, stderr, fetch: send = globalThis.fetch } = dependencies;
  const secret = env.QUANTSELF_API_KEY?.trim();
  if (args.length === 0 || ((name === "--help" || name === "help" || name === "-h") && options.length === 0)) {
    stdout(jsonLine({
      usage: "quantself <command> [options]",
      help: "quantself <command> --help",
      environment: ["QUANTSELF_API_URL", "QUANTSELF_API_KEY"],
      commands: commands.map(({ name, summary }) => ({ name, summary })),
    }, secret));
    return 0;
  }
  const help = name === "help" || (options.length === 1 && ["--help", "-h"].includes(options[0]));
  const command = commands.find((command) => command.name === (name === "help" ? options[0] : name));
  if (help && command && options.length === 1) {
    stdout(jsonLine({
      ...command,
      options: {
        "--path": command.parameters.some((parameter) => parameter.in === "path") ? "JSON object with path parameters" : undefined,
        "--query": command.parameters.some((parameter) => parameter.in === "query") ? "JSON object with query parameters" : undefined,
        "--body": command.body ? "JSON request body" : undefined,
        "--idempotency-key": idempotencyParameter(command) ? "Stable key for replay-safe writes" : undefined,
      },
    }, secret));
    return 0;
  }
  const fail = (error: Record<string, unknown>) => {
    stderr(jsonLine(error, secret));
    return 1;
  };

  try {
    if (!command) throw new InputError("Unknown command. Run quantself --help for supported commands.");
    const parsed = readOptions(options);
    if (!secret || /[^\x21-\x7e]/.test(secret)) {
      throw new InputError("Set QUANTSELF_API_KEY to a scoped API key.");
    }
    const request = makeRequest(command, parsed, readOrigin(env.QUANTSELF_API_URL), secret);
    const idempotencyKey = parsed["--idempotency-key"];

    let response: Response;
    let raw: string;
    try {
      response = await send(request.url, { ...request.options, signal: AbortSignal.timeout(60_000) });
      if (response.status >= 300 && response.status < 400) {
        return fail({
          error: "redirect",
          status: response.status,
          action: "Set QUANTSELF_API_URL to the canonical API origin.",
        });
      }
      raw = await response.text();
    } catch {
      return fail({ error: "transport", action: retryAction(idempotencyKey, command.method) });
    }

    let payload: unknown = null;
    try {
      if (response.status !== 204 && response.status !== 205) payload = JSON.parse(raw);
    } catch {
      if (response.ok) {
        return fail({ error: "invalid_response", status: response.status, action: retryAction(idempotencyKey, command.method) });
      }
    }
    if (response.ok) {
      stdout(jsonLine(payload, secret));
      return 0;
    }
    // The API's shared POST validation can report a missing key for invalid JSON fields.
    const api = errorContext(payload);
    if (response.status === 400 && api.code === "INVALID_IDEMPOTENCY_KEY" && command.body && !idempotencyParameter(command)) {
      api.code = "INVALID_REQUEST";
      api.message = "Request validation failed. Check --body against the command help.";
    }
    const retryAfter = response.headers.get("Retry-After");
    return fail({
      error: "api",
      status: response.status,
      ...api,
      retryAfter: retryAfter && (/^\d+$/.test(retryAfter) || Number.isFinite(Date.parse(retryAfter))) ? retryAfter : undefined,
      action: actionFor(response.status, `${api.code ?? ""} ${api.message ?? ""}`, idempotencyKey, command),
    });
  } catch (error) {
    if (!(error instanceof InputError)) throw error;
    return fail({ error: "usage", message: error.message });
  }
}
