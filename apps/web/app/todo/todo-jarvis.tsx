"use client";
import {
  createContext,
  useContext,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type ReactNode,
} from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { BugIcon, CircleAlertIcon, MicIcon, PauseIcon, SquareIcon } from "lucide-react";
import { useStickToBottom } from "use-stick-to-bottom";
import { Box, Button, CloseButton, Dialog, Flex, HStack, Link as ChakraLink, Portal, Stack, Text, VisuallyHidden } from "@chakra-ui/react";
import { NavAction } from "@/components/shared/nav-action";
const Aura = dynamic(
  () =>
    import("../jarvis/audio-visualizer/agent-audio-visualizer-aura").then(
      (module) => module.AgentAudioVisualizerAura,
    ),
  { ssr: false },
);
type VoiceState =
  | "disconnected"
  | "connecting"
  | "listening"
  | "thinking"
  | "speaking"
  | "failed";
type DebugEvent = { id: number; time: string; type: string; detail: string };
type TranscriptLine = { id: string; role: "user" | "agent"; text: string };
type JarvisControl = {
  status: string;
  notice: string | null;
  volume: number;
  state: VoiceState;
  busy: boolean;
  connected: boolean;
  transcript: TranscriptLine[];
  begin(): Promise<void>;
  end(): Promise<void>;
  reconcile(): Promise<void>;
  openDebug(): void;
  pending: boolean;
};
const JarvisContext = createContext<JarvisControl | null>(null);
export const useJarvis = () => useContext(JarvisContext);
import { readTodoJson, useTodoStore } from "./todo-live";
import { createJarvisUiBridge, JarvisUi, jarvisContextMessage, type JarvisUiAction } from "./jarvis-ui";
import { TodoCaptureReview } from "./todo-capture-review";
import {
  connectJarvis,
  createPlaybackDrain,
  createJarvisSessionLifetime,
  type JarvisConnection,
} from "./jarvis-connection";
import type { components } from "@/lib/generated/quantself-api-schema";

type SavedSession = { captureId: string; conversationId: string };
const storageKey = "quantself-jarvis-pending";
async function post(id: string, operation: string, body = {}) {
  const response = await fetch(`/api/v1/todo-jarvis/${id}/${operation}`, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result)
    throw Error(
      result?.message || "Jarvis unavailable. Check permission and retry.",
    );
  return result as components["schemas"]["JarvisSession"];
}
export function TodoJarvis({
  children,
  showTask,
  start = connectJarvis,
  refreshTasks,
  onCreates,
}: {
  children?: ReactNode;
  showTask?(number: number): void;
  start?: typeof connectJarvis;
  refreshTasks?: () => Promise<void>;
  onCreates?: (
    commands: components["schemas"]["TodoJarvisOutcomes"]["commands"],
  ) => void;
} = {}) {
  const store = useTodoStore();
  const router = useRouter();
  const pathname = usePathname();
  const [ui] = useState(createJarvisUiBridge);
  const [state, setState] = useState<VoiceState>("disconnected");
  const [debugOpen, setDebugOpen] = useState(false);
  const [events, setEvents] = useState<DebugEvent[]>([]);
  const [transcript, setTranscript] = useState<TranscriptLine[]>([]);
  const transcriptId = useRef(0);
  const eventId = useRef(0);
  const speaking = useRef(false);
  const inFlightTools = useRef(0);
  const [volume, setVolume] = useState(0);
  const notifiedOutcomes = useRef(new Map<string, string>());
  const record = (type: string, detail = "") =>
    setEvents((previous) => [
      ...previous.slice(-199),
      {
        id: ++eventId.current,
        time: new Date().toLocaleTimeString(),
        type,
        detail,
      },
    ]);
  const [toolsPending, setToolsPending] = useState(0);
  const outcomesLoading = useRef<Promise<void> | null>(null);
  const [status, setStatus] = useState("Ready to talk.");
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(false);
  const [pending, setPending] = useState<SavedSession | null>(null);
  const [archived, setArchived] = useState("");
  const [outcomes, setOutcomes] = useState<
    components["schemas"]["TodoJarvisOutcomes"]["commands"]
  >([]);
  const connection = useRef<JarvisConnection | null>(null);
  const lastContext = useRef("");
  const sendUiContext = () => {
    const current = jarvisContextMessage(ui.context());
    if (connection.current?.sendContextualUpdate && current !== lastContext.current) {
      connection.current.sendContextualUpdate(current);
      lastContext.current = current;
    }
  };
  useEffect(() => { ui.setPage(pathname); }, [ui, pathname]);
  useEffect(() => ui.subscribe(sendUiContext), [ui]);
  const performUiAction = async (action: JarvisUiAction): Promise<string> => {
    record("navigation.request", action.type);
    if (action.type === "close" && debugOpen) {
      if (ui.hasDrafts()) return "Unsaved changes or a save in progress. Save or discard them manually first.";
      setDebugOpen(false);
      return "Closed Jarvis debug.";
    }
    return ui.run(action, async () => {
      const calendarAction = action.type === "view" || action.type === "date" || action.type === "task";
      const target = calendarAction
        ? action.type === "view" && action.view === "list" ? "/todo" : "/calendar"
        : null;
      if (ui.ready(target ?? undefined)) return;
      if (action.type === "close") return "No controllable panel is open on this page.";
      const destination = target ?? "/todo";
      const viewedDate = ui.context().date;
      router.push(viewedDate ? `${destination}?date=${viewedDate}` : destination);
      try { await ui.waitForWorkspace(destination); }
      catch { return "Task workspace unavailable. Try again."; }
    });
  };
  const openTask = async (number: number): Promise<string> => {
    if (showTask) { showTask(number); return `Opened task #${number}`; }
    return performUiAction({ type: "task", number });
  };
  const findTask = async (query: string): Promise<string> => {
    await store.refresh();
    const snapshot = store.getSnapshot();
    if (!["ready", "empty"].includes(snapshot.status)) return "Task lookup unavailable. Refresh tasks and try again.";
    const name = query.toLocaleLowerCase();
    const tasks = snapshot.todos.filter(todo => !todo.optimistic && todo.number > 0);
    const exact = tasks.filter(todo => todo.title.toLocaleLowerCase() === name);
    const matches = exact.length ? exact : tasks.filter(todo => todo.title.toLocaleLowerCase().includes(name));
    if (!matches.length) return "No task matches that name. Ask for another name or its number.";
    if (matches.length > 1) return `Multiple tasks match. Ask which one: ${matches.slice(0, 8).map(todo => `#${todo.number} ${todo.title}`).join("; ")}${matches.length > 8 ? "; more matches exist, narrow the name" : ""}`;
    return openTask(matches[0].number);
  };
  // SDK callbacks outlive the render that starts the conversation.
  const uiCallbacks = useRef({ showTask: openTask, findTask, ui: performUiAction });
  useEffect(() => {
    uiCallbacks.current = { showTask: openTask, findTask, ui: performUiAction };
  });
  const session = useRef<SavedSession | null>(null);
  const recordings = useRef<SavedSession[]>([]);
  const drain = useRef(createPlaybackDrain());
  const lifetime = useRef(createJarvisSessionLifetime());
  const mounted = useRef(true);
  const reconciling = useRef(false);
  const lock = useRef(false);
  const keepListening = useRef(false);
  const renewalTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function persistRecordings() {
    if (mounted.current) setPending(recordings.current[0] ?? null);
    try {
      if (recordings.current.length) localStorage.setItem(storageKey, JSON.stringify(recordings.current.length === 1 ? recordings.current[0] : recordings.current));
      else localStorage.removeItem(storageKey);
    } catch {
      /* Keep recovery in memory if browser storage is disabled. */
    }
  }
  function remember(value: SavedSession) {
    session.current = value;
    if (!recordings.current.some(item => item.captureId === value.captureId)) recordings.current.push(value);
    persistRecordings();
  }
  useEffect(() => {
    mounted.current = true;
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || "null");
      recordings.current = (Array.isArray(saved) ? saved : saved ? [saved] : []).filter(value =>
        value && typeof value.captureId === "string" && typeof value.conversationId === "string" && /^[0-9a-f-]{36}$/i.test(value.captureId) && /^[\w-]+$/.test(value.conversationId));
      if (recordings.current.length) {
        setPending(recordings.current[0]);
        setStatus("Disconnected. Recording needs reconciliation.");
      }
    } catch {
      /* No stored recovery. */
    }
    return () => {
      mounted.current = false;
      keepListening.current = false;
      if (renewalTimer.current) clearTimeout(renewalTimer.current);
      void connection.current?.endSession().catch(() => {});
    };
  }, []);
  async function reconcile() {
    if (reconciling.current) return;
    reconciling.current = true;
    try {
      for (const value of [...recordings.current]) {
        if (connection.current && session.current?.captureId === value.captureId) continue;
        try {
          const result = await post(value.captureId, "reconcile", {
            conversationId: value.conversationId,
          });
          if (!mounted.current) return;
          if (result.status === "archived") {
            record("recording.archived", value.captureId);
            setArchived(value.captureId);
            recordings.current = recordings.current.filter(item => item.captureId !== value.captureId);
            if (session.current?.captureId === value.captureId && !connection.current) session.current = null;
            persistRecordings();
            if (!connection.current && !lock.current) setStatus(
              "Conversation archived. Original audio and final transcript retained.",
            );
          } else if (!connection.current && !lock.current)
            setStatus("Final provider recording pending. Retry recording retrieval shortly.");
        } catch (e) {
          if (mounted.current && !connection.current && !lock.current)
            setStatus(e instanceof Error ? e.message : "Recording unavailable. Retry retrieval.");
        }
      }
    } finally {
      reconciling.current = false;
    }
  }
  useEffect(() => {
    if (!connected || toolsPending === 0) return;
    void refreshOutcomes(false);
    const timer = setInterval(() => void refreshOutcomes(false), 500);
    return () => clearInterval(timer);
  }, [connected, toolsPending]);
  async function refreshOutcomes(refresh = true) {
    const current = session.current;
    if (!current) return;
    while (outcomesLoading.current) {
      if (!refresh) return;
      await outcomesLoading.current;
    }
    const request = (async () => {
      try {
        const value = await readTodoJson<
          components["schemas"]["TodoJarvisOutcomes"]
        >(`/api/v1/todo-jarvis/${current.captureId}/commands`);
        if (mounted.current) {
          setOutcomes(value.commands);
          (onCreates ?? store.syncVoiceCreates)(value.commands);
        }
      } catch {
        if (mounted.current)
          setStatus(
            "Save outcomes unavailable. Check Client permissions and refresh tasks before retrying the same command.",
          );
      }
    })();
    outcomesLoading.current = request;
    try {
      await request;
    } finally {
      outcomesLoading.current = null;
    }
    if (refresh) await (refreshTasks ?? store.refreshAfterWrite)();
  }
  async function begin() {
    if (lock.current || connection.current || document.visibilityState === "hidden") return;
    lock.current = true;
    keepListening.current = true;
    setBusy(true);
    setArchived("");
    setOutcomes([]);
    setTranscript([]);
    setState("connecting");
    void reconcile();
    record("connection.start");
    setStatus("Connecting to private Jarvis…");
    drain.current = createPlaybackDrain();
    lifetime.current = createJarvisSessionLifetime();
    speaking.current = false;
    inFlightTools.current = 0;
    const captureId = crypto.randomUUID();
    let disconnected = false;
    try {
      const result = await post(captureId, "access");
      if (!result.signedUrl)
        throw Error("Temporary conversation access unavailable.");
      if (!mounted.current || !keepListening.current) return;
      const active = await start(result.signedUrl, captureId, {
        connected(conversationId) {
          lifetime.current.speech();
          remember({ captureId, conversationId });
          if (mounted.current) {
            setState("listening");
            record("connection.connected", conversationId);
            setConnected(true);
            setStatus("Connected · task conversation. Microphone active.");
          }
        },
        disconnected(reason) {
          disconnected = true;
          connection.current = null;
          if (mounted.current) {
            setState("disconnected");
            record("connection.disconnected");
            setConnected(false);
            setToolsPending(0);
            setTranscript([]);
            setStatus("Disconnected. Retrieving final recording…");
            void reconcile();
            if (reason === "duration" && keepListening.current && !lifetime.current.idleExpired() && document.visibilityState !== "hidden") {
              // Only the provider duration limit restarts automatically, never end_call or errors.
              renewalTimer.current = setTimeout(() => {
                renewalTimer.current = null;
                if (mounted.current && keepListening.current) void begin();
              }, 0);
            }
          }
        },
        message(role, text, eventId) {
          drain.current.message(role);
          if (role === "user" && text.trim()) lifetime.current.speech();
          if (mounted.current) {
            record(`message.${role}`, `${text.length} characters`);
            if ((role === "user" || role === "agent") && text.trim()) {
              const line = { id: `${role}:${eventId ?? ++transcriptId.current}`, role, text } as TranscriptLine;
              setTranscript(previous => {
                const index = previous.findIndex(item => item.id === line.id);
                return index >= 0 ? previous.map((item, i) => i === index ? line : item) : [...previous, line].slice(-2);
              });
            }
            if (role === "user") setState("thinking");
          }
        },
        userActivity() { lifetime.current.speech(); sendUiContext(); },
        mode(isSpeaking) {
          speaking.current = isSpeaking;
          setState(
            isSpeaking
              ? "speaking"
              : inFlightTools.current
                ? "thinking"
                : "listening",
          );
          record("audio.mode", isSpeaking ? "speaking" : "listening");
          drain.current.mode(isSpeaking);
        },
        activity() {
          drain.current.activity();
        },
        tool(value) {
          inFlightTools.current = Math.max(
            0,
            inFlightTools.current + (value ? 1 : -1),
          );
          setState(
            inFlightTools.current
              ? "thinking"
              : speaking.current
                ? "speaking"
                : "listening",
          );
          if (mounted.current)
            setToolsPending((count) => Math.max(0, count + (value ? 1 : -1)));
          drain.current.tool(value);
        },
        changed() {
          void refreshOutcomes();
        },
        result(text) {
          if (mounted.current) setStatus(text);
        },
        event: record,
        error(detail) {
          setState("failed");
          record("connection.error", detail || "Connection or task access unavailable");
          if (mounted.current) setToolsPending(0);
          drain.current.failed();
          void refreshOutcomes();
          if (mounted.current)
            setStatus(
              "Connection or task access unavailable. Loaded task information may be stale. End and retrieve recording.",
            );
        },
        showTask: (number) => uiCallbacks.current.showTask(number),
        findTask: (query) => uiCallbacks.current.findTask(query),
        ui: (action) => uiCallbacks.current.ui(action),
        uiContext: () => jarvisContextMessage(ui.context()),
      });
      if (!mounted.current || !keepListening.current) await active.endSession();
      else if (!disconnected) {
        connection.current = active;
        lastContext.current = "";
        sendUiContext();
      }
    } catch (e) {
      // Startup can fail after onConnect has supplied a recoverable capture.
      connection.current = null;
      if (mounted.current) {
        setState("failed");
        record("connection.failed");
        setConnected(false);
        setStatus(
          e instanceof Error
            ? e.message
            : "Connection failed. Check microphone permission and retry.",
        );
      }
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function end(renew = false) {
    if (!renew) {
      keepListening.current = false;
      if (renewalTimer.current) clearTimeout(renewalTimer.current);
      renewalTimer.current = null;
    }
    if (lock.current || !connection.current) return;
    lock.current = true;
    setBusy(true);
    setStatus(renew ? "Renewing Jarvis connection…" : "Stopping Jarvis…");
    const active = connection.current;
    active.setMicMuted(true);
    let ended = false;
    try {
      await active.endSession();
      connection.current = null;
      ended = true;
      setConnected(false);
      setState("disconnected");
      setTranscript([]);
      setToolsPending(0);
      setVolume(0);
      void reconcile();
    } catch (e) {
      keepListening.current = false;
      setStatus(e instanceof Error ? e.message : "Could not end session. Retry.");
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
    if (renew && ended && mounted.current && keepListening.current) await begin();
  }
  const stopForLifecycle = useEffectEvent(() => {
    // Cancel startup/renewal too; resuming the page always needs a manual start.
    keepListening.current = false;
    connection.current?.setMicMuted(true);
    void end();
  });
  useEffect(() => {
    const hide = () => stopForLifecycle();
    const visibility = () => { if (document.visibilityState === "hidden") hide(); };
    window.addEventListener("pagehide", hide);
    window.addEventListener("offline", hide);
    document.addEventListener("freeze", hide);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("pagehide", hide);
      window.removeEventListener("offline", hide);
      document.removeEventListener("freeze", hide);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);
  const maintainSession = useEffectEvent(() => {
    if (document.visibilityState === "hidden" || lifetime.current.idleExpired()) {
      void end();
      return;
    }
    // Context deduplication sends only minute/date changes, with no API fetches.
    sendUiContext();
    if (keepListening.current && lifetime.current.renewalDue() && drain.current.ready()) void end(true);
  });
  useEffect(() => {
    if (!connected) return;
    const timer = setInterval(maintainSession, 1000);
    return () => clearInterval(timer);
  }, [connected]);
  useEffect(() => {
    if (!connected) return;
    const timer = setInterval(() => {
      const active = connection.current;
      setVolume(
        (speaking.current
          ? active?.getOutputVolume?.()
          : active?.getInputVolume?.()) ?? 0,
      );
    }, 50);
    return () => clearInterval(timer);
  }, [connected]);
  useEffect(() => {
    for (const command of outcomes) {
      const fingerprint = JSON.stringify([command.state, command.outcomes]);
      if (notifiedOutcomes.current.get(command.commandId) === fingerprint)
        continue;
      notifiedOutcomes.current.set(command.commandId, fingerprint);
      record(
        "task.delivery",
        JSON.stringify({
          commandId: command.commandId,
          number: command.number,
          state: command.state,
          outcomes: command.outcomes,
        }),
      );
    }
  }, [outcomes]);
  const control: JarvisControl = {
    status,
    notice: state === "failed" || /unavailable|failed|could not|permission required/i.test(status)
      ? status
      : outcomes.some(command => command.state !== "pending" && Object.values(command.outcomes).some(value => value !== "saved"))
        ? "Some task changes failed or need review"
        : null,
    volume,
    state,
    connected,
    transcript,
    busy,
    pending: !!pending,
    begin,
    end,
    reconcile,
    openDebug: () => setDebugOpen(true),
  };
  return (
    <JarvisUi value={ui}><JarvisContext value={control}>
      {children}
      <Dialog.Root open={debugOpen} onOpenChange={(details) => setDebugOpen(details.open)} modal={false} closeOnInteractOutside={false} scrollBehavior="inside" size="md">
        <Portal>
          <Dialog.Positioner>
            <Dialog.Content>
              <Dialog.Header>
                <Dialog.Title>Jarvis debug</Dialog.Title>
              </Dialog.Header>
              <Dialog.CloseTrigger asChild><CloseButton size="sm" /></Dialog.CloseTrigger>
              <Dialog.Body>
                <Stack gap="3">
                  <Dialog.Description>
                    Connection, agent actions and delivery events for this session.
                  </Dialog.Description>
                  <Flex wrap="wrap" align="center" gap="3">
                    <Aura size="sm" state={state} volume={volume} aria-hidden="true" />
                    <Text flex="1" minW="0" textStyle="sm" wordBreak="break-word">{status}</Text>
                    <Button variant="outline" size="sm" onClick={() => setEvents([])}>
                      Clear events
                    </Button>
                  </Flex>
                  <Stack as="ol" aria-label="Jarvis events" gap="2" maxH="50vh" overflowY="auto" fontFamily="mono" textStyle="xs" listStyle="none" m="0" p="0">
                    {events.length === 0 && <li>No events yet.</li>}
                    {events.map((event) => (
                      <li key={event.id}>
                        <time>{event.time}</time> <strong>{event.type}</strong>
                        {event.detail && (
                          <Text color="fg.muted" wordBreak="break-word">
                            {event.detail}
                          </Text>
                        )}
                      </li>
                    ))}
                  </Stack>
                  {pending && !connected && (
                    <Button variant="outline" disabled={busy} onClick={() => void reconcile()}>
                      Retry recording retrieval
                    </Button>
                  )}
                  {archived && <TodoCaptureReview id={archived} />}
                </Stack>
              </Dialog.Body>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    </JarvisContext></JarvisUi>
  );
}

// Minimal floating assistant shown while a session is connecting or live. Full transcript and history live on /jarvis.
export function JarvisVoiceActivity() {
  const jarvis = useJarvis();
  const { scrollRef, contentRef } = useStickToBottom();
  const pathname = usePathname();
  // The /jarvis page shows the full live chat and its own voice bar.
  if (pathname === "/jarvis") return null;
  if (!jarvis || (!jarvis.connected && jarvis.state !== "connecting")) return null;
  return (
    <Flex
      aria-label="Jarvis voice activity"
      position="fixed"
      zIndex="docked"
      insetX="3"
      mx="auto"
      maxW="md"
      align="center"
      gap="3"
      p="2"
      ps="3"
      bg="bg"
      borderWidth="1px"
      rounded="l3"
      shadow="lg"
      css={{ bottom: "calc(0.75rem + env(safe-area-inset-bottom, 0px))" }}
    >
      <Box flexShrink={0} aria-hidden="true"><Aura size="icon" state={jarvis.state} volume={jarvis.volume} aria-hidden="true" /></Box>
      <VisuallyHidden role="status">Jarvis {jarvis.state}</VisuallyHidden>
      <Stack flex="1" minW="0" gap="1">
        <Box
          ref={scrollRef}
          role="log"
          aria-label="Live Jarvis transcript"
          aria-live="polite"
          aria-relevant="additions text"
          tabIndex={jarvis.transcript.length ? 0 : -1}
          maxH="10"
          overflowY="auto"
          textStyle="xs"
          lineHeight="shorter"
          color="fg.muted"
        >
          <div ref={contentRef}>
            {jarvis.transcript.map((line) => (
              <Text key={line.id} whiteSpace="pre-wrap" wordBreak="break-word">
                <Text as="span" fontWeight="medium" color="fg">{line.role === "user" ? "You" : "Jarvis"}: </Text>{line.text}
              </Text>
            ))}
          </div>
        </Box>
        <ChakraLink asChild textStyle="xs" color="fg.muted" w="fit-content"><Link href="/jarvis">Open conversation</Link></ChakraLink>
      </Stack>
      <Button size="sm" variant="outline" flexShrink={0} disabled={jarvis.busy} onClick={() => void jarvis.end()}>
        <SquareIcon aria-hidden="true" />Stop
      </Button>
    </Flex>
  );
}

// Jarvis controls for the app shell navigation (Chakra NavAction buttons).
export function JarvisNavActions({ fullWidth = false }: { fullWidth?: boolean }) {
  const jarvis = useJarvis();
  if (!jarvis) return null;
  const width = fullWidth ? { w: "full", justifyContent: "flex-start" } as const : {};
  return (
    <>
      <NavAction
        {...width}
        aria-pressed={jarvis.connected}
        aria-label={jarvis.connected ? "Stop Jarvis" : "Start Jarvis"}
        title={jarvis.connected ? "Stop Jarvis" : "Start Jarvis"}
        bg={jarvis.connected ? "bg.muted" : "transparent"}
        color={jarvis.connected ? "fg" : "fg.muted"}
        disabled={jarvis.busy}
        onClick={() => void (jarvis.connected ? jarvis.end() : jarvis.begin())}
      >
        <MicIcon />Jarvis{jarvis.connected && <PauseIcon aria-hidden="true" />}
      </NavAction>
      {jarvis.notice && (
        <>
          <VisuallyHidden role="status">{jarvis.notice}</VisuallyHidden>
          <NavAction {...width} title={jarvis.notice} onClick={jarvis.openDebug}>
            <CircleAlertIcon />Review Jarvis status
          </NavAction>
        </>
      )}
      {process.env.NODE_ENV !== "production" && (
        <NavAction {...width} onClick={jarvis.openDebug}>
          <BugIcon />Jarvis debug
        </NavAction>
      )}
    </>
  );
}

// True while Jarvis voice activity is visible (connecting or connected).
export function useJarvisActive() {
  const jarvis = useJarvis();
  return !!jarvis && (jarvis.connected || jarvis.state === "connecting");
}
