import type { components, operations } from "@/lib/generated/quantself-api-schema";
import type { CandidateRulesDisplay } from "../../../../../scripts/jobs/candidate-rules";
type JobApplication = components["schemas"]["JobReviewApplicationDetail"];

type PatchField = operations["patchJobPrivateFields"]["requestBody"]["content"]["application/json"]["fields"][number];
export type FieldMetadata = components["schemas"]["JobPrivateFieldMetadata"];
export type FieldScope = FieldMetadata["scope"];
export type FieldType = FieldMetadata["type"];
export type PrivateField = Pick<FieldMetadata, "key" | "label" | "type" | "scope" | "options">;
export type PrivateValue = NonNullable<PatchField["value"]>;
export type PrivateFieldWrite = PrivateField & Pick<PatchField, "expectedVersion"> & { value: PrivateValue };
export type PrivateFieldValue = components["schemas"]["JobPrivateFieldValue"];
export type ApplicationDetails = {
  application: Pick<JobApplication, "sourceUrl" | "company" | "role" | "status" | "approvedRevision" | "privatePauseFieldKeys"> & {
    resumeTrack: JobApplication["track"]; issueCode: JobApplication["issue"];
  };
  candidateRules?: CandidateRulesDisplay;
  candidateRulesUnavailable?: boolean;
};

const endpoint = "/api/v1/jobs/private-fields";
const types: FieldType[] = ["text", "email", "phone", "url", "number", "date", "boolean", "option", "options"];

export class PrivateDetailsRequestError extends Error {
  constructor(readonly status: number) { super("Reusable details request failed."); }
}

export function privateFieldKey(field: Pick<PrivateField, "key" | "scope">) {
  const { scope } = field;
  if (scope.kind === "track") return `${scope.kind}:${scope.track}:${field.key}`;
  if (scope.kind === "listing") return `${scope.kind}:${scope.applicationId}:${field.key}`;
  return `global:${field.key}`;
}

function readScope(scope: FieldScope | undefined): FieldScope | null {
  if (scope?.kind === "global") return { kind: "global" };
  if (scope?.kind === "track" && ["engineering", "web", "admin"].includes(scope.track)) return { kind: "track", track: scope.track };
  if (scope?.kind === "listing" && typeof scope.applicationId === "string") return { kind: "listing", applicationId: scope.applicationId };
  return null;
}

function readMetadata(payload: unknown): FieldMetadata[] {
  const data = payload as { fields?: unknown } | null;
  if (!Array.isArray(data?.fields)) throw new PrivateDetailsRequestError(502);
  return data.fields.map((item: Partial<FieldMetadata> | null) => {
    const scope = readScope(item?.scope);
    if (!item || !scope || typeof item.id !== "string" || typeof item.key !== "string" || typeof item.label !== "string" ||
        !item.type || !types.includes(item.type) || !Array.isArray(item.options) || item.options.some((option) => typeof option !== "string") ||
        typeof item.hasValue !== "boolean" || typeof item.version !== "number" || !Number.isSafeInteger(item.version) ||
        typeof item.updatedAt !== "string") throw new PrivateDetailsRequestError(502);
    const { id, key, label, type, options, hasValue, version, updatedAt } = item;
    return { id, key, label, type, scope, options, hasValue, version, updatedAt };
  });
}

async function request(path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(path, { ...init, credentials: "same-origin", cache: "no-store", redirect: "error" });
  if (!response.ok) throw new PrivateDetailsRequestError(response.status);
  return response.json();
}

export const privateDetailsApi = {
  async application(id: string, signal?: AbortSignal) {
    return await request(`/api/jobs/application-details/${encodeURIComponent(id)}`, { signal }) as ApplicationDetails;
  },
  async metadata(applicationId: string, signal?: AbortSignal) {
    return readMetadata(await request(`${endpoint}?${new URLSearchParams({ applicationId })}`, { signal }));
  },
  async list(applicationId?: string, signal?: AbortSignal): Promise<PrivateFieldValue[]> {
    const payload = await request(`${endpoint}/values`, { method: "POST", signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ applicationId }) });
    const records = readMetadata(payload);
    const rows = (payload as { fields: Array<{ value?: unknown }> }).fields;
    return records.map((record, index) => {
      const value = rows[index].value;
      if (value === null || typeof value === "string" || typeof value === "boolean" || Array.isArray(value) && value.every(item => typeof item === "string")) {
        return { ...record, value };
      }
      throw new PrivateDetailsRequestError(502);
    });
  },
  async save(fields: PrivateFieldWrite[], onResumed?: (ids: string[]) => void) {
    const payload = await request(endpoint, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fields }),
    });
    const records = readMetadata(payload);
    const returned = new Set(records.map(privateFieldKey));
    if (returned.size !== fields.length || records.length !== fields.length || fields.some((field) => !returned.has(privateFieldKey(field)))) {
      throw new PrivateDetailsRequestError(502);
    }
    const ids = (payload as { resumedApplicationIds?: unknown }).resumedApplicationIds;
    if (Array.isArray(ids) && ids.length && ids.every(id => typeof id === "string")) onResumed?.(ids);
    return records;
  },
};
