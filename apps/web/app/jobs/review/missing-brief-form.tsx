import { useState, type FormEvent } from "react";
import { Button, Field, HStack, Input, NativeSelect, Text, Textarea, chakra } from "@chakra-ui/react";
import type { Brief } from "../jobs-client";

const levels = { low: "Low", medium: "Medium", high: "High" };
const remote = { confirmed: "Remote", hybrid: "Hybrid", onsite: "On site", not_stated: "Not stated" };
const meetings = { rare: "Rare", weekly: "Weekly", daily: "Daily" };

function Choice({ name, label, options }: { name: string; label: string; options: Record<string, string> }) {
  return <Field.Root required>
    <Field.Label>{label}</Field.Label>
    <NativeSelect.Root size="sm">
      <NativeSelect.Field name={name} defaultValue="">
        <option value="" disabled>Select</option>
        {Object.entries(options).map(([value, text]) => <option key={value} value={value}>{text}</option>)}
      </NativeSelect.Field>
      <NativeSelect.Indicator />
    </NativeSelect.Root>
  </Field.Root>;
}

export function MissingBriefForm({ save, onSubmit }: {
  save?: { pending: boolean; error?: string; retry?: { brief: Brief } };
  onSubmit: (brief: Brief) => void;
}) {
  const [error, setError] = useState<string>();
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (save?.pending) return;
    if (save?.retry) { onSubmit(save.retry.brief); return; }
    const fields = new FormData(event.currentTarget);
    const read = (key: string) => String(fields.get(key) ?? "").trim();
    const doing = read("doing");
    if (!doing) {
      setError("Describe what you’ll do.");
      return;
    }
    const min = read("min"), max = read("max");
    if (max && (!min || Number(max) < Number(min))) {
      setError("Enter a minimum hourly rate and a maximum at least as high.");
      return;
    }
    setError(undefined);
    onSubmit({
      doing,
      remote: read("remote") as Brief["remote"],
      companySize: { people: null, label: read("company") || "Company size not stated" },
      automatable: read("automatable") as Brief["automatable"],
      humanContact: { level: read("contact") as Brief["humanContact"]["level"], note: read("contactNote") || levels[read("contact") as keyof typeof levels] },
      meetings: { level: read("meetings") as Brief["meetings"]["level"], note: read("meetingNote") || meetings[read("meetings") as keyof typeof meetings] },
      pay: { hourlyCad: min ? { min: Number(min), max: Number(max || min) } : null, original: null, converted: false },
    });
  };

  return <details open={save?.error ? true : undefined}>
    <Text as="summary" cursor="pointer" fontWeight="medium">Add brief</Text>
    <form onSubmit={submit} aria-label="Missing job brief" noValidate={Boolean(save?.retry)}>
      <chakra.fieldset disabled={Boolean(save?.pending || save?.retry)} display="flex" flexDirection="column" gap="3" mt="3">
        <Field.Root required><Field.Label>What you’ll do</Field.Label><Textarea name="doing" required size="sm" /></Field.Root>
        <Choice name="remote" label="Work location" options={remote} />
        <Field.Root><Field.Label>Company size</Field.Label><Input name="company" size="sm" /></Field.Root>
        <Choice name="automatable" label="Automatable" options={levels} />
        <Choice name="contact" label="Human contact" options={levels} />
        <Field.Root><Field.Label>Human contact notes</Field.Label><Input name="contactNote" size="sm" /></Field.Root>
        <Choice name="meetings" label="Meetings" options={meetings} />
        <Field.Root><Field.Label>Meeting notes</Field.Label><Input name="meetingNote" size="sm" /></Field.Root>
        <HStack>
          <Field.Root><Field.Label>Min. hourly CAD</Field.Label><Input name="min" type="number" min="0" step="0.01" size="sm" /></Field.Root>
          <Field.Root><Field.Label>Max. hourly CAD</Field.Label><Input name="max" type="number" min="0" step="0.01" size="sm" /></Field.Root>
        </HStack>
      </chakra.fieldset>
      {(error || save?.error) && <Text role="alert" color="fg.error" mt="2">{error || save?.error}</Text>}
      <Button mt="3" size="sm" type="submit" loading={save?.pending}>{save?.retry ? "Retry saving brief" : "Save brief"}</Button>
    </form>
  </details>;
}
