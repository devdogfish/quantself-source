import { initializeAuthSecretFile } from "./auth-secret";

const path = process.env.BETTER_AUTH_SECRET_FILE;

if (!path) {
  throw new Error("BETTER_AUTH_SECRET_FILE is required");
}

const result = initializeAuthSecretFile(path);
console.info(
  result.created
    ? `Created persistent auth secret at ${result.path}`
    : `Persistent auth secret already exists at ${result.path}`,
);
