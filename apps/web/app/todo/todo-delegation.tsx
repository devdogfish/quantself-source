"use client";
import { Button, Collapsible, Field, Fieldset, Link, Stack, Text, Textarea } from "@chakra-ui/react";
import { useState, useId } from "react";
import type { LiveTodo } from "./todo-live";
import { saveTodoFacts } from "./todo-facts-editor";
import { useJarvisDraft } from "./jarvis-ui";

const briefFields = [
  ["goal", "Goal"],
  ["inputs", "Inputs"],
  ["output", "Output / destination"],
  ["constraints", "Constraints"],
  ["doneWhen", "Done-when"],
] as const;

export function TodoDelegation({
  todo,
  canApprove,
  canWrite,
  disabled,
  onSaved,
}: {
  todo: LiveTodo;
  canApprove: boolean;
  canWrite: boolean;
  disabled: boolean;
  onSaved: () => void;
}) {
  const fieldId = useId();
  const [review, setReview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [attempted, setAttempted] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [brief, setBrief] = useState({
    goal: "",
    inputs: "",
    output: "",
    constraints: "",
    doneWhen: "",
  });
  const [savedBrief, setSavedBrief] = useState(brief);
  useJarvisDraft(busy || review !== null || JSON.stringify(brief) !== JSON.stringify(savedBrief));
  const decision =
    todo.issueType === "Decision" ||
    todo.labels.some((l) => l.startsWith("wayfinder:"));
  const eligible =
    !decision &&
    todo.state === "open" &&
    todo.labels.includes("ready-for-agent") &&
    !todo.labels.some((l) =>
      ["agent:queued", "agent:implement", "agent:in-progress"].includes(l),
    );
  async function saveBrief() {
    setBusy(true);
    try {
      const result = await saveTodoFacts(todo.number, {
        commandId: crypto.randomUUID(),
        agentBrief: brief,
      });
      setMessage(`${result.message} ${JSON.stringify(result.outcomes)}`);
      if (result.outcomes.agentBrief === "saved") setSavedBrief(brief);
      onSaved();
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function approve() {
    if (!review || review !== todo.approvalRevision || attempted === review)
      return;
    setBusy(true);
    setAttempted(review);
    setReview(null);
    try {
      const response = await fetch(`/api/v1/todos/${todo.number}/approval`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          commandId: crypto.randomUUID(),
          revision: review,
          intent: todo.readiness === "ready" ? "execute" : "wait",
          confirmed: true,
        }),
      });
      const result = await response.json();
      if (!response.ok) {
        setMessage(
          result.message ||
            `Approval rejected (HTTP ${response.status}). Refresh and review again.`,
        );
        return;
      }
      setMessage(
        `${result.message} ${Object.entries(result.outcomes ?? {})
          .map(([k, v]) => `${k}: ${v}`)
          .join(" · ")}`,
      );
    } catch {
      setMessage(
        "Approval outcome uncertain. Refresh and inspect runner progress before reviewing again.",
      );
    } finally {
      setBusy(false);
      onSaved();
    }
  }
  return (
    <Stack as="section" minW="0" gap="4">
      <Text as="h3" fontWeight="medium">Delegation and human handoff</Text>
      <p>
        {todo.labels.includes("ready-for-human")
          ? "Ready for human · your action is needed"
          : todo.labels.join(" · ")}
      </p>
      <Text fontSize="sm" color="fg.muted">
        ready-for-agent proposes work. Approval grants no additional authority
        for messages, spending, merging or other external actions. The separate
        runner owns progress, retries and queue release.
      </Text>
      {(todo.comments ?? []).map((comment) => /^\s*<!-- quantself:source\b/.test(comment.body) ? (
        <Collapsible.Root key={comment.id}>
          <Collapsible.Trigger asChild><Button variant="outline" colorPalette="gray" size="xs" h="7" fontSize="0.8rem">Source evidence</Button></Collapsible.Trigger>
          <Collapsible.Content>
            <Stack mt="3" minW="0" gap="2">
              <Link variant="underline" display="inline" color="inherit" textDecorationColor="currentColor" fontSize="sm" textDecoration="underline" textUnderlineOffset="4px" href={comment.url}>Issue update · {comment.updatedAt}</Link>
              <Text whiteSpace="pre-wrap" overflowWrap="break-word" fontSize="xs" color="fg.muted">{comment.body}</Text>
            </Stack>
          </Collapsible.Content>
        </Collapsible.Root>
      ) : (
        <Stack as="article" key={comment.id} minW="0" gap="2">
          <Link variant="underline" display="inline" color="inherit" textDecorationColor="currentColor" fontSize="sm" textDecoration="underline" textUnderlineOffset="4px" href={comment.url}>Issue update · {comment.updatedAt}</Link>
          <Text whiteSpace="pre-wrap" overflowWrap="break-word" fontSize="sm" lineHeight="1.625">{comment.body}</Text>
        </Stack>
      ))}
      {!decision && canWrite && (
        <Fieldset.Root disabled={disabled || busy}>
          <Fieldset.Legend fontSize="md">Prepare Agent Brief</Fieldset.Legend>
          <Fieldset.Content gap="5">
            {briefFields.map(([key, label]) => (
              <Field.Root gap="2" key={key}>
                <Field.Label htmlFor={`${fieldId}-0-${key}`}>{label}</Field.Label>
                <Textarea
                  size="sm" borderColor="border" minH="16"
                  id={`${fieldId}-0-${key}`}
                  value={brief[key]}
                  onChange={(e) =>
                    setBrief({ ...brief, [key]: e.target.value })
                  }
                />
              </Field.Root>
            ))}
            <Button
              variant="outline" colorPalette="gray"
              size="xs" h="7" fontSize="0.8rem"
              disabled={Object.values(brief).some((v) => !v.trim())}
              onClick={() => void saveBrief()}
            >
              Save Agent Brief comment
            </Button>
          </Fieldset.Content>
        </Fieldset.Root>
      )}
      {eligible && canApprove && (
        <>
          <Button
            variant="outline" colorPalette="gray"
            size="xs" h="7" fontSize="0.8rem"
            disabled={
              disabled ||
              busy ||
              !todo.approvalRevision ||
              attempted === todo.approvalRevision
            }
            onClick={() => setReview(todo.approvalRevision ?? null)}
          >
            Review delegation approval
          </Button>
          {review === todo.approvalRevision && review && (
            <Stack minW="0" gap="3" borderRadius="lg" borderWidth="1px" borderColor="border" p="3" role="group" aria-label="Review exact delegation">
              <p>
                Approve #{todo.number}: {todo.title}
              </p>
              <Text whiteSpace="pre-wrap" overflowWrap="break-word" fontSize="sm" lineHeight="1.625">{todo.body}</Text>
              <p>Prerequisites: {todo.readiness ?? "unknown"}</p>
              {(todo.blockedBy ?? []).map((ref) => {
                const prerequisite = todo.prerequisiteStates?.find(
                  (state) => state.id === ref.id,
                );
                return (
                  <p key={ref.id}>
                    {ref.title} · #{ref.number} ·{" "}
                    {prerequisite?.state ?? "unavailable"}{" "}
                    {prerequisite?.closureReason}
                  </p>
                );
              })}
              <p>
                Review the Agent Brief and current issue updates above before
                confirming.
              </p>
              <Button
                variant="outline" colorPalette="gray"
                size="xs" fontSize="0.8rem"
                height="auto" minH="7" whiteSpace="normal" py="2"
                disabled={
                  disabled ||
                  busy ||
                  !todo.comments?.some((c) => /agent brief/i.test(c.body)) ||
                  !todo.readiness ||
                  !!todo.relationshipError
                }
                onClick={() => void approve()}
              >
                {todo.readiness === "ready"
                  ? "Approve execution"
                  : "Approve waiting for prerequisites"}
              </Button>
              <Button
                variant="outline" colorPalette="gray"
                size="xs" h="7" fontSize="0.8rem"
                onClick={() => setReview(null)}
              >
                Cancel approval
              </Button>
            </Stack>
          )}
        </>
      )}
      {message && <Text overflowWrap="break-word" fontSize="sm" color="fg.muted" role="status">{message}</Text>}
    </Stack>
  );
}
