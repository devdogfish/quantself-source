// The deployed migration service runs the Prisma CLI from the frozen lockfile.
// Install it as a runtime tool in the image while leaving the source manifests alone.
const path = "packages/db/package.json";
const manifest = await Bun.file(path).json();
const lock = Bun.JSONC.parse(await Bun.file("bun.lock").text()) as {
  workspaces: Record<string, typeof manifest>;
};
const workspace = lock.workspaces["packages/db"];
const version = manifest.devDependencies.prisma;
if (!version || workspace.devDependencies.prisma !== version) {
  throw new Error("Prisma CLI is missing from the frozen database workspace");
}
for (const entry of [manifest, workspace]) {
  entry.dependencies.prisma = version;
  delete entry.devDependencies.prisma;
}
await Bun.write(path, JSON.stringify(manifest, null, 2) + "\n");
await Bun.write("bun.lock", JSON.stringify(lock, null, 2) + "\n");
