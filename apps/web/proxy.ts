import { NextResponse, type NextRequest } from "next/server";
import { hasOwnerIngressProof, ownerIngressAllowsOrigin } from "@quantself/auth/owner-ingress";
import { ownerAuthHeaders } from "@/lib/owner-auth-headers";

async function hasExistingOwner(
  request: NextRequest,
): Promise<boolean> {
  try {
    const response = await fetch(
      new URL(
        "/api/v1/access-context",
        process.env.QUANTSELF_API_INTERNAL_URL ?? "http://api:3001",
      ),
      {
        cache: "no-store",
        headers: ownerAuthHeaders(request.headers),
        redirect: "error",
      },
    );

    if (!response.ok) {
      return false;
    }

    const payload: unknown = await response.json();
    return isOwnerAccessContextPayload(payload);
  } catch {
    return false;
  }
}

export async function proxy(request: NextRequest) {
  if (
    request.headers.has("x-api-key") ||
    !hasOwnerIngressProof(request.headers) ||
    !ownerIngressAllowsOrigin(request.headers, request.method) ||
    !(await hasExistingOwner(request))
  ) {
    return new NextResponse("Owner access unavailable.", {
      status: 403,
      headers: { "Cache-Control": "no-store" },
    });
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api(?:/|$)|pdfjs/|_next/static|_next/image|inventory/container-visual-catalog/|favicon[.]ico$).*)"],
};

function isOwnerAccessContextPayload(payload: unknown): payload is {
  owner: { id: string };
  client: { id: "quantself-web"; kind: "web" };
} {
  if (!payload || typeof payload !== "object") {
    return false;
  }

  const { client, owner } = payload as {
    client?: unknown;
    owner?: unknown;
  };

  if (
    !owner ||
    typeof owner !== "object" ||
    !client ||
    typeof client !== "object"
  ) {
    return false;
  }

  const ownerId = (owner as { id?: unknown }).id;
  const clientId = (client as { id?: unknown }).id;
  const clientKind = (client as { kind?: unknown }).kind;

  return (
    typeof ownerId === "string" &&
    ownerId.length > 0 &&
    clientId === "quantself-web" &&
    clientKind === "web"
  );
}
