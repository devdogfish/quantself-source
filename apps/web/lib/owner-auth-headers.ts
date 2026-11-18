export function ownerAuthHeaders(incoming: Pick<Headers, "get">) {
  const headers = new Headers();
  for (const name of ["origin", "x-quantself-owner-proof"]) {
    const value = incoming.get(name);
    if (value !== null) headers.set(name, value);
  }
  return headers;
}
