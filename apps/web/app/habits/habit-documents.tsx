"use client";
import { Button, Flex, Stack, Text, chakra } from "@chakra-ui/react";
import { useEffect, useRef, useState } from "react";
import { HabitMarkdown } from "./habit-markdown";
import { habitClient } from "./habits-api";
type Document = {
  path: string;
  text: string;
  editUrl: string;
  stale: boolean;
  error: string | null;
};
export function HabitDocuments() {
  const [pane, setPane] = useState<"system" | "playbook" | "reviews">("system");
  const [document, setDocument] = useState<Document | null>(null),
    [docError, setDocError] = useState(""),
    [loading, setLoading] = useState(false);
  const [reviews, setReviews] = useState<string[]>([]),
    [offset, setOffset] = useState<number | null>(0),
    [reviewError, setReviewError] = useState("");
  const selection = useRef(0);
  const requestedReviewOffset = useRef(0);
  const requestedPath = useRef("SYSTEM.md");
  const [reviewsLoading, setReviewsLoading] = useState(false);
  async function loadDocument(path: string) {
    requestedPath.current = path;
    const version = ++selection.current;
    setLoading(true);
    setDocument(null);
    setDocError("");
    try {
      const { data, error } = await habitClient.GET("/api/v1/habits/document", {
        params: { query: { path } },
      });
      if (version !== selection.current) return;
      if (!data) throw Error(error?.message ?? "Document unavailable.");
      setDocument(data);
    } catch (e) {
      if (version === selection.current) setDocError(String(e));
    } finally {
      if (version === selection.current) setLoading(false);
    }
  }
  async function loadReviews(start: number) {
    requestedReviewOffset.current = start;
    setReviewsLoading(true);
    setReviewError("");
    try {
      const { data } = await habitClient.GET("/api/v1/habits/reviews", {
        params: { query: { offset: start } },
      });
      if (!data) throw Error("Reviews unavailable.");
      setReviews((old) =>
        start === 0 ? data.paths : [...new Set([...old, ...data.paths])],
      );
      setOffset(data.next);
      setReviewError(data.error ?? (data.stale ? "Reviews stale." : ""));
    } catch (e) {
      setReviewError(String(e));
    } finally {
      setReviewsLoading(false);
    }
  }
  useEffect(() => {
    void loadDocument("SYSTEM.md");
  }, []);
  const textButton = {
    fontSize: "sm",
    color: "fg.muted",
    textUnderlineOffset: "4px",
    _hover: { color: "fg", textDecoration: "underline" },
  } as const;
  const tab = (active: boolean) =>
    ({
      minHeight: "9",
      borderRadius: "md",
      paddingInline: "3",
      fontSize: "sm",
      background: active ? "bg.muted" : "transparent",
      fontWeight: active ? "medium" : "normal",
      color: active ? "fg" : "fg.muted",
      _hover: { color: "fg" },
    }) as const;
  const showDocument =
    document &&
    document.path === requestedPath.current &&
    (pane !== "reviews" || document.path.startsWith("reviews/"));
  const documentView = (
    <Stack gap="3">
      <Text
        role="status"
        fontSize="sm"
        color="fg.muted"
        css={{ _empty: { display: "none" } }}
      >
        {loading
          ? "Loading document…"
          : docError ||
            document?.error ||
            (document?.stale ? "Document may be out of date." : "")}
      </Text>
      {(docError || document?.stale || document?.error) && (
        <Button
          variant="plain"
          type="button"
          css={textButton}
          onClick={() => void loadDocument(requestedPath.current)}
        >
          Retry document
        </Button>
      )}
      {showDocument && (
        <chakra.article borderRadius="lg" background="bg.subtle" padding="4">
          <Flex
            marginBottom="3"
            alignItems="baseline"
            justifyContent="space-between"
            gap="3"
          >
            <chakra.span fontFamily="mono" fontSize="xs" color="fg.muted">
              {document.path === "SYSTEM.md"
                ? "System"
                : document.path === "playbook.md"
                  ? "Playbook"
                  : document.path
                      .replace(/^reviews\//, "")
                      .replace(/\.md$/, "")}
            </chakra.span>
            <chakra.a
              css={textButton}
              href={document.editUrl}
              target="_blank"
              rel="noreferrer"
            >
              Edit in GitHub
            </chakra.a>
          </Flex>
          <HabitMarkdown>{document.text}</HabitMarkdown>
        </chakra.article>
      )}
    </Stack>
  );
  return (
    <chakra.section css={{ "& > :not(:last-child)": { marginBottom: "6" } }}>
      <Flex
        flexWrap="wrap"
        alignItems="center"
        justifyContent="space-between"
        gap="3"
      >
        <chakra.nav
          aria-label="Habit documents"
          display="flex"
          flexWrap="wrap"
          gap="1"
        >
          <Button
            variant="plain"
            type="button"
            css={tab(pane === "system")}
            aria-pressed={pane === "system"}
            onClick={() => {
              setPane("system");
              void loadDocument("SYSTEM.md");
            }}
          >
            System
          </Button>
          <Button
            variant="plain"
            type="button"
            css={tab(pane === "playbook")}
            aria-pressed={pane === "playbook"}
            onClick={() => {
              setPane("playbook");
              void loadDocument("playbook.md");
            }}
          >
            Playbook
          </Button>
          <Button
            variant="plain"
            type="button"
            css={tab(pane === "reviews")}
            aria-pressed={pane === "reviews"}
            onClick={() => {
              setPane("reviews");
              selection.current++;
              requestedPath.current = "";
              setDocument(null);
              setDocError("");
              setLoading(false);
              void loadReviews(0);
            }}
          >
            Past reviews
          </Button>
        </chakra.nav>
      </Flex>

      {pane === "reviews" && (
        <Stack gap="2">
          <Text
            role="status"
            fontSize="sm"
            color="fg.muted"
            css={{ _empty: { display: "none" } }}
          >
            {reviewsLoading ? "Loading reviews…" : reviewError}
          </Text>
          {!reviewsLoading && !reviewError && reviews.length === 0 && (
            <Text fontSize="sm" color="fg.muted">
              No past reviews yet. Start your first review from Overview.
            </Text>
          )}
          {!reviewsLoading && reviews.length > 0 && !requestedPath.current && (
            <Text fontSize="sm" color="fg.muted">
              Choose a review to read.
            </Text>
          )}
          {reviewError && (
            <Button
              variant="plain"
              type="button"
              css={textButton}
              onClick={() => void loadReviews(requestedReviewOffset.current)}
            >
              Retry reviews
            </Button>
          )}
          <chakra.ul display="flex" flexWrap="wrap" gap="1">
            {reviews.map((path) => (
              <li key={path}>
                <Button
                  variant="plain"
                  type="button"
                  css={tab(requestedPath.current === path)}
                  aria-pressed={requestedPath.current === path}
                  onClick={() => void loadDocument(path)}
                >
                  {path.replace(/^reviews\//, "").replace(/\.md$/, "")}
                </Button>
              </li>
            ))}
            {offset !== null && (
              <li>
                <Button
                  variant="plain"
                  type="button"
                  css={tab(false)}
                  onClick={() => void loadReviews(offset)}
                >
                  More…
                </Button>
              </li>
            )}
          </chakra.ul>
        </Stack>
      )}

      {documentView}
    </chakra.section>
  );
}
