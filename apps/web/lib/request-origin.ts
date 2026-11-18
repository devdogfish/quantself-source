export function resolvePublicRequestOrigin(request: Request): string {
  const url = new URL(request.url);
  const forwardedHost = firstForwardedValue(
    request.headers.get("x-forwarded-host"),
  );
  const forwardedProtocol = firstForwardedValue(
    request.headers.get("x-forwarded-proto"),
  );

  if (!forwardedHost) {
    return url.origin;
  }

  return `${forwardedProtocol || url.protocol.slice(0, -1)}://${forwardedHost}`;
}

function firstForwardedValue(value: string | null): string | undefined {
  return value?.split(",")[0]?.trim() || undefined;
}
