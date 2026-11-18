import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe("API foundation config check", () => {
  test("requires an explicit deployment identity", async () => {
    const result = await checkConfig(`
BETTER_AUTH_SECRET=0123456789abcdef0123456789abcdef
QUANTSELF_PUBLIC_ORIGIN=https://dashboard.example.com
`);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "QUANTSELF_INSTANCE_NAME must not be empty",
    );
  });

  test("requires a valid owner email", async () => {
    const result = await checkConfig(`
BETTER_AUTH_SECRET=0123456789abcdef0123456789abcdef
QUANTSELF_PUBLIC_ORIGIN=https://dashboard.example.com
QUANTSELF_INSTANCE_NAME=QuantSelf Prod 1.0
QUANTSELF_OWNER_EMAIL=not-an-email
`);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "QUANTSELF_OWNER_EMAIL must be an email address",
    );
  });

  test("accepts an explicit production identity", async () => {
    const result = await checkConfig(`
BETTER_AUTH_SECRET=0123456789abcdef0123456789abcdef
QUANTSELF_PUBLIC_ORIGIN=https://dashboard.example.com
QUANTSELF_INSTANCE_NAME="Quantself Prod 1.0"
QUANTSELF_OWNER_EMAIL=production@quantself.valid
`);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "API foundation authentication configuration is valid",
    );
  });

  test("accepts the existing legacy origin name and lets Compose generate the auth secret", async () => {
    const result = await checkConfig(`
BETTER_AUTH_SECRET=
BETTER_AUTH_URL=https://dashboard.example.com
QUANTSELF_INSTANCE_NAME="Quantself Prod 1.0"
QUANTSELF_OWNER_EMAIL=production@quantself.valid
`);

    expect(result.exitCode).toBe(0);
  });

  test("still rejects a weak explicit auth secret", async () => {
    const result = await checkConfig(`
BETTER_AUTH_SECRET=short
QUANTSELF_PUBLIC_ORIGIN=https://dashboard.example.com
QUANTSELF_INSTANCE_NAME="Quantself Prod 1.0"
QUANTSELF_OWNER_EMAIL=production@quantself.valid
`);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "BETTER_AUTH_SECRET must contain at least 32 characters",
    );
  });
});

async function checkConfig(contents: string) {
  const directory = await mkdtemp(join(tmpdir(), "quantself-config-"));
  temporaryDirectories.push(directory);
  const envFile = join(directory, ".env");
  await Bun.write(envFile, contents.trimStart());

  const process = Bun.spawn(
    ["bash", join(import.meta.dir, "check-api-foundation-config.sh"), envFile],
    {
      stderr: "pipe",
      stdout: "pipe",
    },
  );
  const [exitCode, stderr, stdout] = await Promise.all([
    process.exited,
    new Response(process.stderr).text(),
    new Response(process.stdout).text(),
  ]);

  return { exitCode, stderr, stdout };
}
