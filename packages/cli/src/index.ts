#!/usr/bin/env bun
import { commands } from "./generated/commands.ts";
import { runCli } from "./runtime.ts";

process.exitCode = await runCli(process.argv.slice(2), commands, {
  env: process.env,
  stdout: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value),
});
