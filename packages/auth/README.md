# QuantSelf Auth

Owner requests use trusted ingress proof to resolve the existing singleton
`AuthOwner`. The API gives explicit `X-API-Key` credentials precedence and
preserves their scoped permissions. Better Auth and its Prisma adapter handle
server-side API key creation, verification, rotation and revocation.

Use `bun run agent-key:create --help` to provision scoped Agent credentials. The
existing Owner must be present. Keep the credential material private.

The checked-in Prisma schema preserves the legacy browser authentication models
for rollback. See the [Owner auth and recovery handoff](../../docs/tailscale-owner-auth.md).
