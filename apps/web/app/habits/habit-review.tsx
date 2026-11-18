"use client";
import { Button, Flex, Stack, Text, VisuallyHidden, chakra } from "@chakra-ui/react";

import { useState } from "react";
import { HabitMarkdown } from "./habit-markdown";
import { habitClient } from "./habits-api";
import type { paths } from "@/lib/generated/quantself-api-schema";
type HabitOverview = paths["/api/v1/habits/overview"]["get"]["responses"][200]["content"]["application/json"];
const shortDate = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString("en", { month: "short", day: "numeric", timeZone: "UTC" });

export function HabitReview({
  date,
  status = "missing",
  retryStatus,
  retrying,
}: {
  date: string;
  status?: HabitOverview["reviewDue"]["status"];
  retryStatus?: () => void;
  retrying?: boolean;
}) {
  const [document, setDocument] = useState<{
    text: string;
    editUrl: string;
  } | null>(null);
  const [createdPath, setCreatedPath] = useState("");
  const [pending, setPending] = useState("");
  const [message, setMessage] = useState("");
  const knownPath =
    createdPath || (status === "exists" ? `reviews/${date}.md` : "");
  const statusUnavailable = !knownPath && status === "unavailable";

  let reviewDescription = "Create a draft to answer in GitHub.";
  if (statusUnavailable) {
    reviewDescription = "Review status unavailable.";
  } else if (knownPath) {
    reviewDescription = "Review document exists. Answer in GitHub.";
  }

  let feedback = message;
  if (pending === "review") {
    feedback = "Loading review…";
  } else if (pending === "copy") {
    feedback = "Copying…";
  }

  async function run(action: "review" | "copy") {
    setPending(action);
    setMessage("");
    try {
      if (action === "review") {
        let path = knownPath;
        if (!path) {
          const { data, error } = await habitClient.POST(
            "/api/v1/habits/review",
            { body: { date } },
          );
          if (!data)
            throw Error(error?.message ?? "Review unavailable. Retry safely.");
          path = data.path;
          setCreatedPath(path);
        }
        const result = await habitClient.GET("/api/v1/habits/document", {
          params: { query: { path } },
        });
        if (!result.data || result.data.stale || result.data.error)
          throw Error("Review document unavailable. Retry to open it.");
        setDocument(result.data);
      } else {
        const { data, error } = await habitClient.GET("/api/v1/habits/context");
        if (!data) throw Error(error?.message ?? "Context unavailable.");
        if (data.unavailable.length)
          throw Error(
            `Context incomplete: ${data.unavailable.join(", ")}. Retry after sources recover.`,
          );
        await navigator.clipboard.writeText(data.text);
        setMessage("Copied. Paste it into your LLM to start the grilling.");
      }
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setPending("");
    }
  }

  return (
    <Stack gap="6">
      <Stack gap="2">
        <Text fontSize="sm" color="fg.muted">
          Week ending {shortDate(date)}.{" "}
          {reviewDescription}
        </Text>
        <Flex flexWrap="wrap" gap="2">
          {statusUnavailable ? (
            retryStatus && (
              <Button
                type="button"
                variant="plain"
                minHeight="10"
                borderRadius="md"
                borderWidth="1px"
                paddingInline="4"
                fontSize="sm"
                css={{
                  _hover: { background: "bg.muted" },
                  _disabled: { opacity: 0.4 },
                }}
                disabled={retrying}
                onClick={retryStatus}
              >
                {retrying ? "Checking review status…" : "Retry review status"}
              </Button>
            )
          ) : (
            <Button
              type="button"
              variant="solid"
              minHeight="10"
              borderRadius="md"
              paddingInline="4"
              fontSize="sm"
              css={{ _hover: { opacity: 0.9 }, _disabled: { opacity: 0.4 } }}
              disabled={!!pending}
              onClick={() => void run("review")}
            >
              {knownPath ? "Open review" : "Start review"}
            </Button>
          )}
          <Button
            type="button"
            variant="plain"
            minHeight="10"
            borderRadius="md"
            borderWidth="1px"
            paddingInline="4"
            fontSize="sm"
            css={{
              _hover: { background: "bg.muted" },
              _disabled: {
                opacity: 0.4,
                _hover: { background: "transparent" },
              },
            }}
            disabled={!!pending}
            onClick={() => void run("copy")}
          >
            Copy as LLM context
          </Button>
        </Flex>
        <Text
          role="status"
          fontSize="sm"
          color="fg.muted"
          css={{ _empty: { display: "none" } }}
        >
          {feedback}
        </Text>
      </Stack>

      {document && (
        <chakra.article borderRadius="lg" background="bg.subtle" padding="4">
          <Flex marginBottom="3" justifyContent="flex-end">
            <chakra.a
              fontSize="sm"
              color="fg.muted"
              textUnderlineOffset="4px"
              css={{ _hover: { color: "fg", textDecoration: "underline" } }}
              href={document.editUrl}
              target="_blank"
              rel="noreferrer"
            >
              Answer in GitHub{" "}
              <VisuallyHidden>(opens in a new tab)</VisuallyHidden>
            </chakra.a>
          </Flex>
          <HabitMarkdown>{document.text}</HabitMarkdown>
        </chakra.article>
      )}
    </Stack>
  );
}
