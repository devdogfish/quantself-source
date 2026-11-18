"use client";

// Shared pieces of the redesigned Jobs area: page frame with area tabs, status visuals, formatting, data loading.
import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Alert, Badge, Box, Button, Kbd, Skeleton, Spinner, Stack, Text } from "@chakra-ui/react";
import { CircleAlertIcon, PlayIcon, RefreshCwIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import type { Route } from "next";
import { toaster } from "@/components/chakra/toaster";
import { AreaNav } from "@/components/shared/area-nav";
import { PageBody, PageHeader, type PageFact } from "@/components/shared/page-layout";
import { jobsClient, type ApplicationRow, type IssueCode, type Pay, type Status, type Verdict } from "./jobs-client";

export const jobsNav = [
  { href: "/jobs/overview", label: "Overview" },
  { href: "/jobs/applications", label: "Applications" },
  { href: "/jobs/submissions", label: "Submissions" },
  { href: "/jobs/profile", label: "Profile" },
];

export function JobsFrame({ actions, facts, children }: { actions?: ReactNode; facts?: PageFact[]; children: ReactNode }) {
  return (
    <Box as="main">
      <PageHeader title="Jobs" actions={<>{actions}<StartReview /></>} facts={facts} nav={<AreaNav label="Jobs views" items={jobsNav} />} />
      {children}
    </Box>
  );
}

/** Starts a focused review session over everything waiting for review. Fetches the list only when clicked. */
function StartReview() {
  const router = useRouter();
  const [starting, setStarting] = useState(false);
  const start = async () => {
    setStarting(true);
    try {
      const { ids } = await jobsClient.reviewableIds({ tab: "review" });
      if (ids.length) router.push(`/jobs/review?ids=${ids.join(",")}` as Route);
      else toaster.create({ type: "info", title: "Nothing is waiting for review." });
    } catch {
      toaster.create({ type: "error", title: "Could not start a review session. Try again." });
    } finally { setStarting(false); }
  };
  return <Button size="sm" loading={starting} onClick={() => void start()}><PlayIcon />Start review</Button>;
}

/** Frame plus the standard body column, for the form-like Jobs pages (Candidate context, Reusable details). */
export function JobsPage({ children, maxW = "6xl" }: { children: ReactNode; maxW?: string }) {
  return <JobsFrame><PageBody maxW={maxW}><Stack gap={{ base: "4", md: "6" }}>{children}</Stack></PageBody></JobsFrame>;
}

export function Shortcut({ children }: { children: ReactNode }) {
  return <Kbd size="sm" variant="subtle" ms="1">{children}</Kbd>;
}

export const statusMeta: Record<Status, { label: string; color: string; palette: string }> = {
  draft: { label: "Drafting", color: "gray.400", palette: "gray" },
  review: { label: "To review", color: "blue.500", palette: "blue" },
  approved: { label: "Approved", color: "teal.500", palette: "teal" },
  queued: { label: "Queued", color: "gray.500", palette: "gray" },
  submitting: { label: "Submitting", color: "orange.400", palette: "orange" },
  applied: { label: "Applied", color: "green.500", palette: "green" },
  interviewing: { label: "Interviewing", color: "purple.500", palette: "purple" },
  offer: { label: "Offer", color: "teal.500", palette: "teal" },
  withdrawn: { label: "Withdrawn", color: "gray.400", palette: "gray" },
  needs_attention: { label: "Needs attention", color: "red.500", palette: "red" },
  skipped: { label: "Skipped", color: "gray.300", palette: "gray" },
  saved_for_later: { label: "Later", color: "purple.400", palette: "purple" },
  rejected: { label: "Rejected", color: "gray.400", palette: "gray" },
  disqualified: { label: "Disqualified", color: "gray.300", palette: "gray" },
};

export const issueLabels: Record<IssueCode, string> = {
  model_error: "Draft failed",
  unsupported_portal: "Unsupported portal",
  manual_required: "Manual step required",
  runner_unavailable: "Runner unavailable",
  submission_uncertain: "Submission unconfirmed",
};

export const verdictMeta: Record<Verdict, { label: string; color: string }> = {
  strong: { label: "Strong fit", color: "green.500" },
  review: { label: "Review", color: "orange.400" },
  weak: { label: "Weak fit", color: "gray.400" },
};

export function StatusDot({ status }: { status: Status }) {
  return <Box flexShrink={0} boxSize="2" rounded="full" bg={statusMeta[status].color} />;
}

export function StatusBadge({ row }: { row: Pick<ApplicationRow, "status"> }) {
  const meta = statusMeta[row.status];
  return <Badge size="sm" variant="subtle" colorPalette={meta.palette}>{meta.label}</Badge>;
}

export const reviewable = (row: Pick<ApplicationRow, "status" | "issue">) =>
  row.status === "review" || (row.status === "needs_attention" && row.issue === "model_error");

const cad = (n: number) => `$${Math.round(n)}`;
/** Hourly CAD, e.g. "$38–$44/h". */
export function payLabel(pay: Pay | null | undefined) {
  if (!pay?.hourlyCad) return null;
  const { min, max } = pay.hourlyCad;
  return min === max ? `${cad(min)}/h` : `${cad(min)}–${cad(max)}/h`;
}

export function ago(iso: string | null) {
  if (!iso) return "—";
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export const daysUntil = (iso: string) => Math.round((Date.parse(iso) - Date.now()) / 86_400_000);
export function dueLabel(iso: string | null) {
  if (!iso) return "—";
  const days = daysUntil(iso);
  if (days < 0) return `${-days}d overdue`;
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  return new Date(iso).toLocaleDateString("en-CA", { month: "short", day: "numeric" });
}
export const shortDate = (iso: string | null) => iso ? new Date(iso).toLocaleDateString("en-CA", { month: "short", day: "numeric" }) : "—";

/** Load once on mount and whenever `key` changes; keeps the last data while reloading. */
export function useJobsData<T>(load: (signal: AbortSignal) => Promise<T>, key: string) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    setError(undefined);
    load(controller.signal).then(
      (next) => { if (!controller.signal.aborted) setData(next); },
      (failure: unknown) => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Could not load Jobs data."); },
    );
    return () => controller.abort();
    // `load` is recreated each render; `key` captures what it depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, attempt]);
  return { data, setData, error, reload, loading: data === undefined && !error };
}

export function LoadState({ error, onRetry, label = "Loading…" }: { error?: string; onRetry: () => void; label?: string }) {
  return (
    <Stack align="center" gap="3" py="20" textStyle="sm" color="fg.muted" role={error ? "alert" : "status"}>
      {error ? <><Text color="fg.error">{error}</Text><Button size="xs" variant="outline" onClick={onRetry}>Try again</Button></> : <><Spinner />{label}</>}
    </Stack>
  );
}

/** Inline loading card for sections (Candidate context, Reusable details). */
export function JobsLoading({ label }: { label: string }) {
  const still = { "@media (prefers-reduced-motion: reduce)": { animation: "none" } };
  return (
    <Stack gap="4" rounded="xl" borderWidth="1px" p="5" role="status" aria-label={label}>
      <Text textStyle="sm" color="fg.muted">{label}</Text>
      <Skeleton h="7" w="60%" css={still} />
      <Skeleton h="4" w="40%" css={still} />
      <Skeleton h="16" w="full" css={still} />
    </Stack>
  );
}

/** Inline error for sections, with an optional retry. */
export function JobsError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <Alert.Root colorPalette="red">
      <CircleAlertIcon />
      <Alert.Title>{message}</Alert.Title>
      {onRetry && (
        <Alert.Description pt="1">
          <Button variant="outline" size="sm" onClick={onRetry}><RefreshCwIcon data-icon="inline-start" />Try again</Button>
        </Alert.Description>
      )}
    </Alert.Root>
  );
}
