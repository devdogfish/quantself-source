"use client";

// Jobs Applications: every application on the app's shared table parts (DataPanel → DataToolbar with status tabs →
// FilterSelect row → DataGrid → TablePagination), or as a board. This page owns filtering and selection; it starts
// focused review sessions (/jobs/review?ids=…) from the selected rows or from everything reviewable in the filter.
import { useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { Route } from "next";
import {
  ActionBar, Badge, Box, Button, Checkbox, CloseButton, DataList, Drawer, Field, Flex, HStack, Input, Portal, SegmentGroup, Stack, Text, chakra,
} from "@chakra-ui/react";
import { ArrowUpRightIcon, KanbanIcon, PlayIcon, TableIcon, TriangleAlertIcon, X } from "lucide-react";
import { DataGrid, DataGridRow, DataPanel } from "@/components/shared/data-panel";
import { DataToolbar, copyExportText, downloadText } from "@/components/shared/data-toolbar";
import { FilterSelect } from "@/components/shared/filter-select";
import { PageBody } from "@/components/shared/page-layout";
import { TablePagination } from "@/components/shared/table-pagination";
import { jobInterviewHref, jobsClient, type ApplicationRow, type ApplicationsQuery, type JobInterview, type JobLifecycleChange, type Status, type TabKey, type Track, type Verdict } from "../jobs-client";
import { refreshNativeAppointments } from "../../todo/native-appointments";
import { JobOriginalReplies, JobOriginalReply } from "./job-original-reply";
import {
  JobsError, JobsFrame, LoadState, StatusBadge, StatusDot, ago, daysUntil, dueLabel, issueLabels, reviewable, shortDate, statusMeta, useJobsData, verdictMeta,
} from "../jobs-frame";

type Layout = "table" | "board";
const tabs: { value: TabKey; label: string }[] = [
  { value: "all", label: "All" }, { value: "review", label: "To review" }, { value: "progress", label: "In progress" },
  { value: "attention", label: "Needs attention" }, { value: "applied", label: "Applied" }, { value: "closed", label: "Closed" },
];
const trackLabels: Record<Track, string> = { engineering: "Engineering", web: "Web", admin: "Admin" };
const dueItems = [
  { value: "", label: "Any due date" }, { value: "overdue", label: "Overdue" }, { value: "week", label: "Due in 7 days" },
  { value: "fortnight", label: "Due in 14 days" }, { value: "none", label: "No due date" },
];
const matchItems = [{ value: "", label: "Any match" }, ...(["strong", "review", "weak"] as const).map((v) => ({ value: v, label: verdictMeta[v].label }))];
const trackItems = [{ value: "", label: "All tracks" }, ...(["engineering", "web", "admin"] as const).map((t) => ({ value: t, label: trackLabels[t] }))];
const statusItems = [{ value: "", label: "All statuses" }, ...Object.entries(statusMeta).map(([value, { label }]) => ({ value, label }))];
const sortItems = [{ value: "due", label: "Due soonest" }, { value: "match", label: "Best match" }, { value: "updated", label: "Recently updated" }];
const columns = "20px minmax(0, 1.1fr) minmax(0, 1.7fr) 96px 104px 124px 100px 72px";
const board: { title: string; statuses: Status[]; dot: Status }[] = [
  { title: "Agent drafting", statuses: ["draft"], dot: "draft" },
  { title: "Your review", statuses: ["review"], dot: "review" },
  { title: "Runner", statuses: ["approved", "queued", "submitting"], dot: "submitting" },
  { title: "Needs you", statuses: ["needs_attention"], dot: "needs_attention" },
  { title: "Applied", statuses: ["applied"], dot: "applied" },
  { title: "Interviewing", statuses: ["interviewing"], dot: "interviewing" },
  { title: "Offer", statuses: ["offer"], dot: "offer" },
  { title: "Closed", statuses: ["rejected", "withdrawn", "skipped", "disqualified", "saved_for_later"], dot: "skipped" },
];

export function JobsApplications() {
  const params = useSearchParams(), router = useRouter(), pathname = usePathname();
  const layout: Layout = params.get("layout") === "board" ? "board" : "table";
  const setLayout = (next: Layout) => {
    const query = new URLSearchParams(params);
    query.set("layout", next);
    router.replace(`${pathname}?${query}` as Route, { scroll: false });
  };
  const [q, setQ] = useState("");
  const [tab, setTab] = useState<TabKey>((params.get("tab") as TabKey | null) ?? "all");
  const [track, setTrack] = useState("");
  const [status, setStatus] = useState<Status | "">("");
  const [due, setDue] = useState("");
  const [verdict, setVerdict] = useState("");
  const [sort, setSort] = useState<NonNullable<ApplicationsQuery["sort"]>>("due");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Map<string, ApplicationRow>>(new Map());
  const [open, setOpen] = useState<ApplicationRow>();
  const [starting, setStarting] = useState(false);
  const reset = <T,>(set: (v: T) => void) => (v: T) => { set(v); setPage(1); };

  const query: ApplicationsQuery = {
    tab, q, track: track as Track | "", status, due: due as ApplicationsQuery["due"], verdict: verdict as Verdict | "", sort,
    page: layout === "board" ? 1 : page, pageSize: layout === "board" ? 500 : 15,
  };
  const { data, setData, error, reload } = useJobsData((signal) => jobsClient.applications(query, signal), JSON.stringify(query));
  const filtered = Boolean(q || track || status || due || verdict || tab !== "all");
  const linkedId = params.get("applicationId");
  const openId = open?.id ?? linkedId;
  const closeRecord = () => {
    setOpen(undefined);
    if (!linkedId) return;
    const query = new URLSearchParams(params);
    query.delete("applicationId");
    router.replace((query.size ? `${pathname}?${query}` : pathname) as Route, { scroll: false });
  };
  const recordChanged = (row: ApplicationRow) => {
    setOpen((current) => current?.id === row.id ? row : current);
    setData((current) => current && { ...current, rows: current.rows.map((old) => old.id === row.id ? row : old) });
    setSelected((current) => current.has(row.id) ? new Map(current).set(row.id, row) : current);
    reload();
  };
  const selectedRows = [...selected.values()];
  const selectedReviewable = selectedRows.filter(reviewable);

  const startSession = async () => {
    if (selectedRows.length) return router.push(`/jobs/review?ids=${selectedReviewable.map((r) => r.id).join(",")}` as Route);
    setStarting(true);
    try {
      const { ids } = await jobsClient.reviewableIds({ ...query, page: undefined, pageSize: undefined });
      if (ids.length) router.push(`/jobs/review?ids=${ids.join(",")}` as Route);
    } finally { setStarting(false); }
  };
  const onSelect = (rows: ApplicationRow[], on: boolean) => setSelected((prev) => {
    const next = new Map(prev);
    for (const row of rows) if (on) next.set(row.id, row); else next.delete(row.id);
    return next;
  });
  const csv = () => ["Company,Role,Status,Track,Due", ...(data?.rows ?? []).map((r) =>
    [r.company, r.role, statusMeta[r.status].label, trackLabels[r.track], r.dueAt ?? ""].map((v) => `"${v.replaceAll('"', '""')}"`).join(","))].join("\n");
  const reviewCount = selectedRows.length ? selectedReviewable.length : (data?.tabCounts.review ?? 0);

  return (
    <JobsFrame actions={
      <SegmentGroup.Root size="sm" value={layout} onValueChange={(e) => e.value && setLayout(e.value as Layout)} aria-label="Layout">
        <SegmentGroup.Indicator />
        <SegmentGroup.Items items={[
          { value: "table", label: <HStack gap="1.5"><TableIcon size={14} />Table</HStack> },
          { value: "board", label: <HStack gap="1.5"><KanbanIcon size={14} />Board</HStack> },
        ]} />
      </SegmentGroup.Root>
    }>
      <PageBody>
        <DataPanel>
          <DataToolbar<TabKey> query={q} onQuery={reset(setQ)} placeholder="Search company or role"
            segments={tabs.map((t) => ({ value: t.value, label: data ? `${t.label} ${data.tabCounts[t.value]}` : t.label }))}
            value={tab} onValue={reset(setTab)}
            count={data ? `${data.total} applications` : "Loading…"}
            exportsDisabled={!data}
            copyLabel="Copy as CSV" onCopy={() => copyExportText(async () => csv())}
            downloadLabel="Download CSV" onDownload={() => downloadText(csv(), "applications.csv", "text/csv")} />
          <HStack gap="2" px="2" py="1.5" borderBottomWidth="1px" wrap="wrap">
            <FilterSelect label="Due date" w="36" items={dueItems} value={due} onChange={reset(setDue)} />
            <FilterSelect label="Match" w="32" items={matchItems} value={verdict} onChange={reset(setVerdict)} />
            <FilterSelect label="Status" w="36" items={statusItems} value={status} onChange={reset((v: string) => setStatus(v as Status | ""))} />
            <FilterSelect label="Résumé track" w="32" items={trackItems} value={track} onChange={reset(setTrack)} />
            <FilterSelect label="Sort" w="36" items={sortItems} value={sort} onChange={(v) => setSort(v as typeof sort)} highlightActive={false} />
            {filtered && <Button size="xs" variant="ghost" onClick={() => { setQ(""); setTab("all"); setTrack(""); setStatus(""); setDue(""); setVerdict(""); setPage(1); }}>Clear filters</Button>}
            <Button size="xs" ms="auto" loading={starting} disabled={!reviewCount} onClick={() => void startSession()}>
              <PlayIcon />Review {reviewCount}{selectedRows.length ? " selected" : ""}
            </Button>
          </HStack>
          {!data ? <LoadState error={error} onRetry={reload} label="Loading applications…" />
            : layout === "table"
              ? <ApplicationsTable rows={data.rows} total={data.total} pageSize={data.pageSize} page={page} onPage={setPage}
                  selected={selected} onSelect={onSelect} onOpen={setOpen} />
              : <Board rows={data.rows} onOpen={setOpen} />}
        </DataPanel>
      </PageBody>

      <ActionBar.Root open={selected.size > 0} closeOnInteractOutside={false} onOpenChange={(e) => !e.open && setSelected(new Map())}>
        <Portal>
          <ActionBar.Positioner>
            <ActionBar.Content>
              <ActionBar.SelectionTrigger>{selected.size} selected</ActionBar.SelectionTrigger>
              <ActionBar.Separator />
              <Button size="sm" disabled={!selectedReviewable.length} onClick={() => void startSession()}>
                <PlayIcon />Start review session ({selectedReviewable.length})
              </Button>
              <ActionBar.CloseTrigger asChild><CloseButton size="sm" aria-label="Clear selection"><X /></CloseButton></ActionBar.CloseTrigger>
            </ActionBar.Content>
          </ActionBar.Positioner>
        </Portal>
      </ActionBar.Root>
      {openId && <RecordDrawer key={openId} id={openId}
        initialRow={open ?? data?.rows.find((row) => row.id === openId)} onClose={closeRecord} onUpdate={recordChanged} />}
    </JobsFrame>
  );
}

function ApplicationsTable({ rows, total, pageSize, page, onPage, selected, onSelect, onOpen }: {
  rows: ApplicationRow[]; total: number; pageSize: number; page: number; onPage: (page: number) => void;
  selected: Map<string, ApplicationRow>; onSelect: (rows: ApplicationRow[], on: boolean) => void; onOpen: (row: ApplicationRow) => void;
}) {
  const anchor = useRef<number | null>(null);
  const toggle = (index: number, on: boolean, range: boolean) => {
    const from = range && anchor.current !== null ? Math.min(anchor.current, index) : index;
    const to = range && anchor.current !== null ? Math.max(anchor.current, index) : index;
    onSelect(rows.slice(from, to + 1), on);
    anchor.current = index;
  };
  return (
    <>
      <DataGrid label="Applications" columns={columns} minW="880px" empty="No applications match these filters."
        headers={[{ label: "" }, { label: "Company" }, { label: "Role" }, { label: "Match" }, { label: "Due" }, { label: "Status" }, { label: "Track" }, { label: "Updated", align: "right" }]}>
        {rows.map((row, index) => (
          <DataGridRow key={row.id} columns={columns}>
            {/* Shift-click selects a range; the checkbox sits above the row's stretched button. */}
            <Box position="relative" zIndex="1" userSelect="none"
              onMouseDown={(e) => { if (e.shiftKey) e.preventDefault(); }}
              onClickCapture={(e) => {
                if (!e.shiftKey || anchor.current === null) return;
                e.preventDefault(); e.stopPropagation();
                toggle(index, !selected.has(row.id), true);
              }}>
              <Checkbox.Root size="sm" checked={selected.has(row.id)} onCheckedChange={(e) => toggle(index, Boolean(e.checked), false)}
                aria-label={`Select ${row.company} ${row.role}`}>
                <Checkbox.HiddenInput />
                <Checkbox.Control />
              </Checkbox.Root>
            </Box>
            <chakra.button type="button" textAlign="left" fontWeight="medium" truncate onClick={() => onOpen(row)}
              _after={{ content: '""', position: "absolute", inset: "0" }}
              _focusVisible={{ outline: "none", _after: { outline: "2px solid", outlineColor: "colorPalette.focusRing", outlineOffset: "-2px" } }}>
              {row.company}
            </chakra.button>
            <Text truncate>{row.role}</Text>
            {row.verdict
              ? <HStack gap="1.5" minW="0"><Box boxSize="2" rounded="full" bg={verdictMeta[row.verdict].color} flexShrink={0} /><Text truncate color="fg.muted">{verdictMeta[row.verdict].label}</Text></HStack>
              : <Text color="fg.subtle">—</Text>}
            <Text truncate color={row.dueAt && daysUntil(row.dueAt) < 0 && ["review", "draft", "approved", "queued"].includes(row.status) ? "fg.error" : "fg.muted"}>{dueLabel(row.dueAt)}</Text>
            <Box><StatusBadge row={row} /></Box>
            <Text color="fg.muted" truncate>{trackLabels[row.track]}</Text>
            <Text color="fg.subtle" textAlign="right">{ago(row.updatedAt)}</Text>
          </DataGridRow>
        ))}
      </DataGrid>
      <TablePagination count={total} pageSize={pageSize} page={page} onPageChange={onPage} />
    </>
  );
}

// Board columns are named by whose move it is (Graphite inbox sections).
function Board({ rows, onOpen }: { rows: ApplicationRow[]; onOpen: (row: ApplicationRow) => void }) {
  return (
    <Flex gap="3" px="4" py="4" overflowX="auto" align="start" minH="480px" bg="bg.subtle">
      {board.map((column) => {
        const list = rows.filter((r) => column.statuses.includes(r.status));
        return (
          <Stack key={column.title} w="272px" flexShrink={0} gap="2">
            <HStack px="1" h="8" gap="2" textStyle="sm">
              <StatusDot status={column.dot} />
              <Text fontWeight="medium">{column.title}</Text>
              <Text color="fg.muted" fontVariantNumeric="tabular-nums">{list.length}</Text>
            </HStack>
            {list.map((row) => (
              <Stack key={row.id} as="button" textAlign="left" onClick={() => onOpen(row)} gap="2" bg="bg" borderWidth="1px" rounded="md" p="3" shadow="xs"
                _hover={{ borderColor: "border.emphasized" }}>
                <HStack justify="space-between" gap="2">
                  <Text textStyle="xs" color="fg.muted" truncate>{row.company}</Text>
                  <Text textStyle="xs" color="fg.subtle" flexShrink={0}>{ago(row.updatedAt)}</Text>
                </HStack>
                <Text textStyle="sm" fontWeight="medium" lineClamp={2}>{row.role}</Text>
                {row.status === "needs_attention" && row.issue && (
                  <HStack gap="1.5" textStyle="xs" color="fg.error"><TriangleAlertIcon size={12} />{issueLabels[row.issue]}</HStack>
                )}
                <HStack gap="1.5">
                  <Badge size="sm" variant="outline" colorPalette="gray">{trackLabels[row.track]}</Badge>
                  {row.status === "review" && row.verdict && (
                    <Badge size="sm" variant="subtle" colorPalette={row.verdict === "strong" ? "green" : row.verdict === "review" ? "orange" : "gray"}>{verdictMeta[row.verdict].label}</Badge>
                  )}
                </HStack>
              </Stack>
            ))}
            {list.length === 0 && <Box h="16" borderWidth="1px" borderStyle="dashed" rounded="md" />}
          </Stack>
        );
      })}
    </Flex>
  );
}

const statusActions: Record<JobLifecycleChange["status"], string> = {
  interviewing: "Mark interviewing", offer: "Record offer", rejected: "Mark rejected", withdrawn: "Mark withdrawn",
};

function RecordDrawer({ id, initialRow, onClose, onUpdate }: {
  id: string; initialRow?: ApplicationRow; onClose: () => void; onUpdate: (row: ApplicationRow) => void;
}) {
  const router = useRouter();
  const { data, setData, error, reload } = useJobsData((signal) => jobsClient.lifecycle(id, signal), id);
  const row = data?.application ?? initialRow;
  const [pendingStatus, setPendingStatus] = useState<JobLifecycleChange["status"]>();
  const [statusError, setStatusError] = useState<string>();
  const [addedInterviews, setAddedInterviews] = useState<JobInterview[]>([]);
  const status = pendingStatus ?? row?.status;

  async function updateStatus(status: JobLifecycleChange["status"]) {
    if (!data || pendingStatus) return;
    setPendingStatus(status);
    setStatusError(undefined);
    try {
      const updated = await jobsClient.changeLifecycle(id, { status, expectedRevision: data.revision });
      setData(current => ({
        ...updated,
        verifiedOriginalReplyAvailable: updated.verifiedOriginalReplyAvailable ?? current?.verifiedOriginalReplyAvailable,
        verifiedOriginalReplies: updated.verifiedOriginalReplies ?? current?.verifiedOriginalReplies,
        verifiedOriginalRepliesBefore: updated.verifiedOriginalRepliesBefore === undefined
          ? current?.verifiedOriginalRepliesBefore : updated.verifiedOriginalRepliesBefore,
        canConfirmOriginalReply: updated.canConfirmOriginalReply ?? current?.canConfirmOriginalReply,
      }));
      onUpdate(updated.application);
    } catch (error) {
      setStatusError(error instanceof Error ? error.message : "Could not update the application.");
      reload();
    } finally {
      setPendingStatus(undefined);
    }
  }

  const interviews = [...(data?.appointments ?? []), ...addedInterviews.filter(
    (added) => !data?.appointments.some((saved) => saved.id === added.id),
  )].filter(appointment => appointment.source !== "native" || !appointment.cancelledAt)
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));

  return (
    <Drawer.Root open onOpenChange={(e) => !e.open && onClose()} size="md">
      <Portal>
        <Drawer.Backdrop />
        <Drawer.Positioner>
          <Drawer.Content>
            <Drawer.Header borderBottomWidth="1px" pb="4">
              <Stack gap="1">
                {row && <Text textStyle="xs" color="fg.muted">{row.company}</Text>}
                <Drawer.Title>{row?.role ?? "Application"}</Drawer.Title>
                {row && status && <HStack mt="2" gap="2">
                  <StatusBadge row={{ status }} />
                  <Button size="2xs" variant="outline" asChild><a href={row.sourceUrl} target="_blank" rel="noreferrer">Open posting<ArrowUpRightIcon /></a></Button>
                  {reviewable(row) && <Button size="2xs" onClick={() => router.push(`/jobs/review?ids=${id}` as Route)}><PlayIcon />Review</Button>}
                </HStack>}
              </Stack>
            </Drawer.Header>
            <Drawer.Body py="5">
              <Stack gap="5">
                {row && <DataList.Root orientation="horizontal" size="sm" gap="2.5">
                  {([
                    ["Match", row.verdict ? verdictMeta[row.verdict].label : "—"], ["Due", dueLabel(row.dueAt)], ["Track", trackLabels[row.track]],
                    ["Source", row.source ?? "—"], ["Applied", shortDate(row.appliedAt)], ["Updated", ago(row.updatedAt)],
                    ...(row.issue ? [["Issue", issueLabels[row.issue]]] : []),
                  ] as const).map(([label, value]) => (
                    <DataList.Item key={label}><DataList.ItemLabel minW="24">{label}</DataList.ItemLabel><DataList.ItemValue>{value}</DataList.ItemValue></DataList.Item>
                  ))}
                </DataList.Root>}
                {!data && <LoadState error={error} onRetry={reload} label="Loading application details…" />}
                <JobOriginalReply applicationId={id} legacyLinked={data?.sourceReplyLinked === true}
                  verifiedAvailable={data?.verifiedOriginalReplyAvailable === true} />
                <JobOriginalReplies applicationId={id} replies={data?.verifiedOriginalReplies}
                  before={data?.verifiedOriginalRepliesBefore} canConfirm={data?.canConfirmOriginalReply} onConfirmed={reload} />
                {!!data?.transitions.length && (
                  <HStack gap="2" wrap="wrap">
                    {data.transitions.map((next) => (
                      <Button key={next} size="sm" variant="outline" loading={pendingStatus === next}
                        disabled={Boolean(pendingStatus)} onClick={() => void updateStatus(next)}>{statusActions[next]}</Button>
                    ))}
                  </HStack>
                )}
                {statusError && <JobsError message={statusError} />}
                {interviews.map((interview) => (
                  <Button key={interview.id} size="sm" variant="outline" alignSelf="start" asChild>
                    <a href={jobInterviewHref(interview)}>Interview · {new Date(interview.start).toLocaleString()}<ArrowUpRightIcon /></a>
                  </Button>
                ))}
                {data && (
                  <ScheduleInterview id={id} canSchedule={data.transitions.length > 0} onSaved={(saved) => {
                    setAddedInterviews((prior) => [...prior.filter((interview) => interview.id !== saved.id), saved]);
                    if (saved.source === "native") refreshNativeAppointments();
                  }} />
                )}
              </Stack>
            </Drawer.Body>
            <Drawer.CloseTrigger asChild><CloseButton size="sm" aria-label="Close application" /></Drawer.CloseTrigger>
          </Drawer.Content>
        </Drawer.Positioner>
      </Portal>
    </Drawer.Root>
  );
}

function ScheduleInterview({ id, canSchedule, onSaved }: { id: string; canSchedule: boolean; onSaved: (saved: JobInterview) => void }) {
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string>();
  if (!canSchedule && !saving && !failure) return null;
  return (
    <form onSubmit={async (event) => {
      event.preventDefault();
      if (saving) return;
      const startTime = new Date(start), endTime = new Date(end);
      if (!(endTime.getTime() > startTime.getTime())) {
        setFailure("The interview must end after it starts.");
        return;
      }
      setSaving(true);
      setFailure(undefined);
      try {
        const appointment = await jobsClient.scheduleInterview(id, { start: startTime.toISOString(), end: endTime.toISOString() });
        if (appointment.source === "native" && appointment.cancelledAt) {
          setFailure("This interview was cancelled. Choose a different start time.");
          return;
        }
        onSaved(appointment);
        setStart("");
        setEnd("");
      } catch (error) {
        setFailure(error instanceof Error ? error.message : "Could not confirm the appointment. Retry the same time.");
      } finally {
        setSaving(false);
      }
    }}>
      <Stack gap="2">
        <Field.Root required disabled={saving}>
          <Field.Label>Interview start (local time)</Field.Label>
          <Input type="datetime-local" size="sm" value={start} onChange={(event) => setStart(event.target.value)} />
        </Field.Root>
        <Field.Root required disabled={saving}>
          <Field.Label>Interview end (local time)</Field.Label>
          <Input type="datetime-local" size="sm" value={end} onChange={(event) => setEnd(event.target.value)} />
        </Field.Root>
        <Button type="submit" size="sm" alignSelf="start" loading={saving} loadingText="Scheduling…">Schedule interview</Button>
        {failure && <JobsError message={failure} />}
      </Stack>
    </form>
  );
}
