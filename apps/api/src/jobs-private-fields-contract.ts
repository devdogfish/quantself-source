import { z } from "@hono/zod-openapi";
import { candidateContextOutput } from "./jobs-candidate-context";
import { resumeTrack } from "./jobs-common-contract";

const id = z.uuid();
const key = z.string().regex(/^[A-Za-z][A-Za-z0-9_.:\[\]-]{0,127}$/);
const label = z.string().trim().min(1).max(400);
const type = z.enum(["text", "email", "phone", "url", "number", "date", "boolean", "option", "options"]);
const scope = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("global") }),
  z.strictObject({ kind: z.literal("track"), track: resumeTrack }),
  z.strictObject({ kind: z.literal("listing"), applicationId: id }),
]).openapi("JobPrivateFieldScope");
const option = z.string().trim().min(1).max(200);
const options = z.array(option).max(30).refine(values => new Set(values).size === values.length);
const stringValue = z.string().trim().min(1).max(4_000).regex(/^[^\u0000-\u0008\u000b-\u001f\u007f]+$/);
const value = z.union([stringValue, z.boolean(), options]);
const version = z.number().int().min(1).max(2_147_483_646);
const field = { key, label, type, scope };

const metadata = {
  ...field, id, options, hasValue: z.boolean(), version, updatedAt: z.iso.datetime(),
};
export const privateFieldMetadata = z.object(metadata).openapi("JobPrivateFieldMetadata");
const fieldPatch = z.strictObject({
  ...field, options: options.optional(), expectedVersion: version.nullable(), value: value.nullable().optional(),
});
export const listPrivateFieldsInput = z.object({ applicationId: id.optional() });
export const privateFieldValuesInput = z.strictObject({ applicationId: id.optional() });
export const privateFieldValuesOutput = z.object({
  fields: z.array(z.object({ ...metadata, value: value.nullable() }).openapi("JobPrivateFieldValue")),
});
export const patchPrivateFieldsInput = z.strictObject({ fields: z.array(fieldPatch).min(1).max(25) });
export const privateFieldRequirement = z.strictObject({ ...field, options: options.optional() });
export const registerPrivateRequirementsInput = z.strictObject({ fields: z.array(privateFieldRequirement).min(1).max(25) });
export const registerPrivateRequirementsOutput = z.object({ registered: z.number().int().nonnegative() });
export const privateFieldsOutput = z.object({ fields: z.array(privateFieldMetadata) });
export const patchPrivateFieldsOutput = privateFieldsOutput.extend({ resumedApplicationIds: z.array(id).optional() });
export const resolvedPrivateFieldsOutput = z.object({
  fields: z.array(z.object({ ...field, value })),
  candidateContext: candidateContextOutput,
});
export const renderIdentityKeys = [
  "firstName", "lastName", "email", "phone", "city", "region", "country", "postalCode", "addressLine1", "linkedin", "website",
];

export type FieldScope = z.infer<typeof scope>;
export type FieldType = z.infer<typeof type>;
export type FieldValue = z.infer<typeof value>;
export type FieldPatch = z.infer<typeof fieldPatch>;
export type FieldRequirement = z.infer<typeof privateFieldRequirement>;
export type PrivateFieldMetadata = z.infer<typeof privateFieldMetadata>;

export function validFieldValue(type: FieldType, value: FieldValue, choices: string[]) {
  if (type === "boolean") return typeof value === "boolean";
  if (type === "options") return Array.isArray(value) && (!choices.length || value.every(choice => choices.includes(choice)));
  if (typeof value !== "string") return false;
  switch (type) {
    case "email": return value.length <= 254 && z.email().safeParse(value).success;
    case "phone": return value.length <= 50 && /^[\d+(). #x-]+$/i.test(value) && value.replace(/\D/g, "").length >= 6;
    case "url": {
      const url = URL.parse(value);
      return value.length <= 2_048 && !!url && ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
    }
    case "number": return value.length <= 30 && /^-?\d+(?:\.\d+)?$/.test(value);
    case "date": return z.iso.date().safeParse(value).success;
    case "option": return value.length <= 200 && (!choices.length || choices.includes(value));
    case "text": return true;
  }
}

export function parseStoredFieldValue(type: FieldType, raw: unknown, choices: string[]): FieldValue | undefined {
  const parsed = value.safeParse(raw);
  if (parsed.success && validFieldValue(type, parsed.data, choices)) return parsed.data;
}
