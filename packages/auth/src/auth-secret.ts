import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const BUILD_ONLY_SECRET =
  "Qz7pL3mN8vR2xK6dF9sT4wY1cH5jB0uE7aG3iO8nP2qS6kV9zX4rM1fD5hC0";
const DEVELOPMENT_SECRET =
  "quantself-development-only-secret-change-before-production";
const MINIMUM_SECRET_LENGTH = 32;

type AuthSecretEnvironment = {
  BETTER_AUTH_SECRET?: string;
  BETTER_AUTH_SECRET_FILE?: string;
  NEXT_PHASE?: string;
  NODE_ENV?: string;
};

function validateAuthSecret(secret: string, source: string): string {
  if (secret.length < MINIMUM_SECRET_LENGTH) {
    throw new Error(`${source} must contain at least 32 characters`);
  }

  return secret;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function readAuthSecretFile(path: string): string {
  try {
    return validateAuthSecret(
      readFileSync(path, "utf8").trim(),
      "BETTER_AUTH_SECRET_FILE",
    );
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      throw new Error(`BETTER_AUTH_SECRET_FILE does not exist: ${path}`, {
        cause: error,
      });
    }

    throw error;
  }
}

export function resolveAuthSecret(
  environment: AuthSecretEnvironment = process.env,
): string {
  const secret = environment.BETTER_AUTH_SECRET;

  if (secret) {
    return validateAuthSecret(secret, "BETTER_AUTH_SECRET");
  }

  if (environment.NEXT_PHASE === "phase-production-build") {
    return BUILD_ONLY_SECRET;
  }

  if (environment.BETTER_AUTH_SECRET_FILE) {
    return readAuthSecretFile(environment.BETTER_AUTH_SECRET_FILE);
  }

  if (environment.NODE_ENV === "production") {
    throw new Error(
      "BETTER_AUTH_SECRET or BETTER_AUTH_SECRET_FILE is required in production",
    );
  }

  return DEVELOPMENT_SECRET;
}

export type InitializeAuthSecretFileResult = {
  created: boolean;
  path: string;
};

export function initializeAuthSecretFile(
  path: string,
  generateSecret: () => string = () => randomBytes(48).toString("base64url"),
): InitializeAuthSecretFileResult {
  try {
    readAuthSecretFile(path);
    return { created: false, path };
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !hasErrorCode(error.cause, "ENOENT")
    ) {
      throw error;
    }
  }

  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const secret = validateAuthSecret(generateSecret(), "Generated auth secret");

  try {
    writeFileSync(path, `${secret}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    return { created: true, path };
  } catch (error) {
    if (hasErrorCode(error, "EEXIST")) {
      readAuthSecretFile(path);
      return { created: false, path };
    }

    throw error;
  }
}
