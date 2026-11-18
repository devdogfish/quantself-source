import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "bun:test";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");

describe("inventory preprocessing runtime wiring", () => {
  test("ships worker entrypoints and API-private route module", () => {
    expect(
      existsSync(
        path.join(
          repoRoot,
          "apps/web/scripts/run-inventory-preprocessing-worker.ts",
        ),
      ),
    ).toBe(true);
    expect(
      existsSync(
        path.join(
          repoRoot,
          "apps/api/src/inventory-worker-route.ts",
        ),
      ),
    ).toBe(true);

    const rootPackage = JSON.parse(
      readFileSync(path.join(repoRoot, "package.json"), "utf8"),
    ) as {
      scripts?: Record<string, string>;
    };
    const webPackage = JSON.parse(
      readFileSync(path.join(repoRoot, "apps/web/package.json"), "utf8"),
    ) as {
      scripts?: Record<string, string>;
    };

    expect(rootPackage.scripts?.["run-inventory-preprocessing-worker"]).toBe(
      "bun run --cwd apps/web run-inventory-preprocessing-worker",
    );
    expect(webPackage.scripts?.["run-inventory-preprocessing-worker"]).toBe(
      "bun run ./scripts/run-inventory-preprocessing-worker.ts",
    );
  });

  test("ships an executable Girke credential probe", () => {
    const smokeCheck = readFileSync(
      path.join(repoRoot, "scripts/check-inventory-workers.sh"),
      "utf8",
    );
    const probe = smokeCheck.match(
      /inventory-preprocessing-worker \\\n  -e '([^']+)'/,
    )?.[1];

    expect(probe).toBeDefined();

    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        "-e",
        `const fetch=async(url,options)=>({ok:url==="https://girke.test/api/v1/ocr"&&options.headers.Authorization==="Bearer test-token",status:200});${probe}`,
      ],
      env: {
        ...process.env,
        GIRKE_API_BASE_URL: "https://girke.test/",
        GIRKE_API_TOKEN: "test-token",
      },
      stderr: "pipe",
      stdout: "pipe",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
  });
});
