"use client";

import { Button, HStack, Text, chakra } from "@chakra-ui/react";

import { useEffect, useState, useSyncExternalStore } from "react";
import { Redo2Icon, Undo2Icon } from "lucide-react";
import { TodoNotesEditor } from "../../todo/todo-notes-editor";
import { JobsError, JobsLoading } from "../jobs-frame";
import { createCandidateContextStore } from "./jobs-candidate-context-store";

/** Candidate context: the Markdown facts agents use to answer application questions. Shown on Profile. */
export function JobsCandidateContext() {
  const [store] = useState(createCandidateContextStore);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
  useEffect(() => { void store.load(); }, [store]);

  return (
      <chakra.section css={{ display: "flex", flexDirection: "column", gap: "0.75rem" }} aria-labelledby="candidate-context-title">
        <HStack justify="space-between" gap="3" wrap="wrap">
          <HStack gap="3">
            <Text as="h2" id="candidate-context-title" textStyle="sm" fontWeight="semibold">Candidate context</Text>
            <Text textStyle="xs" color="fg.muted" role="status">{state.saving ? "Saving…" : ""}</Text>
          </HStack>
          {state.loaded && (
            <HStack gap="1">
              <Button type="button" size="xs" variant="ghost" onClick={store.undo} disabled={!state.canUndo}><Undo2Icon data-icon="inline-start" />Undo</Button>
              <Button type="button" size="xs" variant="ghost" onClick={store.redo} disabled={!state.canRedo}><Redo2Icon data-icon="inline-start" />Redo</Button>
            </HStack>
          )}
        </HStack>
        {state.error && <JobsError message={state.error} onRetry={() => void store.retry()} />}
        {!state.loaded && !state.error && <JobsLoading label="Loading candidate context…" />}
        {state.loaded && (
          <>
            {state.conflict && (
              <chakra.div
                role="alert"
                css={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.75rem",
                  borderRadius: "lg",
                  borderWidth: "1px",
                  padding: "0.75rem",
                }}
              >
                <chakra.p css={{ fontSize: "sm" }}>
                  Another session saved changes. Compare its version below with your draft, then choose which to keep.
                </chakra.p>
                <chakra.details>
                  <chakra.summary
                    css={{
                      cursor: "pointer",
                      fontSize: "sm",
                      fontWeight: "medium",
                    }}
                  >
                    Show saved version
                  </chakra.summary>
                  <chakra.pre
                    css={{
                      marginTop: "0.5rem",
                      whiteSpace: "pre-wrap",
                      overflowWrap: "break-word",
                      borderRadius: "sm",
                      background: "bg.muted",
                      padding: "0.75rem",
                      fontSize: "sm",
                    }}
                  >
                    {state.conflict.markdown || "Empty document"}
                  </chakra.pre>
                </chakra.details>
                <chakra.div css={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
                  <Button type="button" size="sm" variant="outline" onClick={() => store.resolve("saved")}>
                    Use saved version
                  </Button>
                  <Button type="button" size="sm" onClick={() => store.resolve("draft")}>
                    Save my draft
                  </Button>
                </chakra.div>
              </chakra.div>
            )}
            <chakra.div
              css={{
                minHeight: "12rem",
                borderRadius: "lg",
                borderWidth: "1px",
                paddingInline: "1.25rem",
                paddingBlock: "1rem",
                "& [role=textbox]": { maxHeight: "none", overflow: "visible", fontSize: "15px", lineHeight: "1.6" },
              }}
            >
              <TodoNotesEditor
              label="Candidate context" placeholder="Add résumé facts and confirmed preferences"
              readOnly={false} value={state.markdown} onCommit={(_before, after) => store.edit(after)}
            />
            </chakra.div>
          </>
        )}
      </chakra.section>
  );
}

