"use client";

import { useEffect, useRef, useState } from "react";
import { Box, Button, HStack, Input, Stack, Text, Textarea } from "@chakra-ui/react";
import type { components } from "@/lib/generated/quantself-api-schema";
import { readTodoJson } from "../todo-live";

type Todo = components["schemas"]["AgentInboxTodo"];
type Page = { todos: Todo[]; nextCursor: string | null };
type Change = Partial<Pick<Todo, "title" | "note" | "completed">>;
const endpoint = "/api/v1/agent-inbox-todos";

async function apply(url: string, init: RequestInit) {
  const response = await fetch(url, { ...init, credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(15_000) });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.message ?? "Could not save this To-do.");
  }
  return response;
}

export function AgentInboxRows({ state, canWrite, showEmpty }: { state: "inbox" | "done"; canWrite: boolean; showEmpty: boolean }) {
  const [page, setPage] = useState<Page>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [version, reload] = useState(0);
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const loadMore = useRef<AbortController | null>(null);
  const path = `${endpoint}?state=${state}`;

  useEffect(() => {
    const request = new AbortController();
    void readTodoJson<Page>(path, request.signal).then(result => {
      if (!request.signal.aborted) setPage(result);
    }).catch(() => {
      if (!request.signal.aborted) setError("Could not load Agent-created To-dos.");
    }).finally(() => {
      if (!request.signal.aborted) setLoading(false);
    });
    return () => {
      request.abort();
      loadMore.current?.abort();
    };
  }, [path, version]);

  async function more() {
    if (!page?.nextCursor || loadMore.current) return;
    const request = new AbortController();
    loadMore.current = request;
    setError("");
    setLoading(true);
    try {
      const next = await readTodoJson<Page>(`${path}&cursor=${encodeURIComponent(page.nextCursor)}`, request.signal);
      if (!request.signal.aborted) setPage(current => {
        if (!current) return next;
        const loaded = new Set(current.todos.map(todo => todo.id));
        return { ...next, todos: [...current.todos, ...next.todos.filter(todo => !loaded.has(todo.id))] };
      });
    } catch {
      if (!request.signal.aborted) setError("Could not load more To-dos.");
    } finally {
      if (loadMore.current === request) loadMore.current = null;
      if (!request.signal.aborted) setLoading(false);
    }
  }

  function hide(id: string, value: boolean) {
    setHidden(current => {
      const next = new Set(current);
      if (value) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  const todos = page?.todos ?? [];
  return <Box>
    {todos.map(todo => <InboxRow key={todo.id} todo={todo} hidden={hidden.has(todo.id)} canWrite={canWrite}
      onHide={value => hide(todo.id, value)} />)}
    {loading && <Text role="status" px="4" py="2" textStyle="sm" color="fg.muted">Loading To-dos…</Text>}
    {error && <HStack px="4" py="2"><Text role="alert" textStyle="sm">{error}</Text>
      <Button size="xs" variant="outline" onClick={() => {
        if (page?.nextCursor) void more();
        else { setError(""); setLoading(true); reload(current => current + 1); }
      }}>Retry</Button>
    </HStack>}
    {!loading && !error && page?.nextCursor &&
      <Button size="xs" variant="ghost" mx="4" my="2" onClick={() => void more()}>Load more To-dos</Button>}
    {!loading && !error && showEmpty && todos.every(todo => hidden.has(todo.id)) && <Text px="4" py="2" textStyle="sm" color="fg.muted">Nothing here.</Text>}
  </Box>;
}

function InboxRow({ todo, hidden, canWrite, onHide }: {
  todo: Todo; hidden: boolean; canWrite: boolean; onHide: (value: boolean) => void;
}) {
  const [saved, setSaved] = useState(todo);
  const [optimistic, setOptimistic] = useState<Change>();
  const [draft, setDraft] = useState<Pick<Todo, "title" | "note">>();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const retry = useRef<{ body: string; key: string }>(null);
  const current = { ...saved, ...optimistic };

  async function change(fields: Change) {
    const body = JSON.stringify({ expectedRevision: saved.revision, ...fields });
    const key = retry.current?.body === body ? retry.current.key : crypto.randomUUID();
    retry.current = { body, key };
    setPending(true);
    setError("");
    setOptimistic(fields);
    if (fields.completed !== undefined) onHide(true);
    try {
      const response = await apply(`${endpoint}/${saved.id}`, {
        method: "PATCH", headers: { "content-type": "application/json", "idempotency-key": key }, body,
      });
      const result: { todo: Todo } = await response.json();
      setSaved(result.todo);
      setDraft(current => current === draft ? undefined : current);
      retry.current = null;
    } catch (error) {
      if (fields.completed !== undefined) onHide(false);
      setError(error instanceof Error ? error.message : "Could not save this To-do.");
    } finally {
      setPending(false);
      setOptimistic(undefined);
    }
  }

  async function undo() {
    setPending(true);
    setError("");
    onHide(true);
    try {
      await apply(`/api/v1/agent-audit/${saved.auditId}/undo`, { method: "POST" });
    } catch (error) {
      onHide(false);
      setError(error instanceof Error ? error.message : "Could not undo creation.");
    } finally {
      setPending(false);
    }
  }

  if (hidden) return null;
  return <Stack px="4" py="2" borderBottomWidth="1px" borderColor="border.muted" gap="1">
    <HStack justify="space-between" wrap="wrap">
      <Text fontWeight="medium" textStyle="sm" overflowWrap="anywhere">{current.title}</Text>
      {canWrite && <HStack>
        <Button size="xs" variant="ghost" disabled={pending} onClick={() => setDraft({ title: current.title, note: current.note })}>Edit</Button>
        <Button size="xs" variant="ghost" disabled={pending} onClick={() => void change({ completed: !current.completed })}>{current.completed ? "Reopen" : "Complete"}</Button>
        {saved.auditId && <Button size="xs" variant="ghost" disabled={pending} onClick={() => void undo()}>Undo creation</Button>}
      </HStack>}
    </HStack>
    {draft ? <form onSubmit={event => {
      event.preventDefault();
      if (!pending && draft.title.trim()) void change({ ...draft, title: draft.title.trim() });
    }}>
      <Stack gap="1">
        <Input size="sm" aria-label="To-do title" required maxLength={256} value={draft.title} onChange={event => setDraft({ ...draft, title: event.target.value })} />
        <Textarea size="sm" aria-label="To-do note" maxLength={10000} value={draft.note} onChange={event => setDraft({ ...draft, note: event.target.value })} />
        <HStack>
          <Button type="submit" size="xs" disabled={pending || !draft.title.trim()}>Save</Button>
          <Button size="xs" variant="ghost" onClick={() => setDraft(undefined)}>Cancel</Button>
        </HStack>
      </Stack>
    </form> : current.note && <Text textStyle="sm" color="fg.muted" whiteSpace="pre-wrap" overflowWrap="anywhere">{current.note}</Text>}
    {pending && <Text role="status" textStyle="xs" color="fg.muted">Saving…</Text>}
    {error && <Text role="alert" textStyle="sm">{error}</Text>}
  </Stack>;
}
