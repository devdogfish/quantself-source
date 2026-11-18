"use client";

// Job search: "Am I getting hired? Is anyone looking? Who should I follow up with?"
// Filter bar (date sent, résumé, status) → stage bars (Ashby funnel) → Follow up + What recruiters open →
// applications table. A row opens the application in a side drawer (?applicationId=, the id Jobs Review links with).
// One request loads every application with its activity; filtering happens here without refetching.
import { useState } from "react";
import type { Route } from "next";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Badge, Box, Button, CloseButton, Collapsible, Dialog, Drawer, Flex, Grid, HStack, Icon, Input, NativeSelect, Portal, Stack, Text, chakra } from "@chakra-ui/react";
import { ChevronRight, Monitor, Smartphone } from "lucide-react";
import { BarRows } from "@/components/shared/dashboard-charts";
import { DataGrid, DataGridRow, DataPanel } from "@/components/shared/data-panel";
import { FilterSelect } from "@/components/shared/filter-select";
import { toaster } from "@/components/chakra/toaster";
import { AnalyticsShell, FilterBar, ReportState, TableCard, TrackingLine, useReport, useUrlFilters } from "../analytics-shell";
import { jobSearchReportPath, type Application, type JobSearchReport, type Outcome, type Visit } from "../contract";
import {
  activeSeconds, definitions, duration, filterApplications, isWarm, jobType, jobTypeLabels, lastSeen, linkCounts, people, reached, scans, stageLabel,
  stageOf, stages, statusLabel, timePerPage, visitActiveSeconds, when,
} from "./model";

const outcomeLabel: Record<Outcome, string> = { none: "No response", replied: "Replied", interview: "Interview", rejected: "Rejected" };
const outcomeColor: Record<Outcome, string> = { none: "gray", replied: "blue", interview: "green", rejected: "red" };
const date = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC" });
const time = new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit", timeZone: "UTC" });
const ranges = [{ value: "30", label: "Sent in last 30 days" }, { value: "7", label: "Sent in last 7 days" }, { value: "90", label: "Sent in last 90 days" }, { value: "all", label: "All time" }];
const defaults = { range: "30", resume: "all", status: "all", jobType: "all" };

function StageBars({ apps }: { apps: Application[] }) {
  const counts = stages.map((s) => apps.filter((a) => reached(a, s)).length);
  const max = Math.max(1, counts[0]);
  return (
    <Grid templateColumns={{ base: "repeat(2, minmax(0, 1fr))", md: `repeat(${stages.length}, minmax(0, 1fr))` }} borderWidth="1px" rounded="l2" overflow="hidden">
      {stages.map((s, i) => (
        <Stack key={s} gap="3" p="4" borderLeftWidth={{ md: i ? "1px" : "0" }} minW="0">
          <HStack justify="space-between" gap="2">
            <Text textStyle="xs" color="fg.muted" truncate>{stageLabel[s]}</Text>
            {i > 0 && <Text textStyle="xs" color="fg.muted" fontVariantNumeric="tabular-nums" flexShrink={0}>{Math.round((100 * counts[i]) / max)}% of sent</Text>}
          </HStack>
          <Text textStyle="2xl" fontWeight="semibold" lineHeight="1" fontVariantNumeric="tabular-nums">{counts[i]}</Text>
          <Box h="24" display="flex" alignItems="end" bg="bg.subtle" rounded="l1" overflow="hidden">
            <Box w="full" h={`${(100 * counts[i]) / max}%`} bg="colorPalette.solid" opacity={1 - i * 0.14} />
          </Box>
        </Stack>
      ))}
    </Grid>
  );
}

function Progress({ a }: { a: Application }) {
  const stage = stageOf(a);
  if (!stage) return <Text color="fg.muted">—</Text>;
  const at = stages.indexOf(stage);
  return (
    <HStack gap="0.5" aria-label={`Reached ${stageLabel[stage]}`}>
      {stages.map((s, i) => <Box key={s} h="1.5" w="5" rounded="full" bg={i <= at ? (a.outcome === "rejected" && i === at ? "red.solid" : "colorPalette.solid") : "bg.emphasized"} />)}
    </HStack>
  );
}

function Company({ a }: { a: Application }) {
  return <HStack gap="2" minW="0" overflow="hidden"><Text fontWeight="medium" flexShrink={0}>{a.company}</Text><Text color="fg.muted" truncate>{a.role}</Text></HStack>;
}

function VisitRow({ v }: { v: Visit }) {
  const [open, setOpen] = useState(false);
  const pages = v.pages.length;
  return (
    <Collapsible.Root open={open} onOpenChange={(e) => setOpen(e.open)} disabled={!pages}>
      <Collapsible.Trigger asChild>
        <Grid as="button" w="full" textAlign="left" templateColumns="16px 150px minmax(0,1fr) 84px 72px 64px" gap="3" alignItems="center" px="4" py="2.5" textStyle="sm"
          borderTopWidth="1px" borderColor="border.muted" cursor={pages ? "pointer" : "default"} _hover={{ bg: pages ? "bg.subtle" : undefined }} color={v.scanner ? "fg.subtle" : undefined}>
          <Icon as={ChevronRight} boxSize="3.5" color="fg.subtle" visibility={pages ? "visible" : "hidden"} transform={open ? "rotate(90deg)" : undefined} transition="transform 0.15s" />
          <Text fontVariantNumeric="tabular-nums">{date.format(new Date(v.at))}, {time.format(new Date(v.at))}</Text>
          <HStack gap="2" minW="0">
            <Text truncate>{v.link}</Text>
            {v.scanner && <Badge size="sm" variant="outline">Suspected scanner</Badge>}
            {v.ctas.map((c, i) => <Badge key={`${c}:${i}`} size="sm" colorPalette="blue">{c} click</Badge>)}
          </HStack>
          <HStack gap="1.5" color="fg.muted">{v.device && <><Icon as={v.device === "mobile" ? Smartphone : Monitor} boxSize="3.5" />{v.device === "mobile" ? "Mobile" : "Desktop"}</>}</HStack>
          <Text color="fg.muted" textAlign="right">{pages ? `${pages} page${pages > 1 ? "s" : ""}` : "Redirect"}</Text>
          <Text textAlign="right" fontVariantNumeric="tabular-nums">{duration(visitActiveSeconds(v))}</Text>
        </Grid>
      </Collapsible.Trigger>
      <Collapsible.Content>
        <Stack gap="1.5" pl="12" pr="4" pb="3" pt="1">
          {v.pages.map((p, i) => (
            <Grid key={i} templateColumns="160px minmax(0,1fr) 72px 60px" gap="3" alignItems="center" textStyle="xs">
              <Text truncate color="fg.muted">{i + 1}. {p.title}</Text>
              <Box h="1.5" bg="bg.subtle" rounded="full" overflow="hidden"><Box h="full" w={`${p.scrollPercent ?? 0}%`} bg="colorPalette.solid" opacity="0.6" /></Box>
              <Text textAlign="right" color="fg.muted">{p.scrollPercent === null ? "—" : `${p.scrollPercent}% read`}</Text>
              <Text textAlign="right" fontVariantNumeric="tabular-nums">{duration(p.activeSeconds)}</Text>
            </Grid>
          ))}
        </Stack>
      </Collapsible.Content>
    </Collapsible.Root>
  );
}

function ApplicationDetail({ a }: { a: Application }) {
  const [showScans, setShowScans] = useState(false);
  const visible = showScans ? a.visits : people(a);
  const pages = timePerPage(a);
  const max = Math.max(1, ...pages.map((p) => p.seconds));
  const stage = stageOf(a);
  const copy = async () => {
    await navigator.clipboard.writeText(a.portfolioUrl);
    toaster.create({ type: "success", title: "Portfolio link copied" });
  };
  return (
    <Stack gap="5" minW="0">
      <Flex justify="space-between" align="start" gap="3" wrap="wrap">
        <Stack gap="1" minW="0">
          <HStack gap="2"><Text textStyle="lg" fontWeight="semibold">{a.company}</Text><Badge size="sm" variant="surface">{stage ? stageLabel[stage] : "No send recorded"}</Badge></HStack>
          <Text textStyle="sm" color="fg.muted">{a.role}, {a.resumeLabel} résumé{a.sentAt && `, sent ${date.format(new Date(a.sentAt))}`}</Text>
        </Stack>
        <Button size="xs" variant="outline" onClick={copy}>Copy portfolio link</Button>
      </Flex>
      <Grid templateColumns="repeat(4, 1fr)" borderWidth="1px" rounded="l2" overflow="hidden">
        {([["Visits", people(a).length], ["Active time", duration(activeSeconds(a))], ["Pages viewed", new Set(people(a).flatMap((v) => v.pages.map((p) => p.path))).size], ["CTA clicks", people(a).reduce((s, v) => s + v.ctas.length, 0)]] as const).map(([label, value], i) => (
          <Stack key={label} gap="1" p="4" borderLeftWidth={i ? "1px" : 0}>
            <Text textStyle="xs" color="fg.muted">{label}</Text>
            <Text textStyle="xl" fontWeight="semibold" fontVariantNumeric="tabular-nums">{value}</Text>
          </Stack>
        ))}
      </Grid>
      <TableCard title="Time spent per page" help="Active time across all visits by a person.">
        {pages.length ? <Stack gap="2" p="4">{pages.map((p) => (
          <Grid key={p.title} templateColumns="140px minmax(0,1fr) 64px" gap="3" alignItems="center" textStyle="sm">
            <Text truncate color="fg.muted">{p.title}</Text>
            <Box h="5" bg="bg.subtle" rounded="l1" overflow="hidden"><Box h="full" w={`${(100 * p.seconds) / max}%`} bg="colorPalette.solid" /></Box>
            <Text textAlign="right" fontVariantNumeric="tabular-nums">{duration(p.seconds)}</Text>
          </Grid>
        ))}</Stack> : <Text p="4" textStyle="sm" color="fg.muted">No portfolio pages viewed.</Text>}
      </TableCard>
      <TableCard title="Visits" action={scans(a) > 0 ? <Button size="xs" variant="ghost" onClick={() => setShowScans((s) => !s)}>{showScans ? "Hide" : "Show"} {scans(a)} suspected scan{scans(a) > 1 ? "s" : ""}</Button> : undefined}>
        {visible.length ? <Box mt="-1px">{visible.map((v) => <VisitRow key={v.id} v={v} />)}</Box>
          : <Text p="4" textStyle="sm" color="fg.muted">{scans(a) ? "Only scanner opens so far. No person has opened a link." : "No links opened yet."}</Text>}
      </TableCard>
    </Stack>
  );
}

const columns = "minmax(240px, 2.4fr) 112px 70px 130px 56px 72px 84px 100px";
const followCols = "minmax(200px, 1fr) 56px 72px 84px";

export function JobSearch() {
  const params = useSearchParams(), router = useRouter(), pathname = usePathname();
  const report = useReport<JobSearchReport>(jobSearchReportPath);
  const { values: f, set, active, clear } = useUrlFilters(defaults, ["range"]);
  const data = report.data;
  const now = data ? Date.parse(data.generatedAt) : 0;
  const all = data?.applications ?? [];
  const apps = filterApplications(all, f, now);
  const selected = all.find((a) => a.applicationId === params.get("applicationId"));
  const href = (id?: string) => {
    const next = new URLSearchParams(params);
    if (id) next.set("applicationId", id); else next.delete("applicationId");
    return `${pathname}${next.size ? `?${next}` : ""}`;
  };
  const open = (id?: string) => router.replace(href(id) as Route, { scroll: false });
  const warm = apps.filter((a) => isWarm(a, now)).sort((a, b) => lastSeen(b)!.localeCompare(lastSeen(a)!));
  const sent = apps.filter(a => reached(a, "sent"));
  const opened = apps.filter((a) => reached(a, "opened")).length;

  return (
    <AnalyticsShell facts={data ? [
      { label: "Applications", value: apps.length },
      { label: "Opened by a person", value: `${opened} (${Math.round((100 * opened) / Math.max(1, sent.length))}%)` },
      { label: "Follow up", value: warm.length },
      { label: "Responses", value: apps.filter((a) => reached(a, "response")).length },
    ] : undefined}>
      <FilterBar active={active} onClear={clear}
        range={<FilterSelect label="Date sent" value={f.range} onChange={(v) => set({ range: v })} items={ranges} highlightActive={false} size="sm" w="48" />}>
        <FilterSelect label="Job type" value={f.jobType} onChange={(v) => set({ jobType: v, resume: "all" })} size="sm" w="36"
          items={[{ value: "all", label: "All job types" }, ...Object.entries(jobTypeLabels).map(([value, label]) => ({ value, label }))]} />
        <FilterSelect label="Status" value={f.status} onChange={(v) => set({ status: v })} size="sm" w="36"
          items={[{ value: "all", label: "All statuses" }, ...Object.entries(statusLabel).map(([value, label]) => ({ value, label }))]} />
      </FilterBar>

      {!data ? <ReportState {...report} /> : <>
        {report.error && <ReportState loading={false} error={report.error} retry={report.retry} />}
        <StageBars apps={apps} />

        <Grid templateColumns={{ base: "minmax(0,1fr)", lg: "minmax(0,1.7fr) minmax(0,1fr)" }} gap="5" alignItems="start">
          <TableCard title="Follow up" help="Opened by a person, no reply yet, and seen in the last 7 days or more than once.">
            {warm.length ? <>
              <Grid templateColumns={followCols} gap="4" px="5" py="2" textStyle="xs" color="fg.muted" borderBottomWidth="1px">
                <Text>Application</Text><Text textAlign="right">Visits</Text><Text textAlign="right">Active</Text><Text>Last seen</Text>
              </Grid>
              {warm.map((a) => (
                <chakra.button key={a.applicationId} type="button" onClick={() => open(a.applicationId)} display="grid" w="full" textAlign="left"
                  gridTemplateColumns={followCols} gap="4" px="5" py="2.5" alignItems="center" textStyle="sm" fontVariantNumeric="tabular-nums"
                  borderBottomWidth="1px" borderColor="border.muted" _last={{ borderBottomWidth: 0 }} _hover={{ bg: "bg.subtle" }} cursor="pointer">
                  <Company a={a} />
                  <Text textAlign="right">{people(a).length}</Text>
                  <Text textAlign="right">{duration(activeSeconds(a))}</Text>
                  <Text>{when(lastSeen(a)!, now)}</Text>
                </chakra.button>
              ))}
            </> : <Text p="5" textStyle="sm" color="fg.muted">Nobody to follow up with right now.</Text>}
          </TableCard>
          <TableCard title="What recruiters open" help="Visits by a person, counted by the link they opened.">
            {linkCounts(sent).length ? <Box p="3"><BarRows rows={linkCounts(sent)} /></Box> : <Text p="5" textStyle="sm" color="fg.muted">No links opened yet.</Text>}
          </TableCard>
        </Grid>

        <DataPanel>
          <DataGrid columns={columns} minW="1040px" label="Applications" empty="No applications match these filters." headers={[
            { label: "Application" }, { label: "Job type" }, { label: "Sent" }, { label: "Progress" },
            { label: "Visits", align: "right" }, { label: "Active", align: "right" }, { label: "Last seen" }, { label: "Outcome" },
          ]}>
            {apps.map((a) => {
              const seen = lastSeen(a);
              const type = jobType(a);
              return (
                <DataGridRow key={a.applicationId} columns={columns} href={href(a.applicationId)} prefetch={false}
                  linkProps={{ onClick: (e) => { e.preventDefault(); open(a.applicationId); } }}>
                  <Company a={a} />
                  <Text color="fg.muted">{type ? jobTypeLabels[type] : "—"}</Text>
                  <Text color="fg.muted">{a.sentAt ? date.format(new Date(a.sentAt)) : "—"}</Text>
                  <Progress a={a} />
                  <Text textAlign="right">{people(a).length || "—"}</Text>
                  <Text textAlign="right">{duration(activeSeconds(a))}</Text>
                  <Text color={seen ? "fg" : "fg.subtle"}>{seen ? when(seen, now) : "Never"}</Text>
                  {a.outcome === "none" ? <Text color="fg.subtle">—</Text> : <Box><Badge size="sm" colorPalette={outcomeColor[a.outcome]}>{outcomeLabel[a.outcome]}</Badge></Box>}
                </DataGridRow>
              );
            })}
          </DataGrid>
        </DataPanel>

        <Shares report={data} />

        <HStack justify="space-between" gap="4" wrap="wrap">
          <TrackingLine status={data} />
          <Text textStyle="xs" color="fg.muted" maxW="xl">{definitions}</Text>
        </HStack>

        <Drawer.Root open={!!selected} onOpenChange={(e) => { if (!e.open) open(); }} placement="end" size="lg">
          <Portal>
            <Drawer.Backdrop />
            <Drawer.Positioner>
              <Drawer.Content maxW="2xl">
                <Drawer.Title srOnly>{selected ? `${selected.company} application` : "Application"}</Drawer.Title>
                <Drawer.CloseTrigger asChild pos="absolute" top="3" right="3"><CloseButton size="sm" /></Drawer.CloseTrigger>
                <Drawer.Body pt="12">{selected && <ApplicationDetail key={selected.applicationId} a={selected} />}</Drawer.Body>
              </Drawer.Content>
            </Drawer.Positioner>
          </Portal>
        </Drawer.Root>
      </>}
    </AnalyticsShell>
  );
}

const shareColumns = "minmax(8rem, 1fr) 6rem minmax(15rem, 2fr) 3rem 3rem 5rem";
const sharesPath = "/api/v1/website-analytics/shares";
type Share = JobSearchReport["shares"][number];
const audienceLabels = {
  client: "Client",
  frontend: jobTypeLabels.frontend, backend: jobTypeLabels.backend, devops: jobTypeLabels.devops,
  "full-stack": jobTypeLabels["full-stack"], "web-cms": jobTypeLabels["web-cms"], "admin-excel": jobTypeLabels["admin-excel"],
} satisfies Record<NonNullable<JobSearchReport["shares"][number]["track"]>, string>;

function Shares({ report }: { report: JobSearchReport }) {
  const [created, setCreated] = useState<Share[]>([]);
  const [archived, setArchived] = useState<string[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState<Share | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [track, setTrack] = useState("");
  const [requestKey, setRequestKey] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const shares = [...new Map([...created, ...report.shares].map(share => [share.code, share])).values()]
    .map(share => archived.includes(share.code) ? { ...share, archived: true } : share)
    .filter(share => Boolean(share.archived) === showArchived)
    .sort((a, b) => a.title.localeCompare(b.title) || a.code.localeCompare(b.code));

  async function createShare(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || !title.trim()) return;
    const key = requestKey ?? crypto.randomUUID();
    setRequestKey(key);
    setSaving(true);
    setError("");
    try {
      const response = await fetch(sharesPath, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": key },
        body: JSON.stringify({ title: title.trim(), track: track || undefined }),
      });
      if (!response.ok) {
        if (response.status === 400 || response.status === 409) setRequestKey(undefined);
        throw new Error("Couldn’t create the share. Try again.");
      }
      const share: Share = await response.json();
      setCreated(rows => [...rows.filter(row => row.code !== share.code), share]);
      setShowArchived(false);
      setTitle("");
      setTrack("");
      setRequestKey(undefined);
      setCreateOpen(false);
      toaster.create({ type: "success", title: "Share created" });
    } catch {
      setError("Couldn’t confirm creation. Try again to safely retry.");
    } finally {
      setSaving(false);
    }
  }

  async function archiveShare(code: string) {
    setConfirmArchive(null);
    setArchived(codes => [...codes, code]);
    try {
      const response = await fetch(`${sharesPath}/${code}`, { method: "DELETE" });
      if (!response.ok) throw new Error();
    } catch {
      setArchived(codes => codes.filter(value => value !== code));
      toaster.create({ type: "error", title: "Couldn’t confirm archive", description: "Try archiving the share again." });
    }
  }

  async function copyShare(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      toaster.create({ type: "success", title: "Share link copied" });
    } catch {
      toaster.create({ type: "error", title: "Couldn’t copy share link", description: "Select the URL to copy it manually." });
    }
  }

  return (
    <TableCard title="Shares" help="Audience selects the homepage view. Opens include automated requests. Visits count engaged site visits."
      action={<HStack gap="2">
        <Button size="xs" variant="ghost" aria-pressed={showArchived} onClick={() => setShowArchived(value => !value)}>{showArchived ? "Show active" : "Show archived"}</Button>
        <Button size="xs" onClick={() => setCreateOpen(true)}>Create share</Button>
      </HStack>}>
      <DataGrid columns={shareColumns} minW="47rem" label="Shares" empty={showArchived ? "No archived shares." : "No shares yet."} headers={[
        { label: "Share" }, { label: "Audience" }, { label: "Share link" },
        { label: "Opens", align: "right" }, { label: "Visits", align: "right" }, { label: "Actions" },
      ]}>
        {shares.map(share => {
          const { code, title, track, opens, visits } = share;
          const url = `https://girke.dev/r/${code}`;
          const audience = track === null ? "Default" : track ? audienceLabels[track] : "—";
          return (
            <DataGridRow key={code} columns={shareColumns}>
              <Text fontWeight="medium" overflowWrap="anywhere">{title}</Text>
              <Text>{audience}</Text>
              <HStack minW="0" justify="space-between" gap="2">
                <chakra.a href={url} target="_blank" rel="noreferrer" minW="0" overflowWrap="anywhere" _hover={{ textDecoration: "underline" }}>{url}</chakra.a>
                <Button type="button" size="xs" variant="outline" flexShrink="0" aria-label={`Copy share link for ${title}`} onClick={() => void copyShare(url)}>Copy</Button>
              </HStack>
              <Text textAlign="right">{opens}</Text>
              <Text textAlign="right">{visits}</Text>
              {share.archived ? <Text textStyle="xs" color="fg.muted">Archived</Text> : <Button size="xs" variant="ghost"
                aria-label={`Archive ${title}`} onClick={() => setConfirmArchive(share)}>Archive</Button>}
            </DataGridRow>
          );
        })}
      </DataGrid>
      <Dialog.Root open={createOpen} onOpenChange={event => setCreateOpen(event.open)} size="sm">
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content>
              <form onSubmit={createShare}>
                <Dialog.Header><Dialog.Title>Create share</Dialog.Title></Dialog.Header>
                <Dialog.Body as={Stack} gap="4">
                  <Dialog.Description>The name and audience are locked after creation.</Dialog.Description>
                  <Stack gap="1">
                    <chakra.label htmlFor="share-title">Share name</chakra.label>
                    <Input id="share-title" placeholder="e.g. LinkedIn profile" value={title} maxLength={200} required disabled={Boolean(requestKey)}
                      onChange={event => setTitle(event.target.value)} />
                  </Stack>
                  <Stack gap="1">
                    <chakra.label htmlFor="share-audience">Audience</chakra.label>
                    <NativeSelect.Root disabled={Boolean(requestKey)}>
                      <NativeSelect.Field id="share-audience" value={track} onChange={event => setTrack(event.target.value)}>
                        <option value="">Default</option>
                        {Object.entries(audienceLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                      </NativeSelect.Field>
                      <NativeSelect.Indicator />
                    </NativeSelect.Root>
                  </Stack>
                  {error && <Text role="alert" color="fg.error" textStyle="sm">{error}</Text>}
                </Dialog.Body>
                <Dialog.Footer>
                  <Dialog.ActionTrigger asChild><Button type="button" variant="outline">Close</Button></Dialog.ActionTrigger>
                  <Button type="submit" loading={saving} disabled={!title.trim()}>{error && requestKey ? "Retry" : "Create share"}</Button>
                </Dialog.Footer>
              </form>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
      <Dialog.Root open={Boolean(confirmArchive)} onOpenChange={event => { if (!event.open) setConfirmArchive(null); }} size="sm" role="alertdialog">
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content>
              <Dialog.Header><Dialog.Title>Archive share?</Dialog.Title></Dialog.Header>
              <Dialog.Body><Dialog.Description>{confirmArchive?.title} moves to Archived. Its URL keeps working and its analytics stay available.</Dialog.Description></Dialog.Body>
              <Dialog.Footer>
                <Dialog.ActionTrigger asChild><Button variant="outline">Cancel</Button></Dialog.ActionTrigger>
                <Button onClick={() => { if (confirmArchive) void archiveShare(confirmArchive.code); }}>Archive share</Button>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    </TableCard>
  );
}
