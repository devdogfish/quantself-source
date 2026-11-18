import { prisma } from "@quantself/db";
import { habitCatalog, importChanges } from "../src/habits-catalog";
import { githubHabitLoader } from "../src/habits-source";
// Explicit release command. Never run as part of startup or migration.
const ownerId = process.argv[2];
if (!ownerId)
  throw new Error(
    "Usage: bun apps/api/scripts/import-habit-catalog.ts OWNER_ID [LOCAL_YAML]",
  );
try {
  const current = await habitCatalog.current(ownerId);
  if (current.revision !== 0)
    throw new Error("Catalog already initialized; import refused.");
  const local = process.argv[3];
  const text = local
    ? await Bun.file(local).text()
    : (await githubHabitLoader()(null, "habits.yaml"))?.text;
  if (!text) throw new Error("habits.yaml unavailable; nothing imported.");
  const result = await habitCatalog.apply(
    ownerId,
    {
      commandId: "00000000-0000-4000-8000-000000000033",
      expectedRevision: 0,
      reason: "Imported from habits.yaml",
      changes: importChanges(text),
    },
    "habits.yaml import",
  );
  console.log(
    `Imported revision ${result.revision}: ${result.projection.stacks.length} stacks, ${result.projection.habits.length} habits.`,
  );
} finally {
  await prisma.$disconnect();
}
