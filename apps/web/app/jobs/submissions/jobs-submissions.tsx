"use client";

// Jobs Submissions, after Buildkite / Vercel run ledgers and Trigger.dev's run timeline. Runner state and the
// "waiting on runner" vs "waiting on you" split live in the header; pause is a persistent mode. Each issue has its own
// primary action, and an uncertain submission is never retried in one click: the Owner checks the portal first.
// F jumps to the next issue.
import { useEffect, useRef, useState } from "react";
import { Alert, Badge, Box, Button, CloseButton, Dialog, Flex, Grid, HStack, Heading, Portal, Spinner, Stack, Text, Textarea } from "@chakra-ui/react";
import { CircleCheckIcon, CircleDashedIcon, CircleXIcon, ExternalLinkIcon, PauseIcon, PlayIcon, ReceiptTextIcon } from "lucide-react";
import { toaster } from "@/components/chakra/toaster";
import { JobsPrivateDetails } from "../private/jobs-private-details";
import { JobsApiError, jobsClient, type Resolution, type Runner, type Submission, type Submissions } from "../jobs-client";
import { JobsFrame, LoadState, Shortcut, ago, issueLabels, useJobsData } from "../jobs-frame";

const order: Partial<Record<Submission["status"], number>> = { needs_attention: 0, submitting: 1, queued: 2, approved: 3, applied: 4, skipped: 5 };
const runnerDot: Record<Runner["state"], string> = { idle: "green.500", submitting: "orange.400", paused: "gray.400", offline: "red.500" };
const runnerLabel: Record<Runner["state"], string> = { idle: "Idle", submitting: "Submitting", paused: "Paused", offline: "Offline" };
const receiptLabel = (s: Submission) => s.receipt === "confirmation_page" ? "Confirmation page" : s.receipt === "confirmation_message" ? "Confirmation email" : "No receipt";
const duration = (ms: number | null) => ms === null ? "—" : `${Math.floor(ms / 60_000)}m ${String(Math.round((ms % 60_000) / 1000)).padStart(2, "0")}s`;
type DialogKind = "not_sent" | "manual" | "mark_applied";

export function JobsSubmissions() {
  const { data, setData, error, reload } = useJobsData((signal) => jobsClient.submissions(signal), "submissions");
  const [selectedId, setSelectedId] = useState<string>();
  const [notes, setNotes] = useState<Record<string, string>>({});
  const failure = (title: string, err: unknown) => toaster.create({ type: "error", title, description: err instanceof JobsApiError ? err.message : undefined, duration: 8000 });

  const items = [...(data?.items ?? [])].sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9));
  const attention = items.filter((i) => i.status === "needs_attention");
  const rest = items.filter((i) => i.status !== "needs_attention");
  const selected = items.find((i) => i.id === selectedId) ?? attention[0] ?? items[0];
  const paused = data?.runner.state === "paused";

  const setPaused = async (value: boolean) => {
    if (!data) return;
    const before = data.runner;
    setData({ ...data, runner: { ...before, state: value ? "paused" : "idle" } });
    try {
      const { runner } = await jobsClient.setRunnerPaused(value);
      setData((d) => (d ? { ...d, runner } : d));
    } catch (err) {
      setData((d) => (d ? { ...d, runner: before } : d));
      failure(value ? "The runner was not paused" : "The runner was not resumed", err);
    }
  };
  const resolve = async (item: Submission, resolution: Resolution, note: string) => {
    const status = resolution.action === "mark_applied" ? "applied" : resolution.action === "skip" ? "skipped" : "queued";
    const patch = (d: Submissions | undefined, next: Submission) => (d ? { ...d, items: d.items.map((i) => (i.id === next.id ? next : i)) } : d);
    setData((d) => patch(d, { ...item, status, issue: null }));
    setNotes((n) => ({ ...n, [item.id]: note }));
    try {
      const { submission } = await jobsClient.resolve(item.id, resolution);
      if (submission) setData((d) => patch(d, submission));
    } catch (err) {
      setData((d) => patch(d, item));
      setNotes((n) => { const next = { ...n }; delete next[item.id]; return next; });
      failure(`${item.company} was not updated`, err);
    }
  };

  // Saving the answers the runner asked for resumes the application on the server.
  const resumed = (item: Submission) => {
    setData((d) => (d ? { ...d, items: d.items.map((i) => (i.id === item.id ? { ...i, status: "queued", issue: null } : i)) } : d));
    setNotes((n) => ({ ...n, [item.id]: `Answers saved, back in queue with approved v${item.approvedRevision}` }));
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || (e.target instanceof Element && e.target.closest("input, textarea, [contenteditable], [role=dialog], form"))) return;
      if (e.key.toLowerCase() !== "f" || !attention.length) return;
      const at = attention.findIndex((a) => a.id === selected?.id);
      setSelectedId(attention[(at + 1) % attention.length].id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!data) return <JobsFrame><LoadState error={error} onRetry={reload} label="Loading submissions…" /></JobsFrame>;
  const waitingOnRunner = items.filter((i) => ["approved", "queued", "submitting"].includes(i.status)).length;
  return (
    <JobsFrame
      actions={<>
        <RunnerPairing />
        {paused
          ? <Button size="sm" onClick={() => void setPaused(false)}><PlayIcon />Resume runner</Button>
          : <Button size="sm" variant="outline" onClick={() => void setPaused(true)}><PauseIcon />Pause runner</Button>}
      </>}
      facts={[
        { label: "Runner", value: <HStack gap="2"><Box boxSize="2" rounded="full" bg={runnerDot[data.runner.state]} />{runnerLabel[data.runner.state]}{data.runner.host ? ` on ${data.runner.host}` : ""}</HStack> },
        { label: "Last heartbeat", value: ago(data.runner.lastHeartbeatAt) },
        { label: "Waiting on runner", value: waitingOnRunner },
        { label: "Waiting on you", value: <Text as="span" color={attention.length ? "fg.error" : undefined}>{attention.length}</Text> },
      ]}>
      <Grid templateColumns={{ base: "1fr", xl: "minmax(0, 1fr) 420px" }} maxW="7xl" mx="auto" px={{ base: "4", md: "6" }} py="6" gap="6" alignItems="start">
        <Stack gap="6" minW="0">
          {paused && (
            <Alert.Root status="neutral" variant="subtle">
              <Alert.Indicator><PauseIcon /></Alert.Indicator>
              <Alert.Content>
                <Alert.Title>Runner paused</Alert.Title>
                <Alert.Description>Queued applications stay queued until you resume. Approvals still save.</Alert.Description>
              </Alert.Content>
              <Button size="xs" variant="outline" alignSelf="center" onClick={() => void setPaused(false)}>Resume</Button>
            </Alert.Root>
          )}
          <RunGroup title="Needs you" hint={attention.length > 1 ? <>Next issue<Shortcut>F</Shortcut></> : undefined}
            items={attention} selectedId={selected?.id} onSelect={setSelectedId} paused={paused} notes={notes} />
          <RunGroup title="Recent" items={rest} selectedId={selected?.id} onSelect={setSelectedId} paused={paused} notes={notes} />
          {!items.length && <Text textStyle="sm" color="fg.muted" py="10" textAlign="center">Nothing has been approved for submission yet.</Text>}
        </Stack>
        {selected && <RunDetail key={selected.id} item={selected} note={notes[selected.id]} onResolve={resolve} onResumed={resumed} />}
      </Grid>
    </JobsFrame>
  );
}

function RunnerPairing() {
  const [key, setKey] = useState<string>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const reveal = useRef(false);

  const issueKey = async () => {
    if (pending) return;
    reveal.current = true;
    setPending(true);
    setError(undefined);
    try {
      const result = await jobsClient.pairRunner();
      if (reveal.current) setKey(result.key);
    } catch (cause) {
      if (reveal.current) setError(cause instanceof JobsApiError ? cause.message : "Could not receive the key. Generate a replacement to try again.");
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog.Root onOpenChange={({ open }) => {
      if (open) return;
      reveal.current = false;
      setKey(undefined);
      setError(undefined);
    }}>
      <Dialog.Trigger asChild><Button size="sm" variant="outline">Pair Mac runner</Button></Dialog.Trigger>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header><Dialog.Title>Pair Mac runner</Dialog.Title></Dialog.Header>
            <Dialog.Body>
              {key
                ? <Stack gap="3">
                    <Text>Copy this key now. Set it as <code>JOBS_RUNNER_SECRET</code> on the Mac and connect to the private Jobs API origin.</Text>
                    <Box as="code" display="block" fontFamily="mono" bg="bg.subtle" p="3" overflowWrap="anywhere" userSelect="all">{key}</Box>
                  </Stack>
                : <Text>Generate a key for the Mac runner. This replaces any previous key issued here.</Text>}
              {error && <Text role="alert" color="fg.error" mt="3">{error}</Text>}
            </Dialog.Body>
            <Dialog.Footer>
              <Dialog.CloseTrigger asChild><Button variant="outline">Close</Button></Dialog.CloseTrigger>
              {!key && <Button loading={pending} loadingText="Generating key" onClick={() => void issueKey()}>Generate key</Button>}
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

function RunIcon({ item }: { item: Submission }) {
  if (item.status === "needs_attention") return <Box color="fg.error"><CircleXIcon size={16} /></Box>;
  if (item.status === "submitting") return <Spinner size="xs" color="orange.500" />;
  if (item.status === "applied") return <Box color="green.600"><CircleCheckIcon size={16} /></Box>;
  if (item.status === "skipped") return <Box color="fg.subtle"><CircleXIcon size={16} /></Box>;
  return <Box color="fg.subtle"><CircleDashedIcon size={16} /></Box>;
}

function RunGroup({ title, hint, items, selectedId, onSelect, paused, notes }: {
  title: string; hint?: React.ReactNode; items: Submission[]; selectedId?: string; onSelect: (id: string) => void; paused: boolean; notes: Record<string, string>;
}) {
  if (!items.length) return null;
  const reason = (i: Submission) => {
    if (notes[i.id]) return notes[i.id];
    if (i.status === "needs_attention" && i.issue) return issueLabels[i.issue];
    if (i.status === "applied") return receiptLabel(i);
    if (i.status === "submitting") return i.phase ?? "Submitting";
    return paused ? "Paused, not moving" : "Waiting for runner";
  };
  return (
    <Box>
      <HStack mb="2" textStyle="sm" gap="2" justify="space-between">
        <HStack gap="2"><Text fontWeight="semibold">{title}</Text><Text color="fg.muted">{items.length}</Text></HStack>
        {hint && <Text textStyle="xs" color="fg.muted">{hint}</Text>}
      </HStack>
      <Box borderWidth="1px" rounded="l2" overflow="hidden">
        {items.map((i) => (
          <Grid key={i.id} as="button" w="full" textAlign="left" onClick={() => onSelect(i.id)} templateColumns="20px minmax(0, 2fr) minmax(0, 1.2fr) 80px 64px" gap="4"
            alignItems="center" px="4" h="11" textStyle="sm" borderBottomWidth="1px" borderColor="border.muted" _last={{ borderBottomWidth: 0 }}
            bg={i.id === selectedId ? "bg.muted" : undefined} _hover={{ bg: i.id === selectedId ? "bg.muted" : "bg.subtle" }} aria-current={i.id === selectedId || undefined}>
            <RunIcon item={i} />
            <HStack gap="2" minW="0"><Text fontWeight="medium" flexShrink={0}>{i.company}</Text><Text color="fg.muted" truncate>{i.role}</Text></HStack>
            <Text color={i.status === "needs_attention" ? "fg.error" : "fg.muted"} truncate>{reason(i)}</Text>
            <Text color="fg.muted" fontVariantNumeric="tabular-nums" textAlign="right">{duration(i.durationMs)}</Text>
            <Text color="fg.subtle" textStyle="xs" textAlign="right">{ago(i.updatedAt)}</Text>
          </Grid>
        ))}
      </Box>
    </Box>
  );
}

function RunDetail({ item, note, onResolve, onResumed }: {
  item: Submission; note?: string; onResolve: (item: Submission, resolution: Resolution, note: string) => Promise<void>; onResumed: (item: Submission) => void;
}) {
  const [dialog, setDialog] = useState<DialogKind>();
  const [confirmation, setConfirmation] = useState("");
  const [reviewed, setReviewed] = useState<Pick<Submission, "updatedAt" | "approvedRevision">>();
  const revision = item.approvedRevision;
  const close = () => { setDialog(undefined); setConfirmation(""); setReviewed(undefined); };
  const openDialog = (kind: DialogKind) => {
    setReviewed({ updatedAt: item.updatedAt, approvedRevision: revision });
    setDialog(kind);
  };
  const posting = (
    <Button size="xs" variant="outline" asChild>
      <a href={item.sourceUrl} target="_blank" rel="noreferrer"><ExternalLinkIcon />{item.issue === "submission_uncertain" ? "Check portal" : "Open posting"}</a>
    </Button>
  );
  const resolve = (resolution: Resolution, label: string) => { close(); void onResolve(item, resolution, label); };

  return (
    <Box borderWidth="1px" rounded="l2" position={{ xl: "sticky" }} top="4">
      <Stack gap="1" p="4" borderBottomWidth="1px">
        <Text textStyle="xs" color="fg.muted">{item.company}</Text>
        <Heading size="md" fontWeight="semibold">{item.role}</Heading>
        <HStack gap="2" mt="2" textStyle="xs" color="fg.muted" wrap="wrap">
          {revision !== null && <Badge size="sm" variant="outline" colorPalette="gray">Approved v{revision}</Badge>}
          {item.source && <Text>{item.source}</Text>}
        </HStack>
      </Stack>
      {note ? (
        <Box p="4"><Alert.Root status="success" variant="subtle" size="sm"><Alert.Indicator /><Alert.Title>{note}</Alert.Title></Alert.Root></Box>
      ) : (
        <Stack gap="0" p="4">
          {item.steps.map((step, i) => (
            <Flex key={step.label} gap="3">
              <Flex direction="column" align="center">
                <Box mt="0.5" color={step.state === "done" ? "green.600" : step.state === "failed" ? "fg.error" : step.state === "running" ? "orange.500" : "fg.subtle"}>
                  {step.state === "done" ? <CircleCheckIcon size={16} /> : step.state === "failed" ? <CircleXIcon size={16} /> : step.state === "running" ? <Spinner size="xs" /> : <CircleDashedIcon size={16} />}
                </Box>
                {i < item.steps.length - 1 && <Box w="1px" flex="1" minH="4" bg="border" my="1" />}
              </Flex>
              <Stack gap="1.5" pb="3" flex="1" minW="0">
                <HStack justify="space-between" textStyle="sm">
                  <Text fontWeight={step.state === "failed" ? "medium" : undefined} color={step.state === "pending" ? "fg.subtle" : "fg"}>{step.label}</Text>
                  <Text textStyle="xs" color="fg.subtle" fontVariantNumeric="tabular-nums">{step.durationMs === null ? "" : `${Math.round(step.durationMs / 1000)}s`}</Text>
                </HStack>
                {step.attempts.map((attempt, n) => (
                  <Grid key={n} templateColumns="64px 40px minmax(0, 1fr)" gap="2" textStyle="xs" bg="bg.error" color="fg.error" rounded="sm" px="2.5" py="1.5">
                    <Text fontWeight="medium">Attempt {n + 1}</Text>
                    <Text>{new Date(attempt.at).toLocaleTimeString("en-CA", { hour: "2-digit", minute: "2-digit", hour12: false })}</Text>
                    <Text>{attempt.error}</Text>
                  </Grid>
                ))}
              </Stack>
            </Flex>
          ))}
          {item.status === "applied" && item.receipt && (
            <HStack gap="2" mt="1" textStyle="sm" borderWidth="1px" rounded="md" px="3" py="2">
              <ReceiptTextIcon size={14} /><Text flex="1">{receiptLabel(item)} captured</Text>
            </HStack>
          )}
        </Stack>
      )}

      {!note && item.status === "needs_attention" && item.issue === "manual_required" && item.privatePauseFieldKeys?.length ? (
        <Stack p="4" borderTopWidth="1px" gap="3">
          <Text textStyle="sm" fontWeight="semibold">The runner needs these answers</Text>
          <JobsPrivateDetails applicationId={item.id} onResumed={(ids) => { if (ids.includes(item.id)) onResumed(item); }} />
        </Stack>
      ) : !note && item.status === "needs_attention" && (
        <Stack p="4" borderTopWidth="1px" gap="3">
          {item.issue === "submission_uncertain" && (
            <Text textStyle="xs" color="fg.muted">The employer may already have this application. Check the portal or email delivery records, then record what you find.</Text>
          )}
          <HStack gap="2" justify="end" wrap="wrap">
            {item.issue === "submission_uncertain" && <>
              <Button size="xs" variant="ghost" onClick={() => openDialog("not_sent")}>Mark not sent</Button>
              <Button size="xs" variant="outline" onClick={() => openDialog("mark_applied")}>Mark applied</Button>
              {posting}
            </>}
            {item.issue === "unsupported_portal" && <>
              <Button size="xs" variant="ghost" onClick={() => resolve({ action: "skip" }, "Skipped")}>Skip</Button>
              <Button size="xs" variant="outline" onClick={() => openDialog("mark_applied")}>Mark applied</Button>
              {posting}
            </>}
            {item.issue === "manual_required" && <>
              <Button size="xs" variant="ghost" onClick={() => resolve({ action: "requeue" }, `Back in queue with approved v${revision}`)}>Return to queue</Button>
              <Button size="xs" onClick={() => openDialog("manual")}>Complete manually</Button>
            </>}
            {item.issue === "runner_unavailable" && <>
              <Text textStyle="xs" color="fg.muted" me="auto">Requeue when the runner is ready.</Text>
              <Button size="xs" variant="outline" onClick={() => resolve({ action: "requeue" }, `Requeued approved v${revision}`)}>Requeue now</Button>
            </>}
          </HStack>
        </Stack>
      )}

      <Dialog.Root open={Boolean(dialog)} onOpenChange={(e) => !e.open && close()} size="sm" role={dialog === "not_sent" ? "alertdialog" : "dialog"}>
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content>
              <Dialog.Header>
                <Dialog.Title>{dialog === "not_sent" ? `Resubmit approved v${reviewed?.approvedRevision}?` : dialog === "manual" ? "Complete manually" : `Mark ${item.company} as applied`}</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                {dialog === "not_sent" && (
                  <Stack gap="2" textStyle="sm">
                    <Text>Confirm the previous submission was not sent. The runner will retry the same approved PDF.</Text>
                    <Text color="fg.muted">If delivery is still uncertain, keep the submission on hold.</Text>
                  </Stack>
                )}
                {dialog === "manual" && (
                  <Stack gap="3" textStyle="sm">
                    {item.steps.find((s) => s.state === "failed")?.attempts.at(-1) && (
                      <Box bg="bg.muted" rounded="md" px="3" py="2">
                        <Text color="fg.muted" textStyle="xs">The runner stopped at</Text>
                        <Text>{item.steps.find((s) => s.state === "failed")?.attempts.at(-1)?.error}</Text>
                      </Box>
                    )}
                    <Text>Finish the application in the portal, then paste the confirmation number or message.</Text>
                    <Textarea size="sm" rows={3} value={confirmation} onChange={(e) => setConfirmation(e.target.value)} placeholder="Confirmation number or message" />
                  </Stack>
                )}
                {dialog === "mark_applied" && (
                  <Stack gap="3" textStyle="sm">
                    <Text>Records the application as sent. Paste any confirmation you found in the portal.</Text>
                    <Textarea size="sm" rows={3} value={confirmation} onChange={(e) => setConfirmation(e.target.value)} placeholder="Confirmation number or message (optional)" />
                  </Stack>
                )}
              </Dialog.Body>
              <Dialog.Footer>
                <Button size="sm" variant="outline" onClick={close}>Cancel</Button>
                {dialog === "not_sent" && reviewed && <Button size="sm" colorPalette="red" onClick={() => resolve({ action: "mark_not_sent", expectedUpdatedAt: reviewed.updatedAt }, `Requeued approved v${reviewed.approvedRevision}`)}>Resubmit v{reviewed.approvedRevision}</Button>}
                {dialog === "manual" && <Button size="sm" disabled={!confirmation.trim()} onClick={() => resolve({ action: "mark_applied", confirmation: confirmation.trim(), expectedUpdatedAt: reviewed?.updatedAt }, "Applied manually, receipt saved")}>Mark applied</Button>}
                {dialog === "mark_applied" && <Button size="sm" onClick={() => resolve({ action: "mark_applied", confirmation: confirmation.trim() || undefined, expectedUpdatedAt: reviewed?.updatedAt }, confirmation.trim() ? "Marked applied, receipt saved" : "Marked applied")}>Mark applied</Button>}
              </Dialog.Footer>
              <Dialog.CloseTrigger asChild><CloseButton size="sm" /></Dialog.CloseTrigger>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    </Box>
  );
}
