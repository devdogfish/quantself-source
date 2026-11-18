"use client";

import Link from "next/link";

import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  type DragEndEvent,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  Alert,
  Badge,
  Box,
  Button,
  Drawer,
  Field,
  Flex,
  Grid,
  HStack,
  IconButton,
  Input,
  Portal,
  Progress,
  Slider,
  Stack,
  Text,
} from "@chakra-ui/react";
import {
  ActivityIcon,
  CalendarClockIcon,
  ChartNoAxesCombinedIcon,
  CheckIcon,
  CoffeeIcon,
  GripVerticalIcon,
  LayoutDashboardIcon,
  LockIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  XIcon,
  RotateCcwIcon,
  SlidersHorizontalIcon,
  SquareStackIcon,
  TimerResetIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { ProductivitySignalChart } from "@/components/productivity-signal-chart";
import { FilterSelect } from "@/components/shared/filter-select";
import { Panel, Stat } from "@/components/shared/dashboard";
import { PageBody, PageHeader } from "@/components/shared/page-layout";
import {
  addMinutesToTime,
  createInitialPlan,
  extendCurrentMove,
  finishCurrentMove,
  focusModes,
  getDefaultModeForKind,
  isMoveFixedInPlan,
  previewCurrentPlan,
  recoveryModes,
  refreshFuturePlan,
  reorderFutureMove,
  updateFutureMove,
  type Move,
  type MoveKind,
  type MoveMode,
  type PlanState,
} from "@/lib/focus-plan";

type TimerRuntime = {
  notifiedMoveId?: string;
  pausedElapsedSeconds?: number;
  startedAtMs?: number;
  status: "idle" | "running" | "paused";
};

type TimerStatus = {
  elapsedSeconds: number;
  overtimeSeconds: number;
  progressPercent: number;
  remainingSeconds: number;
};

const WORKDAY_START = 9;
const WORKDAY_END = 17;

const baseTrendData = [
  {
    caffeineLoad: 18,
    caffeineMg: 55,
    date: new Date("2026-06-26T09:00:00"),
    energy: 58,
    focus: 62,
    foodStability: 42,
    productivity: 55,
    substanceLoad: 0,
  },
  {
    caffeineLoad: 35,
    caffeineMg: 105,
    date: new Date("2026-06-26T10:00:00"),
    energy: 72,
    focus: 78,
    foodStability: 48,
    productivity: 74,
    substanceLoad: 0,
  },
  {
    caffeineLoad: 45,
    caffeineMg: 135,
    date: new Date("2026-06-26T11:00:00"),
    energy: 76,
    focus: 84,
    foodStability: 66,
    productivity: 82,
    substanceLoad: 0,
  },
  {
    caffeineLoad: 43,
    caffeineMg: 130,
    date: new Date("2026-06-26T12:30:00"),
    energy: 64,
    focus: 68,
    foodStability: 82,
    productivity: 61,
    substanceLoad: 10,
  },
  {
    caffeineLoad: 52,
    caffeineMg: 155,
    date: new Date("2026-06-26T14:00:00"),
    energy: 69,
    focus: 71,
    foodStability: 76,
    productivity: 73,
    substanceLoad: 12,
  },
  {
    caffeineLoad: 50,
    caffeineMg: 150,
    date: new Date("2026-06-26T15:30:00"),
    energy: 55,
    focus: 59,
    foodStability: 62,
    productivity: 57,
    substanceLoad: 12,
  },
];

const sectionLinks = [
  {
    href: "#overview",
    icon: LayoutDashboardIcon,
    title: "Overview",
  },
  {
    href: "#focus",
    icon: TimerResetIcon,
    title: "Focus",
  },
  {
    href: "#queue",
    icon: CalendarClockIcon,
    title: "Queue",
  },
  {
    href: "#signals",
    icon: ChartNoAxesCombinedIcon,
    title: "Signals",
  },
  {
    href: "#readout",
    icon: SquareStackIcon,
    title: "Readout",
  },
];

const emptyTimer: TimerRuntime = { status: "idle" };

function formatClock(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(
    2,
    "0",
  )}`;
}

function formatDuration(minutes: number) {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;

  if (hours === 0) {
    return `${rest}m`;
  }

  if (rest === 0) {
    return `${hours}h`;
  }

  return `${hours}h ${rest}m`;
}

function getWorkdayState(now: Date | null) {
  if (!now) {
    return { label: "syncing", progress: 0, remainingMinutes: 0 };
  }

  const start = new Date(now);
  start.setHours(WORKDAY_START, 0, 0, 0);
  const end = new Date(now);
  end.setHours(WORKDAY_END, 0, 0, 0);
  const total = end.getTime() - start.getTime();
  const elapsed = Math.min(Math.max(now.getTime() - start.getTime(), 0), total);
  const remaining = Math.max(end.getTime() - now.getTime(), 0);
  const remainingMinutes = Math.ceil(remaining / 60000);

  return {
    label:
      remainingMinutes === 0
        ? "done"
        : `${Math.floor(remainingMinutes / 60)}h ${remainingMinutes % 60}m`,
    progress: Math.round((elapsed / total) * 100),
    remainingMinutes,
  };
}

export function ProductivityDashboard() {
  const [now, setNow] = useState<Date | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [plan, setPlan] = useState<PlanState>(() => createInitialPlan());
  const [timer, setTimer] = useState<TimerRuntime>(emptyTimer);
  const [isAdjustOpen, setIsAdjustOpen] = useState(false);
  const [energy, setEnergy] = useState(67);
  const [focus, setFocus] = useState(74);
  const [caffeineMg, setCaffeineMg] = useState(120);
  const notifiedCompletionRef = useRef<string | null>(null);
  const baseCurrentMove = plan.moves[0];
  const workday = getWorkdayState(now);
  const timerStatus = baseCurrentMove
    ? getTimerStatus(baseCurrentMove, timer, nowMs)
    : null;
  const isTimerComplete = Boolean(
    timer.status === "running" &&
    timerStatus &&
    timerStatus.remainingSeconds === 0,
  );
  const overtimePlanMinutes =
    baseCurrentMove && timerStatus?.overtimeSeconds
      ? Math.max(
          baseCurrentMove.durationMinutes,
          Math.ceil(timerStatus.elapsedSeconds / 60),
        )
      : null;
  const visiblePlan = overtimePlanMinutes
    ? previewCurrentPlan(plan, overtimePlanMinutes)
    : plan;
  const currentMove = visiblePlan.moves[0];
  const futureMoves = visiblePlan.moves.slice(1);
  const dragSensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  useEffect(() => {
    const timeout = window.setTimeout(() => setNow(new Date()), 0);
    const interval = window.setInterval(() => setNow(new Date()), 30_000);

    return () => {
      window.clearTimeout(timeout);
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => setNowMs(Date.now()), 1000);

    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    notifiedCompletionRef.current = null;
  }, [baseCurrentMove?.id]);

  useEffect(() => {
    if (
      !baseCurrentMove ||
      !isTimerComplete ||
      notifiedCompletionRef.current === baseCurrentMove.id
    ) {
      return;
    }

    notifiedCompletionRef.current = baseCurrentMove.id;
    void notifyTimerComplete(baseCurrentMove);
  }, [baseCurrentMove, isTimerComplete]);

  const recoveryMinutes = visiblePlan.moves
    .filter((move) => move.kind === "recovery")
    .reduce((total, move) => total + move.durationMinutes, 0);
  const plannedBlocks = [
    {
      label: "Focus",
      minutes: sumMoveMinutes(visiblePlan.moves, "focus"),
    },
    {
      label: "Recovery",
      minutes: sumMoveMinutes(visiblePlan.moves, "recovery"),
    },
    {
      label: "Fixed",
      minutes: sumMoveMinutes(visiblePlan.moves, "meeting"),
    },
    {
      label: "Pinned",
      minutes: visiblePlan.moves
        .filter((move) => move.pinned)
        .reduce((total, move) => total + move.durationMinutes, 0),
    },
  ];
  const productivity = Math.round(
    focus * 0.52 +
      energy * 0.32 +
      Math.min(caffeineMg / 2.5, 60) * 0.1 +
      Math.min(recoveryMinutes, 45) * 0.12,
  );
  const trendData = [
    ...baseTrendData,
    {
      caffeineLoad: Math.min(Math.round(caffeineMg / 3), 100),
      caffeineMg,
      // Signal inputs update the sample day's endpoint, not its time range.
      date: new Date("2026-06-26T16:00:00"),
      energy,
      focus,
      foodStability: recoveryMinutes > 20 ? 84 : 68,
      productivity: Math.min(productivity, 100),
      substanceLoad: 8,
    },
  ];

  const handleFutureMoveDragEnd = useCallback(
    (event: DragEndEvent) => {
      if (!event.over) {
        return;
      }

      setPlan((currentPlan) =>
        reorderFutureMove(
          currentPlan,
          String(event.active.id),
          String(event.over?.id),
        ),
      );
    },
    [setPlan],
  );

  const startCurrentMove = () => {
    const startedAtMs = nowMs;
    setNowMs(startedAtMs);
    setTimer({ startedAtMs, status: "running" });
  };

  const pauseCurrentMove = () => {
    if (!timerStatus) {
      return;
    }

    setTimer({
      pausedElapsedSeconds: timerStatus.elapsedSeconds,
      status: "paused",
    });
  };

  const resumeCurrentMove = () => {
    const resumedAtMs = nowMs;
    const pausedElapsedSeconds = timer.pausedElapsedSeconds ?? 0;

    setNowMs(resumedAtMs);
    setTimer({
      startedAtMs: resumedAtMs - pausedElapsedSeconds * 1000,
      status: "running",
    });
  };

  const restartCurrentMove = () => {
    if (timer.status !== "idle") {
      return;
    }

    setNowMs(nowMs);
    setTimer(emptyTimer);
  };

  const extendCurrent = () => {
    if (!currentMove) {
      return;
    }

    const nextPlan = extendCurrentMove(plan, 5, new Date(nowMs));

    setPlan(nextPlan);
  };

  const finishCurrent = (startNext: boolean) => {
    if (!currentMove) {
      return;
    }

    const actionAtMs = nowMs;
    const nextPlan = finishCurrentMove(
      plan,
      timerStatus?.elapsedSeconds ?? null,
      new Date(actionAtMs),
    );
    const canStartNext = startNext && nextPlan.moves[0]?.id !== "day-closed";

    setNowMs(actionAtMs);
    setPlan(nextPlan);
    setTimer(
      canStartNext
        ? { startedAtMs: actionAtMs, status: "running" }
        : emptyTimer,
    );
  };

  return (
    <>
      <PageHeader
        title="Daily productivity cockpit"
        actions={
          <Button asChild variant="outline">
            <Link href="/habits">Log habits</Link>
          </Button>
        }
      />
      <PageBody>
        <Stack gap="4">
          <HStack asChild gap="2" wrap="wrap" id="overview">
            <nav aria-label="Dashboard sections">
              {sectionLinks.map(({ href, icon: Icon, title }) => (
                <Button asChild key={href} size="sm" variant="outline">
                  <a href={href}>
                    <Icon />
                    {title}
                  </a>
                </Button>
              ))}
            </nav>
          </HStack>

          <Grid
            as="section"
            alignItems="start"
            gap="4"
            templateColumns={{ base: "minmax(0, 1fr)", lg: "repeat(12, minmax(0, 1fr))" }}
          >
            <Flex
              direction="column"
              gap="4"
              display={{ base: "contents", lg: "flex" }}
              gridColumn={{ lg: "span 4" }}
              minW="0"
            >
              <Panel
                id="focus"
                order={1}
                scrollMarginTop="6"
                overflow="hidden"
                title="Current focus"
                description={
                  <Text fontFamily="mono" fontVariantNumeric="tabular-nums">
                    {currentMove ? getMoveWindowLabel(currentMove) : "No session"}
                  </Text>
                }
                action={<AdjustButton onClick={() => setIsAdjustOpen(true)} />}
              >
                {currentMove ? (
                  <Stack gap="3">
                    <Box rounded="l2" bg="bg.muted" p="4">
                      <Flex justify="space-between" align="start" gap="4">
                        <Box minW="0">
                          <Text fontWeight="semibold" truncate>
                            {currentMove.title}
                          </Text>
                          <Text mt="1" textStyle="sm" color="fg.muted" truncate>
                            {currentMove.detail ?? currentMove.mode}
                          </Text>
                        </Box>
                        <Badge variant="outline">
                          {formatMoveKindShort(currentMove.kind)}
                        </Badge>
                      </Flex>

                      <Flex
                        mt="8"
                        direction={{ base: "column", sm: "row" }}
                        gap="3"
                        align={{ base: "start", sm: "end" }}
                        justify="space-between"
                      >
                        <Text
                          fontFamily="mono"
                          fontSize={{ base: "6xl", sm: "7xl" }}
                          fontWeight="semibold"
                          lineHeight="1"
                          fontVariantNumeric="tabular-nums"
                        >
                          {getTimerLabel(currentMove, timerStatus, timer)}
                        </Text>
                        <Badge variant="outline">
                          {getTimerStateLabel(timer, timerStatus)}
                        </Badge>
                      </Flex>

                      <Progress.Root
                        aria-label="Current session progress"
                        mt="4"
                        size="sm"
                        value={Math.min(
                          100,
                          timerStatus?.progressPercent ||
                            (currentMove.actualMinutes ? 100 : 0),
                        )}
                      >
                        <Progress.Track>
                          <Progress.Range />
                        </Progress.Track>
                      </Progress.Root>
                    </Box>

                    {visiblePlan.needsReview ? (
                      <Alert.Root status="warning" size="sm">
                        <Alert.Indicator />
                        <Alert.Content>
                          <Alert.Description>Plan needs review</Alert.Description>
                        </Alert.Content>
                      </Alert.Root>
                    ) : null}

                    <Grid templateColumns="repeat(2, minmax(0, 1fr))" gap="2">
                      <SessionPrimaryButton
                        isComplete={isTimerComplete}
                        onPause={pauseCurrentMove}
                        onResume={resumeCurrentMove}
                        onStart={startCurrentMove}
                        timer={timer}
                      />
                      <Button onClick={() => finishCurrent(false)} variant="outline">
                        <CheckIcon />
                        Done
                      </Button>
                      <Button onClick={extendCurrent} variant="outline">
                        <PlusIcon />5
                      </Button>
                      {isTimerComplete ? (
                        <Button onClick={() => finishCurrent(true)}>
                          <PlayIcon />
                          Start next
                        </Button>
                      ) : timer.status === "idle" ? (
                        <Button onClick={restartCurrentMove} variant="outline">
                          <RotateCcwIcon />
                          Restart
                        </Button>
                      ) : null}
                    </Grid>
                  </Stack>
                ) : null}
              </Panel>

              <Panel
                id="queue"
                order={3}
                scrollMarginTop="6"
                overflow="hidden"
                title="Move queue"
                description="Next blocks"
                action={
                  <HStack gap="2">
                    <Badge variant="outline" fontFamily="mono" fontVariantNumeric="tabular-nums">
                      {workday.label}
                    </Badge>
                    <AdjustButton onClick={() => setIsAdjustOpen(true)} />
                  </HStack>
                }
              >
                <Stack gap="2">
                  <DndContext
                    id="move-queue-dnd-instructions"
                    collisionDetection={closestCenter}
                    modifiers={[restrictToVerticalAxis]}
                    onDragEnd={handleFutureMoveDragEnd}
                    sensors={dragSensors}
                  >
                    <SortableContext
                      items={futureMoves.map((move) => move.id)}
                      strategy={verticalListSortingStrategy}
                    >
                      {futureMoves.map((move) => (
                        <SortableMoveQueueItem key={move.id} move={move} />
                      ))}
                    </SortableContext>
                  </DndContext>
                </Stack>
              </Panel>
            </Flex>

            <Flex
              direction="column"
              gap="4"
              display={{ base: "contents", lg: "flex" }}
              gridColumn={{ lg: "span 8" }}
              minW="0"
            >
              <Panel
                id="signals"
                order={2}
                scrollMarginTop="6"
                overflow="hidden"
                title="Signal model"
                description="Sample day, 09:00–16:00. Latest point follows your signal inputs."
              >
                <Stack gap="4" minW="0">
                  <ProductivitySignalChart data={trendData} />

                  <Grid templateColumns={{ base: "minmax(0, 1fr)", sm: "repeat(3, minmax(0, 1fr))" }} gap="2">
                    <SignalField
                      description="self-rated"
                      label="Energy"
                      onChange={setEnergy}
                      value={energy}
                    />
                    <SignalField
                      description="right now"
                      label="Focus"
                      onChange={setFocus}
                      value={focus}
                    />
                    <SignalField
                      description={`${caffeineMg}mg`}
                      label="Caffeine"
                      max={250}
                      onChange={setCaffeineMg}
                      value={caffeineMg}
                    />
                  </Grid>
                </Stack>
              </Panel>

              <Panel
                id="readout"
                order={4}
                scrollMarginTop="6"
                overflow="hidden"
                title="Readout"
                description="Best window, next move, work mix"
              >
                <Stack gap="4">
                  <Grid templateColumns={{ base: "minmax(0, 1fr)", md: "repeat(2, minmax(0, 1fr))" }} gap="3">
                    <Box rounded="l2" borderWidth="1px" bg="bg.muted" p="4">
                      <HStack gap="2" textStyle="sm" fontWeight="medium">
                        <ActivityIcon size={16} />
                        Best window
                      </HStack>
                      <Text mt="2" textStyle="sm" color="fg.muted">
                        10:00-11:30 is strongest: high focus, rising energy,
                        moderate caffeine, food stability improving.
                      </Text>
                    </Box>
                    <Box rounded="l2" borderWidth="1px" bg="bg.muted" p="4">
                      <HStack gap="2" textStyle="sm" fontWeight="medium">
                        <CoffeeIcon size={16} />
                        Next move
                      </HStack>
                      <Text mt="2" textStyle="sm" color="fg.muted">
                        {futureMoves[0]
                          ? `${futureMoves[0].title} at ${futureMoves[0].scheduledTime}; ${futureMoves[0].durationMinutes}m.`
                          : "No future move queued."}
                      </Text>
                    </Box>
                  </Grid>
                  <Box borderTopWidth="1px" />
                  <Grid templateColumns={{ base: "repeat(2, minmax(0, 1fr))", sm: "repeat(4, minmax(0, 1fr))" }} gap="3">
                    {plannedBlocks.map((block) => (
                      <Box key={block.label} rounded="l2" borderWidth="1px" p="3">
                        <Stat label={block.label} value={formatDuration(block.minutes)} />
                      </Box>
                    ))}
                  </Grid>
                </Stack>
              </Panel>
            </Flex>
          </Grid>
        </Stack>
      </PageBody>
      <AdjustPlanDrawer
        onChange={setPlan}
        onOpenChange={setIsAdjustOpen}
        open={isAdjustOpen}
        plan={visiblePlan}
      />
    </>
  );
}

function AdjustButton({ onClick }: { onClick: () => void }) {
  return (
    <Button onClick={onClick} size="sm" variant="outline">
      <SlidersHorizontalIcon />
      Adjust
    </Button>
  );
}

function SessionPrimaryButton({
  isComplete,
  onPause,
  onResume,
  onStart,
  timer,
}: {
  isComplete: boolean;
  onPause: () => void;
  onResume: () => void;
  onStart: () => void;
  timer: TimerRuntime;
}) {
  if (isComplete) {
    return (
      <Button disabled variant="subtle">
        <CheckIcon />
        Complete
      </Button>
    );
  }

  if (timer.status === "running") {
    return (
      <Button onClick={onPause}>
        <PauseIcon />
        Pause
      </Button>
    );
  }

  if (timer.status === "paused") {
    return (
      <Button onClick={onResume}>
        <PlayIcon />
        Resume
      </Button>
    );
  }

  return (
    <Button onClick={onStart}>
      <PlayIcon />
      Start
    </Button>
  );
}

function SortableMoveQueueItem({ move }: { move: Move }) {
  const fixedInPlan = isMoveFixedInPlan(move);
  const {
    attributes,
    isDragging,
    listeners,
    setNodeRef,
    transform,
    transition,
  } = useSortable({
    disabled: fixedInPlan,
    id: move.id,
  });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <Grid
      ref={setNodeRef}
      style={style}
      templateColumns={{ base: "2rem minmax(0, 1fr)", sm: "2rem minmax(0, 1fr) auto" }}
      columnGap="3"
      rowGap="1"
      alignItems={{ sm: "center" }}
      rounded="l2"
      borderWidth="1px"
      bg={fixedInPlan ? "bg.muted" : "bg"}
      p="3"
      position={isDragging ? "relative" : undefined}
      zIndex={isDragging ? 10 : undefined}
      shadow={isDragging ? "lg" : undefined}
    >
      <IconButton
        aria-label={fixedInPlan ? "Move fixed" : "Drag move"}
        cursor={fixedInPlan ? undefined : "grab"}
        _active={fixedInPlan ? undefined : { cursor: "grabbing" }}
        disabled={fixedInPlan}
        size="xs"
        variant="ghost"
        {...attributes}
        {...listeners}
      >
        {fixedInPlan ? <LockIcon /> : <GripVerticalIcon />}
      </IconButton>
      <Box minW="0">
        <HStack gap="2" wrap="wrap">
          <Text fontWeight="semibold" textStyle={{ base: "md", sm: "sm" }} truncate>
            {move.title}
          </Text>
          <Badge variant="outline">{formatMoveKindShort(move.kind)}</Badge>
        </HStack>
        <Text mt="1" color="fg.muted" textStyle={{ base: "sm", sm: "xs" }} truncate>
          {move.detail ?? move.mode}
        </Text>
      </Box>
      <Text
        gridColumnStart={{ base: 2, sm: "auto" }}
        whiteSpace="nowrap"
        fontFamily="mono"
        color="fg.muted"
        textStyle={{ base: "sm", sm: "xs" }}
        fontVariantNumeric="tabular-nums"
      >
        {move.scheduledTime}-
        {addMinutesToTime(move.scheduledTime, move.durationMinutes)}
      </Text>
    </Grid>
  );
}

function AdjustPlanDrawer({
  onChange,
  onOpenChange,
  open,
  plan,
}: {
  onChange: (plan: PlanState) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  plan: PlanState;
}) {
  const futureMoves = plan.moves.slice(1);

  return (
    <Drawer.Root
      onOpenChange={(event) => onOpenChange(event.open)}
      open={open}
      placement="end"
      size="lg"
    >
      <Portal>
        <Drawer.Backdrop />
        <Drawer.Positioner>
          <Drawer.Content>
            <Drawer.Header>
              <Stack gap="1">
                <Drawer.Title>Adjust Plan</Drawer.Title>
                <Drawer.Description>Future moves only</Drawer.Description>
              </Stack>
            </Drawer.Header>
            <Drawer.Body>
              <Stack gap="4">
                {futureMoves.map((move) => (
                  <AdjustMoveRow
                    key={move.id}
                    move={move}
                    onChange={onChange}
                    plan={plan}
                  />
                ))}
              </Stack>
            </Drawer.Body>
            <Drawer.Footer>
              <Button
                onClick={() => onChange(refreshFuturePlan(plan))}
                variant="outline"
              >
                <RotateCcwIcon />
                Refresh plan
              </Button>
            </Drawer.Footer>
            <Drawer.CloseTrigger asChild position="absolute" top="3" insetEnd="3">
              <IconButton aria-label="Close" size="sm" variant="ghost">
                <XIcon />
              </IconButton>
            </Drawer.CloseTrigger>
          </Drawer.Content>
        </Drawer.Positioner>
      </Portal>
    </Drawer.Root>
  );
}

function AdjustMoveRow({
  move,
  onChange,
  plan,
}: {
  move: Move;
  onChange: (plan: PlanState) => void;
  plan: PlanState;
}) {
  const modeOptions =
    move.kind === "focus"
      ? focusModes
      : move.kind === "recovery"
        ? recoveryModes
        : ["External Meeting"];
  const fieldId = useId();

  return (
    <Stack gap="3" rounded="l2" borderWidth="1px" p="3">
      <Flex justify="space-between" align="start" gap="2" wrap="wrap">
        <Box minW="0">
          <Text fontWeight="medium" truncate>
            {move.title}
          </Text>
          <Text color="fg.muted" textStyle="sm" truncate>
            {move.detail ?? move.mode}
          </Text>
        </Box>
        <Button
          disabled={move.fixed}
          onClick={() =>
            onChange(
              updateFutureMove(plan, move.id, {
                pinned: !move.pinned,
                scheduledTime: move.scheduledTime,
              }),
            )
          }
          size="sm"
          variant={move.pinned ? "subtle" : "outline"}
        >
          {move.fixed || move.pinned ? <LockIcon /> : <GripVerticalIcon />}
          {move.fixed ? "Fixed" : move.pinned ? "Unpin" : "Pin"}
        </Button>
      </Flex>

      <Grid templateColumns={{ base: "repeat(2, minmax(0, 1fr))", md: "repeat(4, minmax(0, 1fr))" }} gap="3">
        <Field.Root>
          <Field.Label>Time</Field.Label>
          <Input
            onChange={(event) =>
              onChange(
                updateFutureMove(plan, move.id, {
                  pinned: move.kind === "meeting" ? false : true,
                  scheduledTime: event.currentTarget.value,
                }),
              )
            }
            type="time"
            value={move.scheduledTime}
          />
        </Field.Root>

        <FilterSelect
          fieldLabel="Type"
          highlightActive={false}
          id={`${fieldId}-type`}
          items={kindItems}
          onChange={(value) => {
            const kind = value as MoveKind;

            onChange(
              updateFutureMove(plan, move.id, {
                kind,
                mode: getDefaultModeForKind(kind),
              }),
            );
          }}
          size="md"
          value={move.kind}
        />

        <FilterSelect
          disabled={move.kind === "meeting"}
          fieldLabel="Mode"
          highlightActive={false}
          id={`${fieldId}-mode`}
          items={modeOptions.map((mode) => ({ value: mode, label: mode }))}
          onChange={(value) =>
            onChange(
              updateFutureMove(plan, move.id, {
                mode: value as MoveMode,
              }),
            )
          }
          size="md"
          value={move.mode}
        />

        <Field.Root>
          <Field.Label>Duration</Field.Label>
          <Input
            min={1}
            onChange={(event) =>
              onChange(
                updateFutureMove(plan, move.id, {
                  durationMinutes: event.currentTarget.valueAsNumber,
                }),
              )
            }
            step={5}
            type="number"
            value={move.durationMinutes}
          />
        </Field.Root>
      </Grid>
    </Stack>
  );
}

const kindItems = [
  { value: "focus", label: "Focus" },
  { value: "recovery", label: "Recovery" },
  { value: "meeting", label: "Meeting" },
];

function SignalField({
  description,
  label,
  max = 100,
  onChange,
  value,
}: {
  description: string;
  label: string;
  max?: number;
  onChange: (value: number) => void;
  value: number;
}) {
  return (
    <Slider.Root
      aria-label={[label]}
      getAriaValueText={(details) => `${details.value}, ${description}`}
      max={max}
      min={0}
      minW="0"
      onValueChange={(event) => onChange(event.value[0] ?? 0)}
      rounded="l2"
      borderWidth="1px"
      p="3"
      step={1}
      value={[value]}
    >
      <Stack gap="2">
        <Flex justify="space-between" align="center" gap="3">
          <Slider.Label>{label}</Slider.Label>
          <Text fontFamily="mono" textStyle="sm" fontVariantNumeric="tabular-nums">
            {value}
          </Text>
        </Flex>
        <Slider.Control>
          <Slider.Track>
            <Slider.Range />
          </Slider.Track>
          <Slider.Thumbs />
        </Slider.Control>
        <Text textStyle="xs" color="fg.muted">
          {description}
        </Text>
      </Stack>
    </Slider.Root>
  );
}

function getTimerStatus(
  move: Move,
  timer: TimerRuntime,
  nowMs: number,
): TimerStatus | null {
  const durationSeconds = move.durationMinutes * 60;

  if (timer.status === "idle") {
    return null;
  }

  const elapsedSeconds =
    timer.status === "paused"
      ? Math.max(0, timer.pausedElapsedSeconds ?? 0)
      : timer.startedAtMs
        ? Math.max(0, Math.floor((nowMs - timer.startedAtMs) / 1000))
        : 0;
  const remainingSeconds = Math.max(0, durationSeconds - elapsedSeconds);

  return {
    elapsedSeconds,
    overtimeSeconds: Math.max(0, elapsedSeconds - durationSeconds),
    progressPercent: Math.min(100, (elapsedSeconds / durationSeconds) * 100),
    remainingSeconds,
  };
}

function getTimerLabel(
  move: Move,
  timerStatus: TimerStatus | null,
  timer: TimerRuntime,
): string {
  if (timer.status === "idle") {
    return formatClock(move.durationMinutes * 60);
  }

  if (timerStatus?.overtimeSeconds && timerStatus.overtimeSeconds > 0) {
    return `+${formatClock(timerStatus.overtimeSeconds)}`;
  }

  return formatClock(
    timerStatus?.remainingSeconds ?? move.durationMinutes * 60,
  );
}

function getTimerStateLabel(
  timer: TimerRuntime,
  timerStatus: TimerStatus | null,
): string {
  if (timer.status === "running" && timerStatus?.remainingSeconds === 0) {
    return timerStatus?.overtimeSeconds ? "Overtime" : "Complete";
  }

  if (timer.status === "paused") {
    return "Paused";
  }

  if (timer.status === "running") {
    return "Running";
  }

  return "Ready";
}

function formatMoveKindShort(kind: MoveKind): string {
  switch (kind) {
    case "focus":
      return "Focus";
    case "meeting":
      return "Meet";
    case "recovery":
      return "Reset";
  }
}

function getMoveWindowLabel(move: Move): string {
  return `${move.scheduledTime}-${addMinutesToTime(
    move.scheduledTime,
    move.durationMinutes,
  )} - ${move.durationMinutes}m`;
}

function sumMoveMinutes(moves: Move[], kind: MoveKind): number {
  return moves
    .filter((move) => move.kind === kind)
    .reduce((total, move) => total + move.durationMinutes, 0);
}

function notifyTimerComplete(move: Move): Promise<void> {
  if (!("Notification" in window)) {
    return Promise.resolve();
  }

  if (Notification.permission === "granted") {
    new Notification("Focus Session complete", {
      body: move.title,
    });
    return Promise.resolve();
  }

  if (Notification.permission !== "default") {
    return Promise.resolve();
  }

  return Notification.requestPermission().then((permission) => {
    if (permission === "granted") {
      new Notification("Focus Session complete", {
        body: move.title,
      });
    }
  });
}
