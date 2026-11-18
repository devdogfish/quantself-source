import {
  createBunCommandRunner,
  runProd,
} from "./ops";

const command = process.argv[2];
const runner = createBunCommandRunner();
let interrupted = false;

function handleInterrupt() {
  interrupted = true;
  runner.interrupt();
}

process.on("SIGINT", handleInterrupt);

try {
  if (command === "prod") {
    await runProd({ runner });
  } else {
    throw new Error("Usage: bun run scripts/ops-cli.ts prod");
  }
} catch (error) {
  if (!interrupted) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
} finally {
  process.off("SIGINT", handleInterrupt);
}
