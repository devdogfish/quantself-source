"use client";
import { useEffect, useState } from "react";
import { Alert, Box, Button, Card, Code, Collapsible, Field, Flex, Input, Stack, Text } from "@chakra-ui/react";
import type { components } from "@/lib/generated/quantself-api-schema";
import { readTodoJson } from "./todo-live";
import { saveTodoFacts } from "./todo-facts-editor";
import { useJarvisDraft } from "./jarvis-ui";

type Proposal = components["schemas"]["TodoSuggestion"];
type Review = components["schemas"]["TodoSuggestionReview"] & {
  problem?: string;
};
type Suggestions = components["schemas"]["TodoSuggestions"];
async function post<T>(path: string, input: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(120000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body)
    throw Error(
      body?.message || "Suggestion review unavailable. Refresh and retry.",
    );
  return body;
}
export function TodoSuggestions({
  writable,
  refreshTasks,
  editTask,
  embedded = false,
}: {
  writable: boolean;
  refreshTasks: () => Promise<void>;
  editTask: (number: number) => void;
  embedded?: boolean;
}) {
  const [id, setId] = useState("");
  const [items, setItems] = useState<Review[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [edited, setEdited] = useState<Record<string, boolean>>({});
  useJarvisDraft(busy || items.some(item => edited[item.proposal.command.commandId]));
  // Retain exact attempted commands so partial/uncertain retries cannot change input.
  const [attempted, setAttempted] = useState<Record<string, Proposal>>({});
  useEffect(() => {
    try {
      const review =
        sessionStorage.getItem("todo-suggestion-review") || crypto.randomUUID();
      sessionStorage.setItem("todo-suggestion-review", review);
      setId(review);
      setAttempted(
        JSON.parse(
          sessionStorage.getItem(`todo-suggestion-attempts:${review}`) || "{}",
        ),
      );
    } catch {
      setMessage(
        "Review storage unavailable. Enable session storage to review suggestions.",
      );
    }
  }, []);
  async function load(reviewId = id) {
    setBusy(true);
    setMessage("");
    try {
      const result = await readTodoJson<Suggestions>(
        `/api/v1/todo-suggestions/${reviewId}`,
      );
      const checked = await Promise.all(
        result.suggestions
          .filter((item) => !item.dismissed)
          .map((item) =>
            post<Review>(
              "/api/v1/todo-suggestions/review",
              attempted[item.proposal.command.commandId] ?? item.proposal,
            ).catch((error: unknown) => ({
              proposal:
                attempted[item.proposal.command.commandId] ?? item.proposal,
              stale: true,
              problem:
                error instanceof Error ? error.message : "Review unavailable.",
            })),
          ),
      );
      setItems(checked);
      setEdited({});
      if (!checked.length) setMessage("No suggestions in this review.");
    } catch (error) {
      setItems([]);
      setMessage(
        error instanceof Error ? error.message : "Review unavailable.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function dismiss(proposal: Proposal) {
    await post(`/api/v1/todo-suggestions/${id}/dismiss`, {
      commandId: proposal.command.commandId,
    });
    setItems((previous) =>
      previous.filter(
        (item) =>
          item.proposal.command.commandId !== proposal.command.commandId,
      ),
    );
  }
  async function act(proposal: Proposal, apply: boolean) {
    setBusy(true);
    setMessage("");
    try {
      if (apply) {
        if (!attempted[proposal.command.commandId]) {
          const current = await post<Review>(
            "/api/v1/todo-suggestions/review",
            proposal,
          );
          if (current.stale) {
            setItems((previous) =>
              previous.map((item) =>
                item.proposal.command.commandId === proposal.command.commandId
                  ? current
                  : item,
              ),
            );
            throw Error(
              "Stale suggestion. Refresh context and request new advice.",
            );
          }
        }
        proposal = attempted[proposal.command.commandId] ?? proposal;
        const next = { ...attempted, [proposal.command.commandId]: proposal };
        sessionStorage.setItem(
          `todo-suggestion-attempts:${id}`,
          JSON.stringify(next),
        );
        setAttempted(next);
        const result = await saveTodoFacts(proposal.number, {
          ...proposal.command,
          revision: proposal.revision,
        });
        setMessage(
          `${result.message} ${Object.entries(result.outcomes)
            .map(([key, value]) => `${key}: ${value}`)
            .join(" · ")}`,
        );
        await refreshTasks();
        if (Object.values(result.outcomes).some((value) => value !== "saved"))
          return;
      }
      await dismiss(proposal);
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Review unavailable.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Collapsible.Root open={embedded ? true : undefined} lazyMount minW="0" fontSize="sm">
      {!embedded && <Collapsible.Trigger asChild>
        <Button variant="outline" size="sm" alignSelf="start">
          Planning suggestions
        </Button>
      </Collapsible.Trigger>}
      <Collapsible.Content minW="0"><Stack gap="4" pt={embedded ? 0 : "4"}>
        {!embedded && <Text color="fg.muted">
          Review suggested changes before applying them.
        </Text>}
        <Collapsible.Root lazyMount minW="0">
          <Collapsible.Trigger asChild>
            <Button variant="ghost" size="sm" w="full">
              Connect an AI Client
            </Button>
          </Collapsible.Trigger>
          <Collapsible.Content>
            <Text overflowWrap="anywhere" fontSize="xs" color="fg.muted" pt="2">
              Share review ID with your authorized AI Client: <Code variant="plain" wordBreak="break-all">{id}</Code>.
            </Text>
          </Collapsible.Content>
        </Collapsible.Root>
        <Flex wrap="wrap" gap="2">
        <Button
          size="sm"
          variant="outline"
          type="button"
          disabled={!id || busy}
          onClick={() => void load()}
        >
          Refresh suggestions
        </Button>
        <Button
          size="sm"
          variant="outline"
          type="button"
          disabled={busy}
          onClick={() => {
            const next = crypto.randomUUID();
            sessionStorage.setItem("todo-suggestion-review", next);
            setId(next);
            setItems([]);
            setAttempted({});
            setMessage(
              "New review started. Your AI Client can reconsider current context.",
            );
          }}
        >
          New review
        </Button>
        </Flex>
        {message && (
          <Text overflowWrap="anywhere" color="fg.muted" role="status">
            {message}
          </Text>
        )}
        {items.map(({ proposal, stale, problem }) => (
          <Card.Root size="sm" minW="0" rounded="xl"
            key={proposal.command.commandId}
          >
            <Card.Header><Card.Title fontSize="base">Task #{proposal.number}</Card.Title><Card.Description overflowWrap="anywhere">{proposal.reason}</Card.Description></Card.Header>
            <Card.Body gap="4" minW="0">
            {problem && <Alert.Root role="alert" status="error" size="sm"><Alert.Content><Alert.Description>{problem}</Alert.Description></Alert.Content></Alert.Root>}
            {stale && (
              <p>Stale suggestion — refresh context and request new advice.</p>
            )}
            <Stack gap="4">
              {Object.entries(proposal.command.fields ?? {}).map(
                ([key, change]) => (
                  <Field.Root key={key}>
                    <Field.Label htmlFor={`proposal-${proposal.command.commandId}-${key}`}>{key}</Field.Label>
                    <Field.HelperText>Current: {String(change.before ?? "Unknown")}{key === "Estimate" ? " minutes · Proposed minutes (estimate)" : ""}</Field.HelperText>
                    <Input size="sm"
                      id={`proposal-${proposal.command.commandId}-${key}`}
                      aria-label={`Proposed ${key} for task ${proposal.number}`}
                      type={key === "Top priority" ? "text" : "number"}
                      value={change.after ?? ""}
                      disabled={busy || !!attempted[proposal.command.commandId]}
                      onChange={(event) => {
                        setEdited(previous => ({ ...previous, [proposal.command.commandId]: true }));
                        const value = event.target.value;
                        const after =
                          key === "Top priority"
                            ? value
                            : value === ""
                              ? null
                              : Number(value);
                        setItems((previous) =>
                          previous.map((item) =>
                            item.proposal.command.commandId ===
                            proposal.command.commandId
                              ? {
                                  ...item,
                                  proposal: {
                                    ...item.proposal,
                                    command: {
                                      ...item.proposal.command,
                                      fields: {
                                        ...item.proposal.command.fields,
                                        [key]: { before: change.before, after },
                                      },
                                    },
                                  },
                                }
                              : item,
                          ),
                        );
                      }}
                    />
                  </Field.Root>
                ),
              )}
              {proposal.command.start !== undefined && <Box fontSize="sm"><Text fontWeight="medium">Proposed time</Text><Text>{proposal.command.start ?? "Unscheduled"}{proposal.command.end ? ` – ${proposal.command.end}` : ""}</Text></Box>}
            </Stack>
            </Card.Body>
            <Card.Footer flexWrap="wrap" gap="2">
            <Button
              size="sm"
              type="button"
              disabled={
                !writable ||
                busy ||
                (stale && !attempted[proposal.command.commandId])
              }
              onClick={() => void act(proposal, true)}
            >
              {attempted[proposal.command.commandId]
                ? "Reconcile application"
                : "Apply suggestion"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              type="button"
              disabled={!writable || busy}
              onClick={() => {
                editTask(proposal.number);
              }}
            >
              Edit task instead
            </Button>
            <Button
              size="sm"
              variant="outline"
              type="button"
              disabled={!writable || busy}
              onClick={() => void act(proposal, false)}
            >
              Dismiss suggestion
            </Button>
            </Card.Footer>
          </Card.Root>
        ))}
      </Stack></Collapsible.Content>
    </Collapsible.Root>
  );
}
