"use client";

// Jobs Review: a focused session over applications chosen in Applications (/jobs/review?ids=…). One top bar.
// Left: the posting as a brief (pay in hourly CAD and remote first, then an Oura-style workload card).
// Right: only the tailored Summary (the one part that changes per job), switching to the whole résumé, both as live Markdown.
// The real PDF opens on demand in a lightbox. Decisions and edits are optimistic; each item's writes run in order so an approval
// always targets the revision that includes earlier edits.
// Keys: 1 Approve, 2 Skip, R Revise with AI, H Later, X Reject, Z Undo, J/K next/previous, F summary/whole résumé, P PDF preview,
//       D original posting, Esc leave the editor, then exit.
import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { Route } from "next";
import {
  AbsoluteCenter, Badge, Box, Button, DataList, Flex, Grid, HStack, Heading, IconButton, Progress, ProgressCircle, SegmentGroup, Stack, Text, Textarea,
} from "@chakra-ui/react";
import { ArrowUpRightIcon, CheckIcon, ChevronLeftIcon, ChevronRightIcon, CircleHelpIcon, ClockIcon, FileTextIcon, HouseIcon, PiggyBankIcon, TrendingUpIcon, UsersIcon, XIcon } from "lucide-react";
import { toaster } from "@/components/chakra/toaster";
import { TodoNotesEditor } from "../../todo/todo-notes-editor";
import { ResumePreviewDialog } from "./review-resume-preview";
import { ResumeMarkdownShortcuts } from "./resume-markdown-shortcuts";
import { MissingBriefForm } from "./missing-brief-form";
import { JobsApiError, jobsClient, type ApplicationDetail, type Brief, type Decision } from "../jobs-client";
import { JobsFrame, LoadState, Shortcut, payLabel, useJobsData } from "../jobs-frame";

type Panel = "revise" | "reject" | undefined;
type Session = ReturnType<typeof useReviewSession>;
type ResumeChange = Pick<Partial<ApplicationDetail>, "summaryMarkdown" | "resumeMarkdown">;
type BriefCommand = { revision: number; brief: Brief; key: string };
type BriefSave = { pending: boolean; error?: string; retry?: BriefCommand };
const rejectReasons = ["Wrong fit", "Factual error", "Tone", "Duplicate", "Location or salary"];
const decisionLabels: Record<Decision["action"], string> = {
  approve: "Approved", skip: "Skipped", later: "Later", reject: "Rejected", revise: "Revision requested", retry_draft: "Draft retried", reopen: "Reopened",
};
const isDraftFailure = (a: ApplicationDetail) => a.status === "needs_attention" && a.issue === "model_error";

export function ReviewSessionPage() {
  const ids = (useSearchParams().get("ids") ?? "").split(",").filter(Boolean);
  const key = ids.join(",");
  const { data, error, reload } = useJobsData((signal) => jobsClient.reviewSession(ids, signal), key);
  if (!ids.length) return <NoSession />;
  if (!data) return <JobsFrame><LoadState error={error} onRetry={reload} label="Loading review session…" /></JobsFrame>;
  if (!data.items.length) return <NoSession />;
  return <ReviewSession key={key} initial={data.items} />;
}

// A session always starts from Applications or the header's Start review button.
function NoSession() {
  const router = useRouter();
  useEffect(() => { router.replace("/jobs/applications?tab=review" as Route); }, [router]);
  return null;
}

// ---------- Session state, writes and keys ----------

function useReviewSession(initial: ApplicationDetail[]) {
  const router = useRouter();
  const [items, setItems] = useState(initial);
  const [index, setIndex] = useState(0);
  const [decisions, setDecisions] = useState<Record<string, Decision["action"]>>({});
  const [history, setHistory] = useState<string[]>([]);
  // Only drafts already parked when the session starts need explicit Resume. A Later
  // decision made here stays in local history so Undo can reopen it optimistically.
  const [paused, setPaused] = useState(() => new Set(initial.filter((a) => a.status === "saved_for_later").map((a) => a.id)));
  const [reopening, setReopening] = useState<Record<string, boolean>>({});
  const [briefSaves, setBriefSaves] = useState<Record<string, BriefSave>>({});
  const [panel, setPanel] = useState<Panel>();
  const [postingOverride, setPostingOverride] = useState<boolean>();
  const [expanded, setExpanded] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [instructions, setInstructions] = useState("");
  const [reasons, setReasons] = useState<string[]>([]);
  const reviseRef = useRef<HTMLTextAreaElement>(null);
  const latest = useRef(new Map(initial.map((a) => [a.id, a])));
  const pendingEdits = useRef(new Map<string, ResumeChange[]>());
  const chains = useRef(new Map<string, Promise<unknown>>());
  const loaded = useRef(new Map(initial.map((a) => [a.id, a.revision])));
  const done = Object.keys(decisions).length;
  const finished = done === items.length;
  const current = items[index];
  const hasPosting = Boolean(current?.postingText.trim());
  const showPosting = hasPosting && (postingOverride ?? !current?.brief);
  const togglePosting = () => { if (hasPosting) setPostingOverride(!showPosting); };
  const decided = current ? decisions[current.id] : undefined;
  const needsResume = Boolean(current && paused.has(current.id));
  const lastId = history.at(-1);
  const exit = () => router.push("/jobs/applications" as Route);

  const replace = (next: ApplicationDetail) => {
    latest.current.set(next.id, next);
    const visible = Object.assign({}, next, ...(pendingEdits.current.get(next.id) ?? []));
    setItems((all) => all.map((a) => (a.id === next.id ? visible : a)));
  };
  /** Runs one write after the item's earlier writes, against the newest known revision. */
  const enqueue = (id: string, task: (item: ApplicationDetail) => Promise<void>) => {
    const run = (chains.current.get(id) ?? Promise.resolve()).catch(() => {}).then(() => task(latest.current.get(id)!));
    chains.current.set(id, run);
    return run;
  };
  const failure = (title: string, error: unknown) => toaster.create({
    type: "error", title, description: error instanceof JobsApiError ? error.message : undefined, duration: 8000,
  });

  const go = (next: number) => {
    const nextIndex = Math.max(0, Math.min(items.length - 1, next));
    setIndex(nextIndex);
    if (nextIndex !== index) setPostingOverride(undefined);
    setPanel(undefined); setInstructions(""); setReasons([]); setExpanded(false); setPreviewing(false);
  };
  const decide = (decision: Decision) => {
    if (!current || decided || needsResume) return;
    const id = current.id;
    const taken = { ...decisions, [id]: decision.action };
    setDecisions(taken);
    setHistory((h) => [...h, id]);
    for (let step = 1; step <= items.length; step++) {
      const i = (index + step) % items.length;
      if (!taken[items[i].id]) { go(i); break; }
      if (step === items.length) go(index);
    }
    void enqueue(id, async (item) => {
      try {
        const { application } = await jobsClient.decide(id, item.revision, decision);
        replace({ ...item, ...application });
      } catch (error) {
        setDecisions((d) => { const next = { ...d }; delete next[id]; return next; });
        setHistory((h) => h.filter((x) => x !== id));
        failure(`${decisionLabels[decision.action]} was not saved for ${item.company}`, error);
      }
    });
  };
  const resumeReview = (id: string) => {
    if (!paused.has(id) || reopening[id]) return;
    setReopening((pending) => ({ ...pending, [id]: true }));
    void enqueue(id, async (item) => {
      try {
        const { application } = await jobsClient.decide(id, item.revision, { action: "reopen" });
        replace({ ...item, ...application });
        setPaused((ids) => { const next = new Set(ids); next.delete(id); return next; });
      } catch (error) {
        failure(`Review could not be resumed for ${item.company}`, error);
      } finally {
        setReopening((pending) => {
          const next = { ...pending };
          delete next[id];
          return next;
        });
      }
    });
  };
  // Undo reopens the application for review on the server too.
  const undo = () => {
    if (!lastId) return;
    const id = lastId, action = decisions[id];
    setHistory((h) => h.slice(0, -1));
    setDecisions((d) => { const next = { ...d }; delete next[id]; return next; });
    go(items.findIndex((a) => a.id === id));
    void enqueue(id, async (item) => {
      try {
        const { application } = await jobsClient.decide(id, item.revision, { action: "reopen" });
        replace({ ...item, ...application });
      } catch (error) {
        setDecisions((d) => ({ ...d, [id]: action }));
        setHistory((h) => [...h, id]);
        failure(`Undo was not saved for ${item.company}`, error);
      }
    });
  };
  const save = (id: string, change: ResumeChange) => {
    if (paused.has(id)) return;
    const before = latest.current.get(id)!;
    const pending = pendingEdits.current.get(id) ?? [];
    pending.push(change);
    pendingEdits.current.set(id, pending);
    replace(before);
    void enqueue(id, async (item) => {
      let next = { ...item, ...change };
      try {
        const { application } = await jobsClient.saveResume(id, item.revision, change);
        next = application;
      } catch (error) {
        failure(`Your edit to ${item.company} was not saved`, error);
      } finally {
        pending.shift();
        if (!pending.length) pendingEdits.current.delete(id);
        replace(next);
      }
    });
  };
  const saveBrief = (id: string, brief: Brief) => {
    const prior = briefSaves[id];
    if (prior?.pending) return;
    setBriefSaves((all) => ({ ...all, [id]: { pending: true, retry: prior?.retry } }));
    void enqueue(id, async (item) => {
      const command = prior?.retry ?? { revision: item.revision, brief, key: crypto.randomUUID() };
      try {
        await jobsClient.saveBrief(id, command.revision, command.brief, command.key);
        replace({ ...item, brief: command.brief });
        setBriefSaves(({ [id]: _saved, ...rest }) => rest);
      } catch (error) {
        const rejected = error instanceof JobsApiError && error.status < 500;
        setBriefSaves((all) => ({ ...all, [id]: rejected
          ? { pending: false, error: error.message }
          : { pending: false, error: "Save could not be confirmed. Retry the same save.", retry: command } }));
      }
    });
  };
  const openPanel = (next: Panel) => {
    setPanel((p) => (p === next ? undefined : next));
    if (next === "revise") setTimeout(() => reviseRef.current?.focus(), 0);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target instanceof HTMLElement ? e.target : null;
      const typing = Boolean(target?.closest("input, select, textarea, [contenteditable=true]"));
      if (e.key === "Escape") {
        if (previewing) return; // the lightbox closes itself
        if (typing) target?.blur(); else if (panel) setPanel(undefined); else exit();
        return;
      }
      if (typing || previewing) return;
      const k = e.key.toLowerCase();
      if (k === "z") return undo();
      if (finished || !current) return;
      if (k === "j" || e.key === "ArrowDown") go(index + 1);
      else if (k === "k" || e.key === "ArrowUp") go(index - 1);
      else if (k === "f") setExpanded((v) => !v);
      else if (k === "p") setPreviewing(true);
      else if (k === "d") togglePosting();
      else if (decided || needsResume) return;
      else if (isDraftFailure(current)) { if (k === "2") decide({ action: "skip" }); else if (k === "1") decide({ action: "retry_draft" }); }
      else if (k === "1") decide({ action: "approve" });
      else if (k === "2") decide({ action: "skip" });
      else if (k === "h") decide({ action: "later" });
      else if (k === "r") { e.preventDefault(); openPanel("revise"); }
      else if (k === "x") openPanel("reject");
    };
    // Capture phase: the editor handles Escape itself, but here Escape must leave the editor first.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  return { items, index, current, decisions, decided, done, finished, panel, openPanel, hasPosting, showPosting, togglePosting,
    expanded, setExpanded, previewing, setPreviewing, instructions, setInstructions, reasons, setReasons, reviseRef, go, decide, undo, exit, save,
    needsResume, reopening, resumeReview, briefSaves, saveBrief, editedRevision: (a: ApplicationDetail) => a.revision !== loaded.current.get(a.id) };
}

function ReviewSession({ initial }: { initial: ApplicationDetail[] }) {
  const s = useReviewSession(initial);
  if (s.finished) return <Flex position="fixed" inset="0" zIndex="overlay" bg="bg"><SessionSummary s={s} /></Flex>;
  if (!s.current) return null;
  const app = s.current;
  return (
    <Flex position="fixed" inset="0" zIndex="overlay" bg="bg" direction="column" role="dialog" aria-label="Review session">
      <Box borderBottomWidth="1px" flexShrink={0}>
        <HStack h="12" px="3" gap="3">
          <Button size="xs" variant="ghost" onClick={s.exit}><XIcon />Exit<Shortcut>Esc</Shortcut></Button>
          <Pager s={s} />
          <Box ms="auto"><Actions s={s} app={app} /></Box>
        </HStack>
        <Progress.Root size="xs" value={(s.done / s.items.length) * 100}>
          <Progress.Track rounded="none" bg="transparent" h="2px"><Progress.Range /></Progress.Track>
        </Progress.Root>
        {s.panel && <Box px="4" py="2.5" borderTopWidth="1px" bg="bg.subtle"><DecisionPanel s={s} /></Box>}
      </Box>
      <Grid flex="1" minH="0" templateColumns={{ base: "1fr", lg: "minmax(0, 1fr) minmax(0, 1fr)" }} overflowY={{ base: "auto", lg: "hidden" }}>
        <Box overflowY={{ lg: "auto" }} borderRightWidth={{ lg: "1px" }}>
          <Stack gap="8" px={{ base: "6", md: "12" }} py="12" maxW="xl" mx="auto">
            <Stack gap="1">
              <Heading size="2xl" fontWeight="semibold" letterSpacing="tight">{app.role}</Heading>
              <Text textStyle="md" color="fg.muted">{app.company}</Text>
              <Box mt="2">
                <Button size="xs" variant="outline" asChild>
                  <a href={app.sourceUrl} target="_blank" rel="noreferrer">View job listing<ArrowUpRightIcon /></a>
                </Button>
              </Box>
            </Stack>
            <BriefPanel s={s} app={app} />
          </Stack>
        </Box>
        <ResumePane key={app.id} s={s} app={app} />
      </Grid>
    </Flex>
  );
}

// ---------- Left: the brief ----------

const remoteMeta: Record<Brief["remote"], { label: string; confirmed: boolean }> = {
  confirmed: { label: "Remote confirmed", confirmed: true }, hybrid: { label: "Hybrid", confirmed: false },
  onsite: { label: "On site", confirmed: false }, not_stated: { label: "Remote not stated", confirmed: false },
};
const tone = (score: number) => (score >= 70 ? "green" : score >= 40 ? "orange" : "red");

function BriefPanel({ s, app }: { s: Session; app: ApplicationDetail }) {
  const brief = app.brief;
  const posting = s.hasPosting && (
    <Box>
      <Button size="xs" variant="ghost" ms="-2" colorPalette="gray" color="fg.muted" onClick={s.togglePosting} aria-expanded={s.showPosting}>
        {s.showPosting ? "Hide posting details" : "Posting details"}<Shortcut>D</Shortcut>
      </Button>
      {s.showPosting && <Text mt="3" textStyle="sm" color="fg.muted" whiteSpace="pre-wrap" lineHeight="tall">{app.postingText}</Text>}
    </Box>
  );
  if (!brief) {
    return (
      <Stack gap="8">
        {isDraftFailure(app) && <Text textStyle="lg" color="fg.error">The draft failed. Retrying is safe: drafting sends nothing to the employer.</Text>}
        {posting}
        {app.status === "review" && !s.decided && <MissingBriefForm key={app.id}
          save={s.briefSaves[app.id]} onSubmit={(value) => s.saveBrief(app.id, value)} />}
      </Stack>
    );
  }
  // Every bar reads "fuller is better for running this job alongside others" (Oura readiness contributors).
  const contributors = [
    { label: "Automatable", value: { high: "High", medium: "Medium", low: "Low" }[brief.automatable], score: { high: 92, medium: 55, low: 15 }[brief.automatable] },
    { label: "Human contact", value: brief.humanContact.note, score: { low: 85, medium: 55, high: 20 }[brief.humanContact.level] },
    { label: "Meetings", value: brief.meetings.note, score: { rare: 95, weekly: 75, daily: 15 }[brief.meetings.level] },
  ];
  const ease = Math.round(contributors.reduce((sum, c) => sum + c.score, 0) / contributors.length);
  const touch = ease >= 70 ? { label: "Low touch", note: "Can run alongside other jobs" }
    : ease >= 40 ? { label: "Medium touch", note: "Needs regular attention" }
    : { label: "High touch", note: "Needs your full attention" };
  const remote = remoteMeta[brief.remote];
  const pay = payLabel(brief.pay);
  return (
    <Stack gap="8">
      <Stack gap="3">
        <Stack gap="0.5">
          <Text textStyle="3xl" fontWeight="semibold" letterSpacing="tight" fontVariantNumeric="tabular-nums" color={pay ? "fg" : "fg.muted"}>
            {pay ? <>{pay}<Text as="span" textStyle="md" fontWeight="normal" color="fg.muted"> CAD</Text></> : "Pay not stated"}
          </Text>
          {brief.pay.converted && brief.pay.original && <Text textStyle="xs" color="fg.muted">Converted from {brief.pay.original}</Text>}
        </Stack>
        <HStack gap="2" wrap="wrap">
          <Badge size="lg" rounded="full" variant="subtle" colorPalette={remote.confirmed ? "green" : "orange"} css={{ "& svg": { boxSize: "3.5" } }}>
            {remote.confirmed ? <HouseIcon /> : <CircleHelpIcon />}{remote.label}
          </Badge>
          <Badge size="lg" rounded="full" variant="subtle" colorPalette="gray" css={{ "& svg": { boxSize: "3.5" } }}><UsersIcon />{brief.companySize.label}</Badge>
        </HStack>
      </Stack>
      {brief.doing && <Text textStyle="lg" lineHeight="1.65">{brief.doing}</Text>}
      <Box borderWidth="1px" rounded="2xl" p="6" shadow="xs">
        <HStack gap="4" mb="6">
          <ProgressCircle.Root value={ease} size="lg" colorPalette={tone(ease)}>
            <ProgressCircle.Circle css={{ "--thickness": "5px" }}>
              <ProgressCircle.Track />
              <ProgressCircle.Range strokeLinecap="round" />
            </ProgressCircle.Circle>
            <AbsoluteCenter><Text textStyle="sm" fontWeight="semibold" fontVariantNumeric="tabular-nums">{ease}</Text></AbsoluteCenter>
          </ProgressCircle.Root>
          <Stack gap="0">
            <Text textStyle="xl" fontWeight="semibold">{touch.label}</Text>
            <Text textStyle="sm" color="fg.muted">{touch.note}</Text>
          </Stack>
        </HStack>
        <Stack gap="5">
          {contributors.map((c) => (
            <Stack key={c.label} gap="2">
              <HStack justify="space-between" gap="4" textStyle="sm">
                <Text color="fg.muted">{c.label}</Text>
                <Text fontWeight="medium" textAlign="right">{c.value}</Text>
              </HStack>
              <Progress.Root value={c.score} size="xs" colorPalette={tone(c.score)} aria-label={`${c.label}: ${c.value}`}>
                <Progress.Track rounded="full"><Progress.Range rounded="full" /></Progress.Track>
              </Progress.Root>
            </Stack>
          ))}
        </Stack>
      </Box>
      {posting}
    </Stack>
  );
}

// ---------- Right: Summary or Full résumé ----------

type Pillar = "Time saved" | "Money saved" | "Money made";
const pillarIcons: Record<Pillar, React.ReactNode> = { "Time saved": <ClockIcon />, "Money saved": <PiggyBankIcon />, "Money made": <TrendingUpIcon /> };
/** Which outcome a summary bullet sells (keyword heuristic; the summary should sell outcomes, not processes). */
export function outcomePillar(bullet: string): Pillar | null {
  if (/\b(cost|costs|saving|savings|cheaper|budget)\b/i.test(bullet)) return "Money saved";
  if (/\b(revenue|sales|users|customers|clients|conversion|signups?|launched)\b/i.test(bullet)) return "Money made";
  if (/\b(hours?|days?|minutes?|weeks?|faster|automat\w*|replac\w*|cut)\b/i.test(bullet)) return "Time saved";
  return null;
}
const resumeCss = {
  "& [role=textbox]": { maxHeight: "none", overflow: "visible", fontSize: "16px", lineHeight: "1.65", color: "fg" },
  "& [role=textbox] ul": { paddingLeft: "22px", marginBlock: 0 },
  "& [role=textbox] li + li": { marginTop: "10px" },
};
const resumeEditorExtensions = [ResumeMarkdownShortcuts];
const scopes = [{ value: "summary", label: "Summary" }, { value: "full", label: "Whole résumé" }];

function ResumePane({ s, app }: { s: Session; app: ApplicationDetail }) {
  const full = s.expanded;
  const covered = new Set(app.summaryMarkdown.split("\n").filter((l) => /^\s*[-*]\s+/.test(l)).map(outcomePillar));
  const edited = s.editedRevision(app);
  const staleApproval = app.approvedRevision !== null && app.approvedRevision !== app.revision;
  const field = full ? "resumeMarkdown" : "summaryMarkdown";
  // Same container, same editor, same typography in both scopes: only the Markdown swaps, so nothing shifts.
  return (
    <Flex direction="column" minH="0" overflowY={{ lg: "auto" }}>
      <HStack position="sticky" top="0" zIndex="1" h="12" px="6" gap="3" justify="space-between" bg="bg" borderBottomWidth="1px" flexShrink={0}>
        <SegmentGroup.Root size="sm" value={full ? "full" : "summary"} onValueChange={(e) => e.value && s.setExpanded(e.value === "full")}>
          <SegmentGroup.Indicator />
          <SegmentGroup.Items items={scopes} />
        </SegmentGroup.Root>
        <HStack gap="2">
          {edited ? <Badge size="sm" variant="subtle" colorPalette="blue">Your edits, v{app.revision}</Badge>
            : staleApproval ? <Badge size="sm" variant="subtle" colorPalette="orange">v{app.revision}, edited since approved v{app.approvedRevision}</Badge>
            : <Badge size="sm" variant="outline" colorPalette="gray">v{app.revision}</Badge>}
          <Button size="xs" variant="outline" onClick={() => s.setPreviewing(true)}><FileTextIcon />Preview PDF<Shortcut>P</Shortcut></Button>
        </HStack>
      </HStack>
      <Stack gap="6" px={{ base: "6", md: "12" }} py="10" maxW="2xl" w="full" mx="auto">
        <HStack gap="2" wrap="wrap">
          {(Object.keys(pillarIcons) as Pillar[]).map((p) => (
            <Badge key={p} size="md" variant={covered.has(p) ? "subtle" : "outline"} colorPalette={covered.has(p) ? "green" : "gray"}
              opacity={covered.has(p) ? 1 : 0.6} css={{ "& svg": { boxSize: "3" } }}>{pillarIcons[p]}{p}</Badge>
          ))}
        </HStack>
        <Box css={resumeCss}>
          <TodoNotesEditor key={`${field}-${app.id}`} label={`${app.company} ${full ? "full résumé" : "résumé summary"}`} placeholder={full ? "Write the résumé" : "Write the summary"}
            readOnly={Boolean(s.decided) || s.needsResume} extensions={resumeEditorExtensions} markdownEditing value={app[field]}
            onCommit={(_before, after) => s.save(app.id, { [field]: after })} />
        </Box>
      </Stack>
      <ResumePreviewDialog open={s.previewing} onClose={() => s.setPreviewing(false)} company={app.company} markdown={app.resumeMarkdown} pdfUrl={app.pdfUrl} />
    </Flex>
  );
}

// ---------- Bar pieces ----------

function Pager({ s }: { s: Session }) {
  return (
    <HStack gap="0.5" flexShrink={0}>
      <IconButton size="xs" variant="ghost" aria-label="Previous" disabled={s.index === 0} onClick={() => s.go(s.index - 1)}><ChevronLeftIcon /></IconButton>
      <Text textStyle="xs" color="fg.muted" fontVariantNumeric="tabular-nums" minW="14" textAlign="center">{s.index + 1} of {s.items.length}</Text>
      <IconButton size="xs" variant="ghost" aria-label="Next" disabled={s.index === s.items.length - 1} onClick={() => s.go(s.index + 1)}><ChevronRightIcon /></IconButton>
    </HStack>
  );
}

function Actions({ s, app }: { s: Session; app: ApplicationDetail }) {
  if (s.decided) return <Text textStyle="sm" color="fg.muted">{decisionLabels[s.decided]}. Undo<Shortcut>Z</Shortcut></Text>;
  if (s.needsResume) return (
    <HStack gap="2">
      <Text textStyle="sm" color="fg.muted">Saved for later</Text>
      <Button size="xs" loading={s.reopening[app.id]} onClick={() => s.resumeReview(app.id)}>Resume review</Button>
    </HStack>
  );
  if (isDraftFailure(app)) {
    return (
      <HStack gap="1.5">
        <Button size="xs" variant="ghost" onClick={() => s.decide({ action: "skip" })}>Skip<Shortcut>2</Shortcut></Button>
        <Button size="xs" onClick={() => s.decide({ action: "retry_draft" })}>Retry draft<Shortcut>1</Shortcut></Button>
      </HStack>
    );
  }
  return (
    <HStack gap="0.5">
      <Button size="xs" variant="ghost" onClick={() => s.decide({ action: "later" })}>Later<Shortcut>H</Shortcut></Button>
      <Button size="xs" variant="ghost" onClick={() => s.openPanel("reject")} aria-expanded={s.panel === "reject"}>Reject<Shortcut>X</Shortcut></Button>
      <Button size="xs" variant="ghost" onClick={() => s.decide({ action: "skip" })}>Skip<Shortcut>2</Shortcut></Button>
      <Button size="xs" variant="ghost" onClick={() => s.openPanel("revise")} aria-expanded={s.panel === "revise"}>Revise with AI<Shortcut>R</Shortcut></Button>
      <Button size="xs" ms="1.5" onClick={() => s.decide({ action: "approve" })}><CheckIcon />Approve v{app.revision}<Shortcut>1</Shortcut></Button>
    </HStack>
  );
}

function DecisionPanel({ s }: { s: Session }) {
  if (s.panel === "revise") {
    return (
      <Textarea ref={s.reviseRef} size="sm" rows={2} value={s.instructions} onChange={(e) => s.setInstructions(e.target.value)}
        placeholder="Instructions for the agent's summary, then Enter" bg="bg"
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && s.instructions.trim()) { e.preventDefault(); s.decide({ action: "revise", instructions: s.instructions.trim() }); }
        }} />
    );
  }
  return (
    <HStack gap="1.5" wrap="wrap">
      {rejectReasons.map((r) => {
        const on = s.reasons.includes(r);
        return <Button key={r} size="2xs" rounded="full" variant={on ? "subtle" : "outline"} colorPalette="gray" bg={on ? undefined : "bg"}
          onClick={() => s.setReasons(on ? s.reasons.filter((x) => x !== r) : [...s.reasons, r])}>{r}</Button>;
      })}
      <Button size="2xs" colorPalette="red" ms="auto" disabled={!s.reasons.length} onClick={() => s.decide({ action: "reject", reasons: s.reasons })}>Reject</Button>
    </HStack>
  );
}

function SessionSummary({ s }: { s: Session }) {
  const counts = Object.values(s.decisions).reduce<Record<string, number>>((acc, d) => ({ ...acc, [decisionLabels[d]]: (acc[decisionLabels[d]] ?? 0) + 1 }), {});
  return (
    <Stack flex="1" align="center" justify="center" gap="5" px="6">
      <CheckIcon size={24} />
      <Heading size="lg" fontWeight="semibold">Session complete</Heading>
      <DataList.Root orientation="horizontal" size="sm" gap="2" minW="56">
        {Object.entries(counts).map(([label, n]) => (
          <DataList.Item key={label}><DataList.ItemLabel minW="44">{label}</DataList.ItemLabel><DataList.ItemValue fontVariantNumeric="tabular-nums">{n}</DataList.ItemValue></DataList.Item>
        ))}
      </DataList.Root>
      <Text textStyle="xs" color="fg.muted">{s.items.length} applications reviewed. Approved ones are queued for the runner.</Text>
      <Button size="sm" onClick={s.exit}>Back to Applications</Button>
    </Stack>
  );
}
