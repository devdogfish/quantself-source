"use client";
import { Button, Field, Fieldset, Flex, Input, Link, Stack, Text } from "@chakra-ui/react";
import { useState, useId } from "react";
import { TodoDetailSelect } from "./todo-detail-select";
import type { components } from "@/lib/generated/quantself-api-schema";
import type { LiveTodo } from "./todo-live";
import { saveTodoFacts } from "./todo-facts-editor";
import { useJarvisDraft } from "./jarvis-ui";

export function TodoRelationships({
  todo,
  disabled,
  onSaved,
}: {
  todo: LiveTodo;
  disabled: boolean;
  onSaved: () => void;
}) {
  const fieldId = useId();
  const [number, setNumber] = useState("");
  const [kind, setKind] = useState<"blockedBy" | "children">("blockedBy");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState<
    components["schemas"]["TodoEdit"] | null
  >(null);
  useJarvisDraft(busy || pending !== null || number !== "");
  async function save(command: components["schemas"]["TodoEdit"]) {
    setBusy(true);
    setPending(command);
    try {
      const result = await saveTodoFacts(todo.number, command);
      setMessage(
        `${result.message} ${Object.entries(result.outcomes)
          .map(([k, v]) => `${k}: ${v}`)
          .join(" · ")}`,
      );
      if (!result.retryable) setPending(null);
      onSaved();
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function edit(
    kind: "blockedBy" | "children",
    number: number,
    before: boolean,
  ) {
    void save({
      commandId: crypto.randomUUID(),
      relationships: [{ kind, number, before, after: !before }],
    });
  }
  return (
    <Stack as="section" minW="0" gap="4">
      <Text as="h3" fontWeight="medium">
        Relationships ·{" "}
        {todo.readiness === "ready" ? "Ready" : "Blocked / readiness unknown"}
      </Text>
      {todo.relationshipError && <p role="alert">{todo.relationshipError}</p>}
      {todo.parent && (
        <p>
          Parent:{" "}
          <a href={todo.parent.url}>
            {todo.parent.title} #{todo.parent.number}
          </a>
        </p>
      )}
      {(["blockedBy", "children"] as const).map((kind) => (
        <Stack key={kind} minW="0" gap="2">
          <Text as="h4" fontSize="sm" fontWeight="medium">
            {kind === "blockedBy"
              ? "Prerequisites"
              : "Sub-issues (grouping only)"}
          </Text>
          {(todo[kind] ?? []).map((ref) => (
            <Stack key={ref.id} minW="0" align="start" gap="2">
              <Link variant="underline" display="inline" color="inherit" textDecorationColor="currentColor" maxW="full" overflowWrap="break-word" fontSize="sm" textDecoration="underline" textUnderlineOffset="4px" href={ref.url}>
                {ref.title} · {ref.repository} #{ref.number}
              </Link>
              {!disabled && ref.repository === todo.repository && (
                <Button
                  variant="outline" colorPalette="gray"
                  size="xs" h="7" fontSize="0.8rem"
                  disabled={busy || !!pending || !!todo.relationshipError}
                  onClick={() => edit(kind, ref.number, true)}
                >
                  Remove {kind === "blockedBy" ? "prerequisite" : "sub-issue"} #
                  {ref.number}
                </Button>
              )}
            </Stack>
          ))}
        </Stack>
      ))}
      {!disabled && (
        <Fieldset.Root disabled={busy || !!todo.relationshipError || !!pending}>
          <Fieldset.Content gap="5">
            <Field.Root gap="2">
              <Field.Label htmlFor={`${fieldId}-0`}>Relationship</Field.Label>
              <TodoDetailSelect
                id={`${fieldId}-0`}
                label="Relationship"
                value={kind}
                items={[
                  { value: "blockedBy", label: "Prerequisite" },
                  { value: "children", label: "Sub-issue" },
                ]}
                disabled={busy || !!todo.relationshipError || !!pending}
                onChange={value => setKind(value === "children" ? "children" : "blockedBy")}
              />
            </Field.Root>
            <Field.Root gap="2">
              <Field.Label htmlFor={`${fieldId}-1`}>Task number</Field.Label>
              <Input
                size="xs" fontSize={{ base: "md", md: "sm" }} borderColor="border"
                id={`${fieldId}-1`}
                type="number"
                min="1"
                value={number}
                onChange={(e) => setNumber(e.target.value)}
              />
            </Field.Root>
            <Button
              variant="outline" colorPalette="gray"
              size="xs" h="7" fontSize="0.8rem"
              alignSelf="start"
              disabled={
                !Number.isSafeInteger(Number(number)) || Number(number) < 1
              }
              onClick={() => edit(kind, Number(number), false)}
            >
              Add relationship
            </Button>
          </Fieldset.Content>
        </Fieldset.Root>
      )}
      {message && <p role="status">{message}</p>}
      {pending && !disabled && (
        <Flex wrap="wrap" gap="2">
          <Button
            variant="outline" colorPalette="gray"
            size="xs" h="7" fontSize="0.8rem"
            disabled={busy}
            onClick={() => void save(pending)}
          >
            Reconcile relationship save
          </Button>
          <Button
            variant="outline" colorPalette="gray"
            size="xs" h="7" fontSize="0.8rem"
            disabled={busy}
            onClick={() => {
              setPending(null);
              onSaved();
            }}
          >
            Refresh relationships
          </Button>
        </Flex>
      )}
    </Stack>
  );
}
