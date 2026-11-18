"use client";

export type MoveKind = "focus" | "recovery" | "meeting";

export type FocusMode = "Deep Work Sprint" | "Admin Sweep" | "Review Pass";
export type RecoveryMode =
  | "Micro Reset"
  | "Walk Reset"
  | "Meal Reset"
  | "Stillness Reset";
export type MoveMode = FocusMode | RecoveryMode | "External Meeting";

export type Move = {
  adjusted?: boolean;
  actualMinutes?: number;
  detail?: string;
  durationMinutes: number;
  fixed?: boolean;
  id: string;
  kind: MoveKind;
  mode: MoveMode;
  pinned?: boolean;
  scheduledTime: string;
  title: string;
};

export type PlanState = {
  moves: Move[];
  needsReview: boolean;
  revision: number;
  updatedAt: string;
};

export type FutureMovePatch = Partial<
  Pick<
    Move,
    | "detail"
    | "durationMinutes"
    | "kind"
    | "mode"
    | "pinned"
    | "scheduledTime"
    | "title"
  >
>;

export const focusModes = [
  "Deep Work Sprint",
  "Admin Sweep",
  "Review Pass",
] as const satisfies readonly FocusMode[];

export const recoveryModes = [
  "Micro Reset",
  "Walk Reset",
  "Meal Reset",
  "Stillness Reset",
] as const satisfies readonly RecoveryMode[];

const WORKDAY_END_MINUTES = 17 * 60;

const initialMoves: Move[] = [
  {
    detail: "Proposal draft",
    durationMinutes: 25,
    id: "deep-work-sprint",
    kind: "focus",
    mode: "Deep Work Sprint",
    scheduledTime: "14:00",
    title: "Deep work sprint",
  },
  {
    detail: "Synced calendar",
    durationMinutes: 30,
    fixed: true,
    id: "team-sync",
    kind: "meeting",
    mode: "External Meeting",
    scheduledTime: "14:30",
    title: "Team sync",
  },
  {
    detail: "Recovery block",
    durationMinutes: 10,
    id: "walk-reset",
    kind: "recovery",
    mode: "Walk Reset",
    scheduledTime: "15:05",
    title: "Walk reset",
  },
  {
    detail: "Proposal polish",
    durationMinutes: 25,
    id: "proposal-polish",
    kind: "focus",
    mode: "Deep Work Sprint",
    scheduledTime: "15:20",
    title: "Proposal polish",
  },
  {
    detail: "Food and water before late work",
    durationMinutes: 15,
    id: "food-water-reset",
    kind: "recovery",
    mode: "Meal Reset",
    pinned: true,
    scheduledTime: "16:05",
    title: "Food/water reset",
  },
  {
    detail: "Close loops",
    durationMinutes: 30,
    id: "admin-close",
    kind: "focus",
    mode: "Admin Sweep",
    scheduledTime: "16:25",
    title: "Admin close",
  },
];

export function createInitialPlan(): PlanState {
  const [currentMove, ...futureMoves] = cloneInitialMoves();

  return commitPlan(
    createEmptyPlan(),
    currentMove,
    futureMoves,
    getMoveEndMinutes(currentMove),
  );
}

export function extendCurrentMove(
  plan: PlanState,
  minutes = 5,
  updatedAt = new Date(),
): PlanState {
  const [currentMove, ...futureMoves] = plan.moves;

  if (!currentMove) {
    return plan;
  }

  const nextCurrentMove: Move = {
    ...currentMove,
    adjusted: true,
    durationMinutes: normalizeDuration(currentMove.durationMinutes + minutes),
  };

  return commitPlan(
    plan,
    nextCurrentMove,
    futureMoves,
    getMoveEndMinutes(nextCurrentMove),
    updatedAt,
  );
}

export function finishCurrentMove(
  plan: PlanState,
  elapsedSeconds: number | null,
  completedAt = new Date(),
): PlanState {
  const [currentMove, ...futureMoves] = plan.moves;

  if (!currentMove) {
    return plan;
  }

  const actualMinutes =
    elapsedSeconds && elapsedSeconds > 0
      ? Math.max(1, Math.ceil(elapsedSeconds / 60))
      : currentMove.durationMinutes;
  const currentEndMinutes = timeToMinutes(currentMove.scheduledTime) + actualMinutes;
  const { moves: resyncedFutureMoves, needsReview } = resyncFutureMoves(
    futureMoves,
    currentEndMinutes,
  );
  const nextMoves =
    resyncedFutureMoves.length > 0
      ? resyncedFutureMoves
      : [createDayDoneMove(currentEndMinutes)];

  return {
    ...plan,
    moves: nextMoves,
    needsReview,
    revision: plan.revision + 1,
    updatedAt: completedAt.toISOString(),
  };
}

export function refreshFuturePlan(
  plan: PlanState,
  refreshedAt = new Date(),
): PlanState {
  const currentMove = plan.moves[0];

  if (!currentMove) {
    return plan;
  }

  const freshMoves = cloneInitialMoves();
  const currentInitialIndex = freshMoves.findIndex(
    (move) => move.id === currentMove.id,
  );
  const futureMoves =
    currentInitialIndex >= 0
      ? freshMoves.slice(currentInitialIndex + 1)
      : freshMoves.slice(1);

  return commitPlan(
    plan,
    currentMove,
    futureMoves,
    getMoveEndMinutes(currentMove),
    refreshedAt,
  );
}

export function reorderFutureMove(
  plan: PlanState,
  activeMoveId: string,
  overMoveId: string,
  reorderedAt = new Date(),
): PlanState {
  if (activeMoveId === overMoveId) {
    return plan;
  }

  const currentMove = plan.moves[0];
  const futureMoves = plan.moves.slice(1);
  const activeMove = futureMoves.find((move) => move.id === activeMoveId);
  const overMove = futureMoves.find((move) => move.id === overMoveId);

  if (
    !currentMove ||
    !activeMove ||
    !overMove ||
    isMoveFixedInPlan(activeMove) ||
    isMoveFixedInPlan(overMove)
  ) {
    return plan;
  }

  const flexibleMoves = futureMoves.filter((move) => !isMoveFixedInPlan(move));
  const oldFlexibleIndex = flexibleMoves.findIndex(
    (move) => move.id === activeMoveId,
  );
  const newFlexibleIndex = flexibleMoves.findIndex(
    (move) => move.id === overMoveId,
  );

  if (oldFlexibleIndex < 0 || newFlexibleIndex < 0) {
    return plan;
  }

  const reorderedFlexibleMoves = moveArrayItem(
    flexibleMoves,
    oldFlexibleIndex,
    newFlexibleIndex,
  );
  let flexibleIndex = 0;
  const reorderedFutureMoves = futureMoves.map((move) => {
    if (isMoveFixedInPlan(move)) {
      return move;
    }

    const reorderedMove = reorderedFlexibleMoves[flexibleIndex];
    flexibleIndex += 1;

    return reorderedMove;
  });

  return commitPlan(
    plan,
    currentMove,
    reorderedFutureMoves,
    getMoveEndMinutes(currentMove),
    reorderedAt,
  );
}

export function resyncCurrentPlan(
  plan: PlanState,
  currentDurationMinutes?: number,
  resyncedAt = new Date(),
): PlanState {
  const currentMove = plan.moves[0];

  if (!currentMove) {
    return plan;
  }

  const effectiveCurrentMove =
    typeof currentDurationMinutes === "number"
      ? {
          ...currentMove,
          actualMinutes: currentDurationMinutes,
        }
      : currentMove;
  const currentEndMinutes =
    timeToMinutes(currentMove.scheduledTime) +
    (currentDurationMinutes ?? currentMove.durationMinutes);

  return commitPlan(
    plan,
    effectiveCurrentMove,
    plan.moves.slice(1),
    currentEndMinutes,
    resyncedAt,
  );
}

export function previewCurrentPlan(
  plan: PlanState,
  currentDurationMinutes: number,
): PlanState {
  const currentMove = plan.moves[0];

  if (!currentMove) {
    return plan;
  }

  const currentEndMinutes =
    timeToMinutes(currentMove.scheduledTime) + currentDurationMinutes;
  const { moves, needsReview } = resyncFutureMoves(
    plan.moves.slice(1),
    currentEndMinutes,
  );

  return {
    ...plan,
    moves: [
      {
        ...currentMove,
        actualMinutes: currentDurationMinutes,
      },
      ...moves,
    ],
    needsReview,
  };
}

export function updateFutureMove(
  plan: PlanState,
  moveId: string,
  patch: FutureMovePatch,
  updatedAt = new Date(),
): PlanState {
  const currentMove = plan.moves[0];

  if (!currentMove) {
    return plan;
  }

  const futureMoves = plan.moves.slice(1).map((move) =>
    move.id === moveId ? normalizeAdjustedMove({ ...move, ...patch }) : move,
  );

  return commitPlan(
    plan,
    currentMove,
    futureMoves,
    getMoveEndMinutes(currentMove),
    updatedAt,
  );
}

export function getDefaultModeForKind(kind: MoveKind): MoveMode {
  switch (kind) {
    case "focus":
      return "Deep Work Sprint";
    case "meeting":
      return "External Meeting";
    case "recovery":
      return "Micro Reset";
  }
}

export function getMoveEndMinutes(move: Pick<Move, "durationMinutes" | "scheduledTime">): number {
  return timeToMinutes(move.scheduledTime) + move.durationMinutes;
}

export function isMoveFixedInPlan(
  move: Pick<Move, "fixed" | "pinned">,
): boolean {
  return Boolean(move.fixed || move.pinned);
}

export function formatMoveKind(kind: MoveKind): string {
  switch (kind) {
    case "focus":
      return "Focus Session";
    case "meeting":
      return "External Meeting";
    case "recovery":
      return "Recovery Mode";
  }
}

export function addMinutesToTime(time: string, minutes: number): string {
  return minutesToTime(timeToMinutes(time) + minutes);
}

export function minutesToTime(totalMinutes: number): string {
  const minutesInDay = 24 * 60;
  const normalizedMinutes =
    ((Math.round(totalMinutes) % minutesInDay) + minutesInDay) % minutesInDay;
  const hours = Math.floor(normalizedMinutes / 60);
  const minutes = normalizedMinutes % 60;

  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

export function timeToMinutes(time: string): number {
  const [hours = "0", minutes = "0"] = time.split(":");

  return Number(hours) * 60 + Number(minutes);
}

function commitPlan(
  plan: PlanState,
  currentMove: Move,
  futureMoves: Move[],
  currentEndMinutes: number,
  updatedAt = new Date(),
): PlanState {
  const { moves, needsReview } = resyncFutureMoves(
    futureMoves,
    currentEndMinutes,
  );

  return {
    ...plan,
    moves: [currentMove, ...moves],
    needsReview,
    revision: plan.revision + 1,
    updatedAt: updatedAt.toISOString(),
  };
}

function resyncFutureMoves(
  futureMoves: Move[],
  currentEndMinutes: number,
): { moves: Move[]; needsReview: boolean } {
  const protectedMoves = futureMoves
    .filter(isMoveFixedInPlan)
    .map(normalizeAdjustedMove)
    .sort(
      (first, second) =>
        timeToMinutes(first.scheduledTime) - timeToMinutes(second.scheduledTime),
    );
  const flexibleMoves = futureMoves
    .filter((move) => !isMoveFixedInPlan(move))
    .map(normalizeAdjustedMove);
  const scheduledMoves: Move[] = [];
  let flexibleIndex = 0;
  let cursorMinutes = currentEndMinutes;
  let needsReview = false;

  for (const protectedMove of protectedMoves) {
    const protectedStartMinutes = timeToMinutes(protectedMove.scheduledTime);

    while (flexibleIndex < flexibleMoves.length) {
      const flexibleMove = flexibleMoves[flexibleIndex];

      if (
        cursorMinutes + flexibleMove.durationMinutes >
        protectedStartMinutes
      ) {
        break;
      }

      scheduledMoves.push({
        ...flexibleMove,
        scheduledTime: minutesToTime(cursorMinutes),
      });
      cursorMinutes += flexibleMove.durationMinutes;
      flexibleIndex += 1;
    }

    if (cursorMinutes > protectedStartMinutes) {
      needsReview = true;
    }

    scheduledMoves.push(protectedMove);
    cursorMinutes = Math.max(
      cursorMinutes,
      protectedStartMinutes + protectedMove.durationMinutes,
    );
  }

  while (flexibleIndex < flexibleMoves.length) {
    const flexibleMove = flexibleMoves[flexibleIndex];
    scheduledMoves.push({
      ...flexibleMove,
      scheduledTime: minutesToTime(cursorMinutes),
    });
    cursorMinutes += flexibleMove.durationMinutes;
    flexibleIndex += 1;
  }

  return {
    moves: scheduledMoves.sort(
      (first, second) =>
        timeToMinutes(first.scheduledTime) - timeToMinutes(second.scheduledTime),
    ),
    needsReview: needsReview || cursorMinutes > WORKDAY_END_MINUTES,
  };
}

function normalizeAdjustedMove(move: Move): Move {
  const kind = move.kind;
  const mode = normalizeMode(kind, move.mode);
  const scheduledTime = /^\d{2}:\d{2}$/.test(move.scheduledTime)
    ? move.scheduledTime
    : "09:00";

  return {
    ...move,
    adjusted: move.adjusted ?? true,
    durationMinutes: normalizeDuration(move.durationMinutes),
    fixed: kind === "meeting" ? true : false,
    mode,
    pinned: kind === "meeting" ? false : move.pinned,
    scheduledTime,
    title: normalizeTitle(kind, move.title),
  };
}

function normalizeMode(kind: MoveKind, mode: MoveMode): MoveMode {
  if (kind === "meeting") {
    return "External Meeting";
  }

  if (kind === "focus") {
    return focusModes.includes(mode as FocusMode) ? mode : "Deep Work Sprint";
  }

  return recoveryModes.includes(mode as RecoveryMode) ? mode : "Micro Reset";
}

function normalizeTitle(kind: MoveKind, title: string): string {
  if (title.trim()) {
    return title;
  }

  return formatMoveKind(kind);
}

function normalizeDuration(durationMinutes: number): number {
  return Number.isFinite(durationMinutes)
    ? Math.max(1, Math.round(durationMinutes))
    : 1;
}

function createDayDoneMove(startMinutes: number): Move {
  return {
    detail: "No planned moves remain",
    durationMinutes: 1,
    fixed: true,
    id: "day-closed",
    kind: "recovery",
    mode: "Stillness Reset",
    scheduledTime: minutesToTime(startMinutes),
    title: "Day closed",
  };
}

function createEmptyPlan(): PlanState {
  return {
    moves: [],
    needsReview: false,
    revision: 0,
    updatedAt: new Date().toISOString(),
  };
}

function cloneInitialMoves(): Move[] {
  return initialMoves.map((move) => ({ ...move }));
}

function moveArrayItem<T>(items: T[], fromIndex: number, toIndex: number): T[] {
  const nextItems = [...items];
  const [item] = nextItems.splice(fromIndex, 1);

  nextItems.splice(toIndex, 0, item);

  return nextItems;
}
