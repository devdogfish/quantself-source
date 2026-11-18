import { resolveBrowserOwner } from "@quantself/auth";
import { headers } from "next/headers";
import { cache } from "react";

export const getOwnerSession = cache(async () => {
  const owner = await resolveBrowserOwner(new Headers(await headers()));
  return owner ? { user: owner } : null;
});

export async function requireOwnerPageSession() {
  const session = await getOwnerSession();
  if (session) return session;
  throw new Error("Owner ingress is unavailable.");
}

export async function assertOwnerActionSession() {
  const session = await getOwnerSession();
  if (!session) throw new Error("Authentication required.");
  return session;
}
