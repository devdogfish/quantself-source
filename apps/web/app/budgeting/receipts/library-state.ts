import { documentKinds, type DocumentKind } from "./document-format";

export function receiptLibraryState(params: Pick<URLSearchParams, "get">) {
  const kind = params.get("kind") ?? "";
  return {
    kind: Object.hasOwn(documentKinds, kind) ? kind as DocumentKind : "",
    cursor: params.get("cursor") ?? "",
    subscriptionId: params.get("subscriptionId") ?? "",
  };
}
