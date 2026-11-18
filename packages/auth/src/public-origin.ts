export function getPublicOrigin(env = process.env): string | undefined {
  // Keep can continue using the origin from its existing deployment configuration.
  const url = env.QUANTSELF_PUBLIC_ORIGIN || env.BETTER_AUTH_URL;
  return url ? new URL(url).origin : undefined;
}
