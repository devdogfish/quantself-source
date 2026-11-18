"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { ArrowDownIcon, ChevronLeftIcon, CopyIcon, MicIcon, PhoneIcon, PlusIcon, SquareIcon, Trash2Icon } from "lucide-react";
import { useStickToBottom } from "use-stick-to-bottom";
import { Box, Button, Center, CloseButton, Dialog, Flex, HStack, IconButton, Portal, Skeleton, Stack, Text, VisuallyHidden } from "@chakra-ui/react";
import { toaster } from "@/components/chakra/toaster";
import { useJarvis } from "@/app/todo/todo-jarvis";
import {
  audioSrc, deleteConversation, listConversations, readConversation,
  type ConversationDetail, type ConversationSummary,
} from "./jarvis-api";

const Aura = dynamic(
  () => import("./audio-visualizer/agent-audio-visualizer-aura").then((m) => m.AgentAudioVisualizerAura),
  { ssr: false },
);
const LIVE = "live";
const ZONE = "America/Halifax";
const dayKey = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: ZONE }).format(d);
const when = (iso: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
const time = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, timeStyle: "short" }).format(new Date(iso));
const message = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong.");

// Sidebar groups by Halifax calendar day, like a chat app's history.
function groupOf(iso: string, now = new Date()) {
  const day = dayKey(new Date(iso));
  if (day === dayKey(now)) return "Today";
  if (day === dayKey(new Date(now.getTime() - 864e5))) return "Yesterday";
  if (now.getTime() - new Date(iso).getTime() < 7 * 864e5) return "Previous 7 days";
  return "Older";
}
const GROUPS = ["Today", "Yesterday", "Previous 7 days", "Older"] as const;

function JarvisAvatar({ state, volume }: { state?: string; volume?: number }) {
  return (
    <Center w="8" h="8" flexShrink={0} rounded="full" bg="bg.muted" overflow="hidden" aria-hidden="true">
      {state ? <Aura size="icon" state={state as never} volume={volume ?? 0} /> : <MicIcon size={14} />}
    </Center>
  );
}

function Turn({ mine, text }: { mine: boolean; text: string }) {
  if (mine) {
    return (
      <Flex justify="flex-end">
        <Box maxW="80%" px="4" py="2.5" rounded="2xl" bg="bg.muted">
          <VisuallyHidden>You: </VisuallyHidden>
          <Text textStyle="sm" whiteSpace="pre-wrap">{text}</Text>
        </Box>
      </Flex>
    );
  }
  return (
    <HStack align="start" gap="3" className="group">
      <JarvisAvatar />
      <Stack gap="1" minW="0" flex="1" pt="1">
        <VisuallyHidden>Jarvis: </VisuallyHidden>
        <Text textStyle="sm" whiteSpace="pre-wrap">{text}</Text>
        <HStack gap="0" opacity="0" _groupHover={{ opacity: 1 }} _focusWithin={{ opacity: 1 }}>
          <IconButton size="2xs" variant="ghost" color="fg.muted" aria-label="Copy message"
            onClick={() => void navigator.clipboard?.writeText(text).then(() => toaster.create({ type: "success", title: "Copied" }))}>
            <CopyIcon />
          </IconButton>
        </HStack>
      </Stack>
    </HStack>
  );
}

// Scrolls a chat column and keeps it pinned to the newest line while content arrives.
function ChatScroll({ children }: { children: React.ReactNode }) {
  const { scrollRef, contentRef, isAtBottom, scrollToBottom } = useStickToBottom({ initial: "instant", resize: "smooth" });
  return (
    <Box position="relative" flex="1" minH="0">
      <Box ref={scrollRef} h="full" overflowY="auto" overscrollBehavior="contain">
        <Stack ref={contentRef} gap="6" maxW="3xl" mx="auto" px={{ base: "4", md: "6" }} py="6">{children}</Stack>
      </Box>
      {!isAtBottom && (
        <IconButton size="sm" variant="outline" rounded="full" bg="bg" position="absolute" bottom="3" left="50%" transform="translateX(-50%)"
          aria-label="Jump to latest" onClick={() => void scrollToBottom()}>
          <ArrowDownIcon />
        </IconButton>
      )}
    </Box>
  );
}

function LiveChat() {
  const jarvis = useJarvis();
  if (!jarvis) return <Center flex="1"><Text color="fg.muted">Jarvis is unavailable.</Text></Center>;
  return (
    <ChatScroll>
      {jarvis.notice && <Text textStyle="sm" color="fg.error" role="status">{jarvis.notice}</Text>}
      {jarvis.transcript.length === 0 && (
        <HStack gap="3"><JarvisAvatar state={jarvis.state} volume={jarvis.volume} /><Text textStyle="sm" color="fg.muted">Listening… say something.</Text></HStack>
      )}
      <Box role="log" aria-label="Live Jarvis transcript" aria-live="polite">
        <Stack gap="6">{jarvis.transcript.map((l) => <Turn key={l.id} mine={l.role === "user"} text={l.text} />)}</Stack>
      </Box>
    </ChatScroll>
  );
}

function HistoryChat({ detail, error, onRetry }: { detail?: ConversationDetail; error: string | null; onRetry(): void }) {
  if (error) return <Center flex="1"><Stack gap="3" align="center"><Text color="fg.error" role="alert">{error}</Text><Button size="sm" variant="outline" onClick={onRetry}>Retry</Button></Stack></Center>;
  if (!detail) return <Stack gap="4" maxW="3xl" w="full" mx="auto" p="6"><Skeleton h="10" w="60%" /><Skeleton h="10" w="40%" alignSelf="end" /><Skeleton h="16" w="70%" /></Stack>;
  return (
    <ChatScroll>
      {detail.summary && (
        <Box borderWidth="1px" rounded="l3" px="4" py="3" bg="bg.subtle">
          <Text textStyle="xs" fontWeight="medium" color="fg.muted" mb="1">Summary</Text>
          <Text textStyle="sm">{detail.summary}</Text>
        </Box>
      )}
      {detail.turns.length === 0 && <Text textStyle="sm" color="fg.muted">No spoken conversation retained.</Text>}
      {detail.turns.map((t, i) => <Turn key={i} mine={t.role === "user"} text={t.text} />)}
    </ChatScroll>
  );
}

// Voice "composer": a compact mic button that slides out into a full bar while a session runs.
const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
function VoiceBar() {
  const jarvis = useJarvis();
  if (!jarvis) return null;
  const on = jarvis.connected || jarvis.state === "connecting";
  // Stay open while starting or ending, so the bar doesn't flicker shut mid-transition.
  const open = on || jarvis.busy;
  return (
    <Box px={{ base: "3", md: "6" }} pb="4" pt="2" flexShrink={0}>
      <HStack mx="auto" w="full" maxW={open ? "3xl" : "12"} h="12" gap="3" ps={open ? "2" : "0"} pe={open ? "2" : "0"}
        borderWidth="1px" rounded="full" bg="bg" shadow="sm" overflow="hidden"
        transition={`max-width 360ms ${EASE}, padding 360ms ${EASE}`} _motionReduce={{ transition: "none" }}>
        {open ? (
          <>
            <JarvisAvatar state={jarvis.state} volume={jarvis.volume} />
            <Text flex="1" minW="0" textStyle="sm" color="fg.muted" truncate role="status"
              css={{ animation: `jarvis-fade 240ms ${EASE} 160ms both`, "@keyframes jarvis-fade": { from: { opacity: 0 }, to: { opacity: 1 } } }}>
              {jarvis.connected ? `Jarvis is ${jarvis.state}…` : jarvis.busy && !on ? "Wrapping up…" : "Connecting…"}
            </Text>
            <Button size="sm" rounded="full" variant="outline" flexShrink={0} disabled={jarvis.busy} onClick={() => void jarvis.end()}>
              <SquareIcon />Stop
            </Button>
          </>
        ) : (
          <IconButton w="full" h="full" rounded="full" variant="ghost" aria-label="Start Jarvis" title="Talk to Jarvis"
            onClick={() => void jarvis.begin()}>
            <MicIcon />
          </IconButton>
        )}
      </HStack>
    </Box>
  );
}

export function JarvisHistory({ initialId = null }: { initialId?: string | null }) {
  const jarvis = useJarvis();
  const [items, setItems] = useState<ConversationSummary[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState<"idle" | "loading">("idle");
  const [selected, setSelected] = useState<string | null>(initialId);
  const [details, setDetails] = useState<Record<string, ConversationDetail>>({});
  const [detailError, setDetailError] = useState<Record<string, string>>({});
  const requested = useRef(new Set<string>());
  const deleting = useRef(new Set<string>());
  const [confirming, setConfirming] = useState<string | null>(null);
  const live = !!jarvis && (jarvis.connected || jarvis.busy || jarvis.state === "connecting");

  const loadFirst = useCallback(async (silent = false) => {
    if (!silent) setStatus("loading");
    try {
      const page = await listConversations();
      const fresh = page.conversations.filter((c) => !deleting.current.has(c.id));
      if (silent) {
        // Keep older pages already loaded; only prepend newly archived conversations.
        setItems((cur) => [...fresh.filter((c) => !cur.some((x) => x.id === c.id)), ...cur]);
      } else { setItems(fresh); setNext(page.nextCursor); }
      setStatus("ready");
    } catch (e) {
      if (!silent) { setError(message(e)); setStatus("error"); }
    }
  }, []);
  useEffect(() => { void loadFirst(); }, [loadFirst]);

  const loadMore = async () => {
    if (!next) return;
    setMore("loading");
    try {
      const page = await listConversations(next);
      setItems((cur) => [...cur, ...page.conversations.filter((c) => !cur.some((x) => x.id === c.id))]);
      setNext(page.nextCursor);
    } catch (e) { toaster.create({ type: "error", title: "Could not load older conversations", description: message(e) }); }
    setMore("idle");
  };

  const select = (id: string) => {
    setSelected(id);
    const url = new URL(window.location.href);
    if (id === LIVE) url.searchParams.delete("c"); else url.searchParams.set("c", id);
    window.history.replaceState(null, "", url);
  };
  const effective = selected === LIVE ? (live ? LIVE : null) : selected ?? (live ? LIVE : null);
  const showLive = effective === LIVE;

  const loadDetail = useCallback(async (id: string) => {
    requested.current.add(id);
    setDetailError(({ [id]: _, ...rest }) => rest);
    try {
      const d = await readConversation(id);
            setDetails((cur) => ({ ...cur, [id]: d }));
    } catch (e) { requested.current.delete(id); setDetailError((cur) => ({ ...cur, [id]: message(e) })); }
  }, []);
  useEffect(() => {
    if (effective && effective !== LIVE && !requested.current.has(effective) && !details[effective]) void loadDetail(effective);
  }, [effective, details, loadDetail]);

  // Refetch the first page after a session ends; the archive may lag, so one delayed retry.
  const wasLive = useRef(false);
  useEffect(() => {
    if (live) { wasLive.current = true; return; }
    if (!wasLive.current) return;
    wasLive.current = false;
    void loadFirst(true);
    const t = setTimeout(() => void loadFirst(true), 5000);
    return () => clearTimeout(t);
  }, [live, loadFirst]);

  const remove = async (id: string) => {
    setConfirming(null);
    const index = items.findIndex((c) => c.id === id);
    const removed = items[index];
    setItems((cur) => cur.filter((c) => c.id !== id));
    if (selected === id) {
      setSelected(null);
      const url = new URL(window.location.href);
      url.searchParams.delete("c");
      window.history.replaceState(null, "", url);
    }
    deleting.current.add(id);
    try { await deleteConversation(id); deleting.current.delete(id); }
    catch (e) {
      deleting.current.delete(id);
      setItems((cur) => cur.some((c) => c.id === id) || !removed ? cur
        : [...cur.slice(0, index), removed, ...cur.slice(index)].sort((a, b) => b.capturedAt.localeCompare(a.capturedAt)));
      toaster.create({ type: "error", title: "Delete failed — conversation restored", description: message(e) });
    }
  };

  const [mobileList, setMobileList] = useState(false);
  const open = (id: string) => { select(id); setMobileList(false); };
  const startNew = () => {
    open(LIVE);
    if (jarvis && !jarvis.connected && !jarvis.busy) void jarvis.begin();
  };

  const row = (id: string, active: boolean, children: React.ReactNode) => (
    <HStack as="button" key={id} textAlign="left" w="full" gap="2.5" px="2.5" py="2" rounded="l2" textStyle="sm"
      bg={active ? "bg.muted" : "transparent"} _hover={{ bg: "bg.muted" }} aria-current={active ? "true" : undefined} onClick={() => open(id)}>
      {children}
    </HStack>
  );
  const grouped = GROUPS.map((g) => ({ g, rows: items.filter((c) => groupOf(c.capturedAt) === g) })).filter((x) => x.rows.length);

  const sidebar = (
    <Stack gap="0" h="full">
      <Box p="3">
        <Button w="full" justifyContent="flex-start" variant="ghost" size="sm" disabled={!jarvis || jarvis.busy} onClick={startNew}>
          <PlusIcon />New conversation
        </Button>
      </Box>
      <Stack as="nav" aria-label="Jarvis conversations" gap="4" px="3" pb="4" overflowY="auto" overscrollBehavior="contain" flex="1" minH="0">
        {live && (
          <Stack gap="0.5">
            {row(LIVE, showLive, <>
              <Box w="2" h="2" rounded="full" bg="red.solid" flexShrink={0} aria-hidden="true" />
              <Text truncate flex="1">Current conversation</Text>
            </>)}
          </Stack>
        )}
        {status === "loading" && <Stack gap="2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} h="8" />)}</Stack>}
        {status === "error" && (
          <Stack gap="2" align="start"><Text textStyle="sm" color="fg.error" role="alert">{error}</Text>
            <Button size="xs" variant="outline" onClick={() => void loadFirst()}>Retry</Button></Stack>
        )}
        {status === "ready" && items.length === 0 && <Text px="2.5" textStyle="sm" color="fg.muted">No conversations yet.</Text>}
        {grouped.map(({ g, rows }) => (
          <Stack key={g} gap="0.5">
            <Text px="2.5" pb="1" textStyle="xs" fontWeight="medium" color="fg.muted">{g}</Text>
            {rows.map((c) => row(c.id, effective === c.id, <>
              <Box color="fg.muted" flexShrink={0} aria-hidden="true">{c.channel === "phone" ? <PhoneIcon size={15} /> : <MicIcon size={15} />}</Box>
              <VisuallyHidden>{c.channel === "phone" ? "Phone" : "App"}</VisuallyHidden>
              <Text truncate flex="1" title={c.summary ?? c.preview}>{c.summary ?? c.preview}</Text>
              <Text textStyle="xs" color="fg.subtle" flexShrink={0}>{g === "Today" || g === "Yesterday" ? time(c.capturedAt) : new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, month: "short", day: "numeric" }).format(new Date(c.capturedAt))}</Text>
            </>))}
          </Stack>
        ))}
        {status === "ready" && next && (
          <Button size="xs" variant="ghost" color="fg.muted" loading={more === "loading"} onClick={() => void loadMore()}>Load older</Button>
        )}
      </Stack>
    </Stack>
  );

  const current = effective && effective !== LIVE ? items.find((c) => c.id === effective) ?? details[effective] : undefined;
  const header = (
    <HStack h="14" flexShrink={0} gap="2" px={{ base: "2", md: "4" }} borderBottomWidth="1px">
      <IconButton display={{ md: "none" }} size="sm" variant="ghost" aria-label="All conversations" onClick={() => setMobileList(true)}><ChevronLeftIcon /></IconButton>
      <Stack gap="0" flex="1" minW="0">
        <Text fontWeight="medium" truncate>{showLive ? "Current conversation" : current ? when(current.capturedAt) : "Jarvis"}</Text>
        {current && <Text textStyle="xs" color="fg.muted">{current.channel === "phone" ? "Phone call" : "In app"}</Text>}
      </Stack>
      {current && details[current.id]?.hasAudio && (
        <Box display={{ base: "none", md: "block" }}><audio controls preload="none" src={audioSrc(current.id)} style={{ height: 32 }} /></Box>
      )}
      {current && (
        <IconButton size="sm" variant="ghost" color="fg.muted" aria-label="Delete conversation" onClick={() => setConfirming(current.id)}>
          <Trash2Icon /><VisuallyHidden>Delete</VisuallyHidden>
        </IconButton>
      )}
    </HStack>
  );

  // App-style page: the sidebars stay put and only the list and chat scroll, never the document.
  useEffect(() => {
    const root = document.documentElement;
    const previous = root.style.overflow;
    root.style.overflow = "hidden";
    return () => { root.style.overflow = previous; };
  }, []);

  const showList = mobileList || !effective;
  return (
    <>
      <Flex h="calc(100dvh - var(--shell-top))" minH="0" overflow="hidden">
        <Box as="aside" h="full" minH="0" w={{ base: "full", md: "72" }} flexShrink={0} borderEndWidth={{ md: "1px" }} bg="bg.subtle"
          display={{ base: showList ? "block" : "none", md: "block" }}>
          {sidebar}
        </Box>
        <Flex direction="column" flex="1" minW="0" display={{ base: showList ? "none" : "flex", md: "flex" }}>
          {header}
          {current && details[current.id]?.hasAudio && (
            <Box display={{ md: "none" }} px="4" pt="3"><audio controls preload="none" src={audioSrc(current.id)} style={{ width: "100%" }} /></Box>
          )}
          {showLive ? <LiveChat /> : effective ? (
            <HistoryChat detail={details[effective]} error={detailError[effective] ?? null} onRetry={() => void loadDetail(effective)} />
          ) : (
            <Center flex="1"><Stack gap="2" align="center"><Text fontWeight="medium">Your Jarvis conversations</Text>
              <Text textStyle="sm" color="fg.muted">Pick one on the left, or start talking below.</Text></Stack></Center>
          )}
          <VoiceBar />
        </Flex>
      </Flex>
      <Dialog.Root role="alertdialog" open={!!confirming} onOpenChange={(e) => !e.open && setConfirming(null)}>
        <Portal><Dialog.Backdrop /><Dialog.Positioner><Dialog.Content>
          <Dialog.Header><Dialog.Title>Delete conversation?</Dialog.Title></Dialog.Header>
          <Dialog.Body><Text>This permanently deletes the transcript and audio. It cannot be undone.</Text></Dialog.Body>
          <Dialog.Footer>
            <Button variant="outline" onClick={() => setConfirming(null)}>Cancel</Button>
            <Button colorPalette="red" onClick={() => confirming && void remove(confirming)}>Delete</Button>
          </Dialog.Footer>
          <Dialog.CloseTrigger asChild><CloseButton size="sm" /></Dialog.CloseTrigger>
        </Dialog.Content></Dialog.Positioner></Portal>
      </Dialog.Root>
    </>
  );
}
