"use client";

import { Badge, Button, Field, Input, Stack, chakra } from "@chakra-ui/react";

import { memo, useId, useState, type ReactNode } from "react";
import { EyeIcon, EyeOffIcon } from "lucide-react";
import { fieldTypeLabels } from "./private-fields";
import type { FieldMetadata, PrivateField, PrivateValue } from "./private-api";
import type { createPrivateDetailsStore, FieldStatus } from "./private-store";

const inputPrivacy = { autoComplete: "off", spellCheck: false, autoCapitalize: "off", "data-1p-ignore": true, "data-lpignore": "true", "data-bwignore": true } as const;
const phoneExample = "+1 902 555 0123";
const maxEntries = 5;
const recordFields = {
  work: [
    { key: "company", label: "Employer", example: "Example Studio", required: true }, { key: "title", label: "Role", example: "Project coordinator", required: true },
  ],
  education: [
    { key: "school", label: "School", example: "Example College", required: true }, { key: "field", label: "Field of study", example: "Business administration", required: true },
  ],
};
const recordExtras = [
  { key: "startDate", label: "Start date", example: "YYYY-MM-DD (2022-05-01)", required: false },
  { key: "endDate", label: "End date", example: "YYYY-MM-DD (2025-06-30)", required: false },
  { key: "summary", label: "Relevant details", example: "Coordinated weekly reporting", required: false },
];
const examples: Record<string, string> = {
  firstName: "Alex", lastName: "Morgan", fullName: "Alex Morgan", phone: phoneExample,
  linkedin: "https://www.linkedin.com/in/alex-morgan", website: "https://example.com", addressLine1: "123 Example Street",
  city: "Halifax", region: "Nova Scotia", postalCode: "B3H 1Y2", country: "Canada",
  workAuthorization: "Authorized to work in Canada", languages: "English — fluent", hourlyRate: "25.00",
  availability: "Weekdays, 9 a.m.–5 p.m. Atlantic", startDate: "YYYY-MM-DD (2027-01-15)",
};
const typeExamples: Partial<Record<PrivateField["type"], string>> = {
  email: "name@example.com", phone: phoneExample, url: "https://example.com", number: "25.00", date: "YYYY-MM-DD (2027-01-15)",
};

function recordKind(field: PrivateField) {
  if (field.scope.kind !== "listing" || field.type !== "text") return;
  const label = field.label.normalize("NFKC").trim().toLowerCase();
  if (["work history", "work experience"].includes(label)) return "work" as const;
  if (label === "education") return "education" as const;
}

function valueFromForm(form: HTMLFormElement, field: PrivateField, rows: number): PrivateValue | null | undefined {
  const data = new FormData(form);
  const kind = recordKind(field);
  if (kind) {
    const entries = Array.from({ length: rows }, (_, index) => Object.fromEntries(
      [...recordFields[kind], ...recordExtras].flatMap(({ key }) => {
        const value = data.get(`${index}:${key}`);
        return typeof value === "string" && value.trim() ? [[key, value.trim()]] : [];
      }),
    ));
    const entered = entries.filter((entry) => Object.keys(entry).length > 0);
    if (!entered.length) return;
    if (!form.checkValidity() || entered.some((entry) => recordFields[kind].some(({ key }) => !entry[key]))) return null;
    const serialized = JSON.stringify(entered);
    return serialized.length <= 4000 ? serialized : null;
  }
  if (field.type === "options") {
    const checked = [...new Set(data.getAll("answer").flatMap((value) => typeof value === "string" && value.trim() ? [value.trim()] : []))];
    return checked.length ? checked : undefined;
  }
  const value = data.get("answer");
  if (typeof value !== "string" || !value.trim()) return;
  if (field.type === "boolean") return value === "yes";
  const trimmed = value.trim();
  if (!form.checkValidity()) return null;
  if (field.key === "phone" && field.type === "phone" && (!/^\+?[0-9 ().-]+$/.test(trimmed) || !/^\d{10,15}$/.test(trimmed.replace(/\D/g, "")))) return null;
  return trimmed;
}

function recordValues(value: PrivateValue | null | undefined): Array<Record<string, unknown>> {
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every(item => item && typeof item === "object" && !Array.isArray(item)) ? parsed.slice(0, maxEntries) : [];
  } catch { return []; }
}

export const PrivateFieldRow = memo(function PrivateFieldRow({ field, current, status, store, presentation, layout = "stacked", actions }: {
  field: PrivateField;
  /** "inline": one settings row (label | borderless input | status), as on Profile. */
  layout?: "stacked" | "inline";
  /** Extra controls next to the status badge, e.g. a track-override menu. */
  actions?: ReactNode;
  current?: FieldMetadata;
  presentation?: { label: string; help?: string };
  status?: FieldStatus;
  store: ReturnType<typeof createPrivateDetailsStore>;
}) {
  const inline = layout === "inline";
  const [editing, setEditing] = useState<"show" | "hide" | false>(false);
  const [invalid, setInvalid] = useState(false);
  const [rows, setRows] = useState(1);
  const id = useId();
  const kind = recordKind(field);
  const label = presentation?.label ?? field.label;
  const saved = current?.hasValue === true;
  const badge = status?.saving ? "Saving…" : status ? "Pending" : saved ? "Saved" : "";
  const isPhone = field.key === "phone" && field.type === "phone";
  const sensitive = field.type !== "url" && field.key !== "languages";
  const masked = sensitive && (editing === "hide" || (editing !== "show" && saved));
  const inputType = masked ? "password" : field.type === "phone" ? "tel" : field.type === "email" || field.type === "url" ? field.type : "text";
  const freeOptions = field.type === "options" && !field.options.length;
  const choices = field.type === "boolean" || field.options.length > 0 && (field.type === "option" || field.type === "options");

  function register(form: HTMLFormElement | null) {
    if (!form) { store.register(field); return; }
    const inputs = [...form.querySelectorAll<HTMLInputElement>("input")];
    if (!form.dataset.hydrated && inputs.some(input => input.type === "radio" || input.type === "checkbox" ? input.checked : input.value)) {
      form.dataset.dirty = "true";
      if (sensitive && editing === false) setEditing("show");
    }
    form.dataset.hydrated = "true";
    if (!form.dataset.dirty) {
      const value = store.value(field);
      const entries = kind ? recordValues(value) : [];
      const values = Array.isArray(value) ? value : [typeof value === "boolean" ? (value ? "yes" : "no") : value ?? ""];
      const requiredRows = kind ? entries.length : freeOptions ? values.length : 1;
      if (requiredRows > rows) setRows(Math.min(requiredRows, maxEntries));
      inputs.forEach((input, index) => {
        if (choices) {
          input.checked = values.includes(input.value);
        } else {
          const [row, key] = input.name.split(":");
          const selected = kind ? entries[Number(row)]?.[key] : values[index];
          const next = typeof selected === "string" ? selected : "";
          if (input.value !== next) input.value = next;
        }
      });
    }
    store.register(field, () => {
      if (!form.dataset.dirty) return;
      const value = valueFromForm(form, field, rows);
      setInvalid(value === null);
      if (value !== undefined && value !== null) {
        delete form.dataset.dirty;
        if (JSON.stringify(value) === JSON.stringify(store.value(field))) return;
      }
      return value;
    });
  }

  return (
    <chakra.li
      css={inline ? {
        display: "grid",
        gridTemplateColumns: { base: "minmax(0, 1fr) auto", md: "minmax(7rem, 9.5rem) minmax(0, 1fr) auto" },
        gridTemplateAreas: { base: '"label meta" "input input"', md: '"label input meta"' },
        alignItems: "center",
        columnGap: "1rem",
        rowGap: "0.25rem",
        borderTopWidth: "1px",
        paddingInline: "1rem",
        paddingBlock: "0.375rem",
        "& > div:first-of-type": { display: "contents" },
        "& > div:first-of-type > div:first-of-type": { gridArea: "label" },
        "& > div:first-of-type > div:last-of-type": { gridArea: "meta" },
        "& > form": { gridArea: "input", width: "100%", minWidth: 0 },
        "& > form > *, & > form input:not([type=radio]):not([type=checkbox])": { width: "100%" },
        "& [data-part=helper-text]": { display: "none" },
        "& > form input:not([type=radio]):not([type=checkbox])": { borderColor: "transparent", _hover: { borderColor: "border" }, _focus: { borderColor: "border.emphasized" } },
      } : {
        display: "flex",
        flexDirection: "column",
        gap: "0.5rem",
        borderTopWidth: "1px",
        paddingInline: "1rem",
        paddingBlock: "0.75rem",
        "@media (min-width: 30rem)": { paddingInline: "1.25rem" },
      }}
    >
      <chakra.div
        css={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "0.5rem",
        }}
      >
        <chakra.div css={{ minWidth: "0rem", flex: "1" }}>
          <chakra.p
            id={`${id}-label`}
            css={{
              fontSize: "sm",
              fontWeight: "medium",
              overflowWrap: "break-word",
            }}
          >
            {label}
          </chakra.p>
          {presentation?.help && <chakra.p css={{ fontSize: "xs", color: "fg.muted" }}>{presentation.help}</chakra.p>}
          {(kind || field.type === "option" || field.type === "options") && (
            <chakra.p css={{ fontSize: "xs", color: "fg.muted" }}>{kind ? "Structured entries" : fieldTypeLabels[field.type]}</chakra.p>
          )}
        </chakra.div>
        <chakra.div css={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          {badge && (
            <Badge variant={saved && !status ? "subtle" : "outline"} aria-label={`${label} ${badge}`}>
              {badge}
            </Badge>
          )}
          {sensitive && (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              aria-label={`${masked ? "Show" : "Hide"} ${label}`}
              onClick={() => setEditing(masked ? "show" : "hide")}
            >
              {masked ? <EyeIcon /> : <EyeOffIcon />}
            </Button>
          )}
          {actions}
        </chakra.div>
      </chakra.div>
      <chakra.form
        ref={register}
        aria-labelledby={`${id}-label`}
        css={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}
        autoComplete="off"
        noValidate
        onInput={(event) => {
        event.currentTarget.dataset.dirty = "true";
        if (sensitive && !saved && editing === false) setEditing("show");
        if (invalid) setInvalid(false);
      }}
        onSubmit={(event) => { event.preventDefault(); store.saveChanges(); }}
      >
        {kind ? (
          <chakra.div css={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
            <chakra.p css={{ fontSize: "xs", color: "fg.muted" }}>Saving replaces the entries for this application.</chakra.p>
            {Array.from({ length: rows }, (_, index) => (
              <chakra.fieldset
                key={index}
                css={{
                  borderRadius: "lg",
                  borderWidth: "1px",
                  padding: "0.75rem",
                }}
              >
                <chakra.legend
                  css={{
                    paddingInline: "0.25rem",
                    fontSize: "sm",
                    fontWeight: "medium",
                  }}
                >
                  Entry {index + 1}
                </chakra.legend>
                <Stack
                  css={{
                    display: "grid",
                    gap: "0.5rem",
                    "@media (min-width: 30rem)": {
                      gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                    },
                  }}
                >
                  {[...recordFields[kind], ...recordExtras].map(({ key, label, example, required }) => (
                    <Field.Root key={key} css={{ gap: "0.25rem" }}>
                      <Field.Label htmlFor={`${id}-${index}-${key}`}>{label}</Field.Label>
                      <Input {...inputPrivacy} type={masked ? "password" : "text"} id={`${id}-${index}-${key}`} name={`${index}:${key}`} aria-required={required} maxLength={key === "summary" ? 1000 : 200}
                placeholder={example} pattern={key.endsWith("Date") ? "[0-9]{4}-[0-9]{2}-[0-9]{2}" : undefined} />
                    </Field.Root>
                  ))}
                </Stack>
              </chakra.fieldset>
            ))}
            <chakra.div css={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
              {rows < maxEntries && (
                <Button type="button" variant="outline" size="sm" onClick={() => setRows((n) => n + 1)}>
                  Add entry
                </Button>
              )}
              {rows > 1 && (
                <Button type="button" variant="ghost" size="sm" onClick={(event) => { event.currentTarget.form!.dataset.dirty = "true"; setRows((n) => n - 1); }}>
                  Remove last entry
                </Button>
              )}
            </chakra.div>
          </chakra.div>
        ) : freeOptions ? (
          <Stack css={{ gap: "0.5rem" }}>
            {Array.from({ length: rows }, (_, index) => (
              <Field.Root key={index} css={{ gap: "0.25rem" }}>
                <Field.Label htmlFor={`${id}-choice-${index}`}>Answer {index + 1}</Field.Label>
                <Input {...inputPrivacy} type={masked ? "password" : "text"} id={`${id}-choice-${index}`} name="answer" maxLength={200} placeholder="Enter one option" />
              </Field.Root>
            ))}
            <chakra.div css={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
              {rows < maxEntries && (
                <Button type="button" variant="outline" size="sm" onClick={() => setRows((n) => n + 1)}>
                  Add another answer
                </Button>
              )}
              {rows > 1 && (
                <Button type="button" variant="ghost" size="sm" onClick={(event) => { event.currentTarget.form!.dataset.dirty = "true"; setRows((n) => n - 1); }}>
                  Remove last answer
                </Button>
              )}
            </chakra.div>
          </Stack>
        ) : choices ? (
          <chakra.fieldset display={masked ? "none" : "flex"} flexDirection="column" gap="2">
            <chakra.legend
              css={{
                position: "absolute",
                width: "1px",
                height: "1px",
                padding: 0,
                overflow: "hidden",
                clip: "rect(0,0,0,0)",
                whiteSpace: "nowrap",
                borderWidth: 0,
              }}
            >
              Choose an answer
            </chakra.legend>
            {(field.type === "boolean" ? ["Yes", "No"] : field.options).map((option) => (
              <chakra.label
                key={option}
                css={{
                  display: "flex",
                  minHeight: "2rem",
                  cursor: "pointer",
                  alignItems: "center",
                  gap: "0.5rem",
                  fontSize: "sm",
                }}
              >
                <input type={field.type === "options" ? "checkbox" : "radio"} name="answer" value={field.type === "boolean" ? option.toLowerCase() : option} />
                {option}
              </chakra.label>
            ))}
          </chakra.fieldset>
        ) : (
          <Field.Root css={{ gap: "0.25rem" }}>
            <Field.Label
              css={{
                position: "absolute",
                width: "1px",
                height: "1px",
                padding: 0,
                overflow: "hidden",
                clip: "rect(0,0,0,0)",
                whiteSpace: "nowrap",
                borderWidth: 0,
              }}
              htmlFor={`${id}-answer`}
            >
              {label}
            </Field.Label>
            <Input {...inputPrivacy} type={inputType} id={`${id}-answer`} name="answer" aria-invalid={invalid || undefined}
          inputMode={field.type === "number" ? "decimal" : field.type === "phone" ? "tel" : field.type === "email" ? "email" : field.type === "url" ? "url" : "text"}
          placeholder={examples[field.key] ?? typeExamples[field.type] ?? "Enter your answer"} pattern={field.type === "date" ? "[0-9]{4}-[0-9]{2}-[0-9]{2}" : undefined}
          maxLength={field.type === "text" ? 4000 : field.type === "url" ? 2048 : field.type === "option" ? 200 : 512} />
            {isPhone && !invalid && <Field.HelperText>Example: {phoneExample}</Field.HelperText>}
          </Field.Root>
        )}
        {invalid && (
          <chakra.p role="alert" css={{ fontSize: "sm", color: "fg.error" }}>
            {isPhone ? `Use a number like ${phoneExample}.` : kind ? "Complete the required fields and check the answer length." : "Check the answer format."}
          </chakra.p>
        )}
      </chakra.form>
    </chakra.li>
  );
});
