import { DEFAULT_HABIT_LOOK, type HabitLook } from "@/lib/habit-look";
import { RepeatIcon } from "lucide-react";
import type { operations } from "@/lib/generated/quantself-api-schema";
import { habitClient } from "../habits/habits-api";
import type { CalendarRange, CalendarSource } from "./calendar-source";

type Calendar = operations["getHabitCalendar"]["responses"][200]["content"]["application/json"];
export type HabitItem = Calendar["blocks"][number];
type HabitBlock = {
  column: number;
  columnCount: number;
  lane: number;
  lanes: number;
  minuteHeight: number;
  gutter: number;
  onOpen?: () => void;
  look?: HabitLook;
};

export function habitCalendarSource(open: (item: HabitItem) => void) {
  let warning = "";
  return {
    async load({ from, to }: CalendarRange) {
      const { data, error } = await habitClient.GET("/api/v1/habits/calendar", {
        params: { query: { from, to } },
        cache: "no-store",
      });
      warning = data?.error ?? (data ? "" : (error?.message ?? "Habit calendar unavailable."));
      return data?.blocks ?? [];
    },
    warning: () => warning,
    subscribe(onChange: () => void) {
      const timer = setInterval(onChange, 60000);
      return () => clearInterval(timer);
    },
    interact: (item: HabitItem) => ({ onOpen: () => open(item) }),
    render(block: HabitItem, { column, columnCount, lane, lanes, minuteHeight, gutter, onOpen, look = DEFAULT_HABIT_LOOK }: HabitBlock) {
      const widthFraction = 0.28 / (columnCount * lanes);
      const [hour, minute] = block.anchor.split(":").map(Number);
      const height = Math.max(
        24,
        Math.min(block.durationMinutes, 1440 - hour * 60 - minute) * minuteHeight,
      );
      const fill = "var(--chakra-colors-purple-subtle)";
      const outlined = look === "outlined" || look === "outlined-glyph";
      const glyph = look === "glyph" || look === "outlined-glyph";
      return (
          <button
            key={`${block.date}:${block.stackId}`}
            type="button"
            draggable={false}
            aria-label={`${block.name} · Habit routine · ${block.anchor}`}
            title={`${block.name} · ${block.anchor} · ${block.durationMinutes} min`}
            onDoubleClick={(e) => e.stopPropagation()}
            onContextMenu={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onOpen?.();
            }}
            style={{
              position: "absolute",
              zIndex: 3,
              top: (hour * 60 + minute) * minuteHeight,
              height,
              left: `calc(${gutter}px + (100% - ${gutter}px) * ${(column + 0.72 + (0.28 * lane) / lanes) / columnCount} + 2px)`,
              width: `calc(${100 * widthFraction}% - ${gutter * widthFraction + 5}px)`,
              border: 0,
              borderRadius: 3,
              color: "var(--chakra-colors-purple-fg)",
              textAlign: "left",
              padding: "2px 12px",
              overflow: "hidden",
              display: "flex",
              flexDirection: "column",
              justifyContent: height < 40 ? "center" : "flex-start",
              paddingTop: height < 40 ? 0 : 7,
              cursor: "pointer",
              ...(outlined
                ? { background: "transparent", boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--chakra-colors-purple-solid) 65%, transparent)" }
                : look === "hatched"
                  ? { background: `repeating-linear-gradient(135deg, ${fill} 0 5px, color-mix(in srgb, ${fill} 55%, var(--chakra-colors-bg)) 5px 10px)` }
                  : { background: fill }),
              ...(look === "ring" ? { paddingLeft: 30 } : {}),
            }}
          >
            {look === "ring" ? (
              <i aria-hidden="true" style={{ position: "absolute", left: 9, top: height < 40 ? "calc(50% - 6px)" : 9, width: 12, height: 12, boxSizing: "border-box", borderRadius: "50%", border: "1.6px solid var(--chakra-colors-purple-solid)" }} />
            ) : (
              <i aria-hidden="true" style={{ position: "absolute", left: 3, top: 3, bottom: 3, width: 3, borderRadius: 2, background: "var(--chakra-colors-purple-solid)" }} />
            )}
            <span style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, minWidth: 0 }}>
              <strong style={{ fontSize: 13, lineHeight: "18px", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {block.name}
              </strong>
              <time style={{ display: "inline-flex", alignItems: "center", gap: 5, flexShrink: 0, fontSize: 11, lineHeight: "16px", fontVariantNumeric: "tabular-nums" }}>
                {glyph && <RepeatIcon size={11} aria-hidden="true" />}
                {block.anchor}
              </time>
            </span>
          </button>
      );
    },
  } satisfies CalendarSource<HabitItem, HabitBlock> & { warning(): string };
}
