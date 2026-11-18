import { expect, test } from "bun:test";

const database = process.env.QS_TRACKED_LINKS_TEST_DATABASE_URL;
const legacyId = "e7bdf9d4-4762-48fb-b1fc-bc689be260fc";
const oldCode = "0123456789abcdef01234567";

test.skipIf(!database)("issued links survive migration, and concurrent registrations honor revision rules", async () => {
  const url = new URL(database!);
  if (url.hostname !== "127.0.0.1" || url.pathname !== "/tracked_links_fixture" || !url.port) {
    throw new Error("Use the disposable tracked_links_fixture database on an explicit Docker loopback port.");
  }
  const previousUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = database!;
  const { prisma } = await import("@quantself/db");
  try {
    const { lookupTrackedLink, registerTrackedApplication, registerTrackedShare } = await import("./tracked-links-store");
    expect(await lookupTrackedLink(oldCode)).toEqual({ code: oldCode, kind: "application", track: "backend" });
    const migrated = await prisma.trackedLink.findUniqueOrThrow({ where: { code: oldCode } });
    expect(migrated.sentAt?.toISOString()).toBe("2026-11-01T10:00:00.000Z");
    expect(migrated.createdAt.toISOString()).toBe("2026-10-31T10:00:00.000Z");
    const exact = { applicationId: legacyId, company: "Example Studio", role: "Developer", track: "backend", revision: 3 } as const;
    expect(await registerTrackedApplication(exact)).toEqual({ code: oldCode });
    expect(await registerTrackedApplication({ ...exact, revision: 2 })).toBeNull();
    expect(await registerTrackedApplication({ ...exact, role: "Different title" })).toBeNull();
    expect(await registerTrackedApplication({ ...exact, track: "web-cms", revision: 4 })).toEqual({ code: oldCode });
    expect(await lookupTrackedLink(oldCode)).toEqual({ code: oldCode, kind: "application", track: "web-cms" });

    const orphan = await lookupTrackedLink("fedcba9876543210fedcba98");
    expect(orphan).toEqual({ code: "fedcba9876543210fedcba98", kind: "application", track: "admin-excel" });

    const created = { ...exact, applicationId: crypto.randomUUID(), revision: 1 };
    const [first, duplicate] = await Promise.all([registerTrackedApplication(created), registerTrackedApplication(created)]);
    expect(first?.code).toMatch(/^[A-Za-z0-9]{8}$/);
    expect(duplicate).toEqual(first);
    expect((await registerTrackedApplication({ ...created, applicationId: crypto.randomUUID() }))?.code).not.toBe(first?.code);

    const fullStack = await registerTrackedApplication({ ...created, applicationId: crypto.randomUUID(), track: "full-stack" });
    expect(await lookupTrackedLink(fullStack!.code)).toEqual({ code: fullStack!.code, kind: "application", track: "full-stack" });

    const title = "Kristina Girke footer";
    const [client, defaultView] = await Promise.all([registerTrackedShare({ title, track: "client" }), registerTrackedShare({ title })]);
    expect(client.code).toMatch(/^[A-Za-z0-9]{8}$/);
    expect(defaultView.code).not.toBe(client.code);
    expect(await lookupTrackedLink(client.code)).toEqual({ code: client.code, kind: "share", track: "client" });
    expect(await lookupTrackedLink(defaultView.code)).toEqual({ code: defaultView.code, kind: "share", track: null });
  } finally {
    await prisma.$disconnect();
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
  }
});
