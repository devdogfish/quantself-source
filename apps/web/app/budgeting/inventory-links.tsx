"use client";

import { chakra, Button, Input, Field, Flex, Stack } from "@chakra-ui/react";
import { useEffect, useReducer, useState, type FormEvent } from "react";
import Link from "next/link";
import { budgetRequest, errorMessage } from "./budgeting-client";
import { ItemLinkQueue, type LinkedItem } from "./item-link-queue";

export function InventoryLinks({
  type,
  id,
}: {
  type: "receipt" | "expense";
  id: string;
}) {
  const [opened, setOpened] = useState(false);
  return (
    <chakra.details
      borderRadius="lg"
      borderWidth="1px"
      p="4"
      onToggle={(event) => {
        if (event.currentTarget.open) setOpened(true);
      }}
    >
      <chakra.summary cursor="pointer" fontWeight="medium">
        Linked inventory items
      </chakra.summary>
      {opened && <ItemLinksEditor key={`${type}:${id}`} type={type} id={id} />}
    </chakra.details>
  );
}
function ItemLinksEditor({
  type,
  id,
}: {
  type: "receipt" | "expense";
  id: string;
}) {
  const [, render] = useReducer((value) => value + 1, 0);
  const [queue, setQueue] = useState<ItemLinkQueue | null>(null);
  const [results, setResults] = useState<LinkedItem[]>([]);
  const [error, setError] = useState("");
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    setError("");
    void budgetRequest<"getBudgetItemLinks">(
      `/item-links?type=${type}&id=${id}`,
      "GET",
      undefined,
      abort.signal,
    )
      .then((data) => {
        if (!abort.signal.aborted)
          setQueue(
            new ItemLinkQueue(
              data.items,
              async (change) => {
                await budgetRequest<"setBudgetItemLink">("/item-links", "PUT", {
                  type,
                  id,
                  itemId: change.item.id,
                  linked: change.linked,
                });
              },
              render,
            ),
          );
      })
      .catch((cause) => {
        if (!abort.signal.aborted) setError(errorMessage(cause));
      });
    return () => abort.abort();
  }, [type, id, reload]);
  async function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSearching(true);
    setError("");
    const q = String(new FormData(event.currentTarget).get("query"));
    try {
      setResults(
        (
          await budgetRequest<"searchBudgetInventory">(
            `/item-search?q=${encodeURIComponent(q)}`,
          )
        ).items,
      );
      setSearched(true);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSearching(false);
    }
  }
  return (
    <Stack mt="4" gap="3">
      {!queue && !error && (
        <chakra.p role="status">Loading linked items…</chakra.p>
      )}
      {error && (
        <chakra.p role="alert">
          {error}{" "}
          {!queue && (
            <Button variant="ghost" onClick={() => setReload((n) => n + 1)}>
              Retry
            </Button>
          )}
        </chakra.p>
      )}
      {queue && (
        <>
          {queue.items.length === 0 && (
            <chakra.p fontSize="sm" color="fg.muted">
              No linked items.
            </chakra.p>
          )}
          {queue.items.map((item) => (
            <Flex
              key={item.id}
              alignItems="center"
              justifyContent="space-between"
              gap="2"
            >
              <chakra.span textDecoration="underline">
                <Link href={`/inventory/items/${encodeURIComponent(item.id)}`}>
                  {item.title || "Untitled item"}
                </Link>
              </chakra.span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => queue.change(item, false)}
              >
                Unlink
              </Button>
            </Flex>
          ))}
          <Flex alignItems="center" gap="2">
            <Button
              variant="outline"
              size="sm"
              disabled={!queue.canUndo}
              onClick={() => queue.undo()}
            >
              Undo
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!queue.canRedo}
              onClick={() => queue.redo()}
            >
              Redo
            </Button>
            {queue.saving && !queue.error && (
              <chakra.span role="status" fontSize="xs" color="fg.muted">
                Saving…
              </chakra.span>
            )}
          </Flex>
          {queue.error && (
            <chakra.p role="alert">
              {queue.error}{" "}
              <Button variant="outline" onClick={() => queue.retry()}>
                {queue.blocked ? "Retry save" : "Dismiss"}
              </Button>
            </chakra.p>
          )}
          <chakra.form
            display="flex"
            alignItems="end"
            gap="2"
            onSubmit={search}
          >
            <Field.Root>
              <Field.Label htmlFor={`item-search-${id}`}>
                Find an existing item
              </Field.Label>
              <Input
                id={`item-search-${id}`}
                name="query"
                minLength={2}
                maxLength={100}
                required
              />
            </Field.Root>
            <Button type="submit" variant="outline" disabled={searching}>
              {searching ? "Searching…" : "Search"}
            </Button>
          </chakra.form>
          {searched && !results.length && (
            <chakra.p fontSize="sm">
              No items found. Try a different name.
            </chakra.p>
          )}
          {results
            .filter(
              (item) => !queue.items.some((linked) => linked.id === item.id),
            )
            .map((item) => (
              <Flex
                key={item.id}
                alignItems="center"
                justifyContent="space-between"
                gap="2"
                fontSize="sm"
              >
                <chakra.span>{item.title || "Untitled item"}</chakra.span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => queue.change(item, true)}
                >
                  Link item
                </Button>
              </Flex>
            ))}
          {results.length === 20 && (
            <chakra.p fontSize="xs" color="fg.muted">
              First 20 matches. Narrow your search if needed.
            </chakra.p>
          )}
        </>
      )}
    </Stack>
  );
}
