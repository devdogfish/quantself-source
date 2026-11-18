import type { components, operations } from "@/lib/generated/quantself-api-schema";

export type CandidateContext = components["schemas"]["JobCandidateContext"];
export type CandidateContextPatch = operations["patchJobCandidateContext"]["requestBody"]["content"]["application/json"];

const path = "/api/v1/jobs/candidate-context";

export class CandidateContextRequestError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

async function request(init?: RequestInit): Promise<CandidateContext> {
  const response = await fetch(path, { ...init, credentials: "same-origin", cache: "no-store", redirect: "error" });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { message?: unknown } | null;
    throw new CandidateContextRequestError(response.status,
      typeof body?.message === "string" ? body.message : "Candidate context request failed.");
  }
  const body = await response.json() as Partial<CandidateContext> | null;
  if (typeof body?.markdown !== "string" || typeof body.version !== "number" || !Number.isSafeInteger(body.version) || body.version < 0) {
    throw new Error("Invalid candidate context response.");
  }
  return { markdown: body.markdown, version: body.version };
}

export const candidateContextApi = {
  get: () => request(),
  patch: (input: CandidateContextPatch) => request({
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
  }),
};
