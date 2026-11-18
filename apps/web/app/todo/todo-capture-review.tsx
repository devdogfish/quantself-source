"use client";
import { useState } from "react";
import { Button, Flex, Link, Stack, Text, chakra } from "@chakra-ui/react";
import { readTodoJson } from "./todo-live";
import type { components } from "@/lib/generated/quantself-api-schema";
import { useJarvisDraft } from "./jarvis-ui";
export function TodoCaptureReview({ id }: { id: string }) {
  const [result, setResult] = useState<
    components["schemas"]["TodoCaptureResponse"] | null
  >(null);
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  useJarvisDraft(deleting);
  async function deleteSource() {
    setDeleting(true);
    setError("");
    try {
      const response = await fetch(`/api/v1/todo-captures/${id}`, {
        method: "DELETE",
        credentials: "same-origin",
        cache: "no-store",
      });
      const body = await response.json();
      if (!response.ok)
        throw Error(
          body.message || "Deletion failed; retry to finish cleanup.",
        );
      setResult(body);
      setConfirmDelete(false);
    } catch (e) {
      setResult(null);
      setError(
        e instanceof Error
          ? e.message
          : "Deletion failed; retry to finish cleanup.",
      );
    } finally {
      setDeleting(false);
    }
  }
  return (
    <Stack as="section" minW="0" gap="3">
      <Button
        variant="outline" colorPalette="gray"
        size="xs" h="7" fontSize="0.8rem"
        alignSelf="start"
        type="button"
        onClick={() => {
          setError("");
          void readTodoJson<components["schemas"]["TodoCaptureResponse"]>(
            `/api/v1/todo-captures/${id}`,
          )
            .then(setResult)
            .catch((e: Error) => {
              setResult(null);
              setError(e.message);
            });
        }}
      >
        Review original capture
      </Button>
      <Text wordBreak="break-all" fontSize="xs" color="fg.muted">Capture {id}</Text>
      {confirmDelete && (
        <Stack minW="0" gap="3">
          <p>
            Permanently delete original audio and transcript? Task issues
            remain. Requires source deletion permission.
          </p>
          <Flex wrap="wrap" gap="2">
            <Button
              variant="subtle" colorPalette="red"
              size="xs" h="7" fontSize="0.8rem"
              type="button"
              disabled={deleting}
              onClick={() => void deleteSource()}
            >
              {deleting ? "Deleting…" : "Permanently delete source"}
            </Button>
            <Button
              variant="outline" colorPalette="gray"
              size="xs" h="7" fontSize="0.8rem"
              type="button"
              disabled={deleting}
              onClick={() => setConfirmDelete(false)}
            >
              Cancel
            </Button>
          </Flex>
        </Stack>
      )}
      {error && <p role="alert">{error}</p>}
      {result && (
        <Stack minW="0" gap="3">
          {result.capture && (
            <>
              <p>
                {result.capture.source} · {result.capture.capturedAt}
              </p>
              <Text whiteSpace="pre-wrap" overflowWrap="break-word" fontSize="sm" lineHeight="1.625">{result.capture.transcript}</Text>
            </>
          )}
          {result.deleted ? (
            <p>Source deleted by Owner. Task issues retained.</p>
          ) : (
            <>
              <p>
                Audio and transcript retained until you explicitly delete them.
              </p>
              {result.audio && (
                <Stack minW="0" gap="2">
                  <chakra.audio
                    w="full" minW="0"
                    controls
                    preload="none"
                    src={`/api/v1/todo-captures/${id}/audio`}
                    onError={() =>
                      setError(
                        "Audio unavailable. The archived file may need recovery.",
                      )
                    }
                  />
                  <Link variant="underline" display="inline" color="inherit" textDecorationColor="currentColor" fontSize="sm" textDecoration="underline" textUnderlineOffset="4px" href={`/api/v1/todo-captures/${id}/audio?download=1`}>
                    Download original audio
                  </Link>
                </Stack>
              )}
              <Button
                variant="outline" colorPalette="gray"
                size="xs" h="7" fontSize="0.8rem"
                alignSelf="start"
                type="button"
                onClick={() => setConfirmDelete(true)}
              >
                Delete retained source
              </Button>
            </>
          )}
          <p>Source evidence; execution requires separate approval.</p>
          <ul>
            {result.links.map((link) => (
              <li key={link.commandId}>
                {link.number
                  ? `Task #${link.number}`
                  : "Task not yet identified"}{" "}
                · {link.status}
              </li>
            ))}
          </ul>
        </Stack>
      )}
    </Stack>
  );
}
