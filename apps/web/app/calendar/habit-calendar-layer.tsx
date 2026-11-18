"use client";
import NextLink from "next/link";
import { CloseButton, Dialog, Link, Portal } from "@chakra-ui/react";
import { useEffect, useMemo, useState } from "react";
import { useHabitLook } from "@/lib/habit-look";
import { Habits } from "../habits/habits";
import { habitCalendarSource, type HabitItem } from "./habit-calendar-source";

export function HabitCalendarLayer({
  dates,
  minuteHeight,
  gutter,
  onDatesChange,
}: {
  dates: string[];
  minuteHeight: number;
  gutter: number;
  onDatesChange: (dates: string[]) => void;
}) {
  const from = dates[0],
    to = dates[dates.length - 1];
  const [blocks, setBlocks] = useState<HabitItem[]>([]);
  const [status, setStatus] = useState("Loading habit calendar…");
  const { look } = useHabitLook();
  const [selected, setSelected] = useState<HabitItem | null>(null);
  const source = useMemo(() => habitCalendarSource(setSelected), [from, to]);
  useEffect(() => {
    let disposed = false;
    let pending = false;
    setBlocks([]);
    setStatus("Loading habit calendar…");
    const load = async () => {
      if (pending) return;
      pending = true;
      try {
        const next = await source.load({ from, to });
        if (!disposed) {
          setBlocks(next);
          setStatus(source.warning());
        }
      } catch {
        if (!disposed) setStatus("Habit calendar unavailable. Retrying…");
      } finally {
        pending = false;
      }
    };
    void load();
    const unsubscribe = source.subscribe(() => void load());
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [from, to, source]);
  useEffect(() => {
    onDatesChange([...new Set(blocks.map(block => block.date))]);
  }, [blocks, onDatesChange]);
  const layouts = dates.flatMap((date) => {
    const list = blocks
      .filter((block) => block.date === date)
      .map((block) => {
        const [hour, minute] = block.anchor.split(":").map(Number);
        const start = hour * 60 + minute;
        return {
          block,
          start,
          end: start + Math.max(block.durationMinutes, 24 / minuteHeight),
          lane: 0,
          lanes: 1,
        };
      })
      .sort(
        (a, b) =>
          a.start - b.start || a.block.stackId.localeCompare(b.block.stackId),
      );
    for (let i = 0; i < list.length;) {
      let j = i + 1,
        end = list[i].end;
      while (j < list.length && list[j].start < end) {
        end = Math.max(end, list[j].end);
        j++;
      }
      const laneEnds: number[] = [];
      for (let k = i; k < j; k++) {
        let lane = laneEnds.findIndex((value) => value <= list[k].start);
        if (lane < 0) lane = laneEnds.length;
        list[k].lane = lane;
        laneEnds[lane] = list[k].end;
      }
      for (let k = i; k < j; k++) list[k].lanes = laneEnds.length;
      i = j;
    }
    return list;
  });
  return (
    <>
      {status && (
        <span
          role="status"
          style={{
            position: "sticky",
            top: 80,
            left: gutter,
            zIndex: 4,
            background: "var(--chakra-colors-bg)",
          }}
        >
          {status}
        </span>
      )}
      {layouts.map(({ block, lane, lanes }) => {
        const column = dates.indexOf(block.date);
        if (column < 0) return null;
        return (
          source.render(block, {
            column,
            columnCount: dates.length,
            lane,
            lanes,
            minuteHeight,
            gutter,
            look,
            ...source.interact(block),
          })
        );
      })}
      <Dialog.Root
        open={!!selected}
        scrollBehavior="inside"
        size="xl"
        onOpenChange={({ open }) => {
          if (!open) setSelected(null);
        }}
      >
        {selected && (
          <Portal>
            <Dialog.Backdrop />
            <Dialog.Positioner>
              <Dialog.Content
                maxW="3xl"
                maxH="90dvh"
                aria-describedby={undefined}
                onDoubleClick={(e) => e.stopPropagation()}
                onContextMenu={(e) => e.stopPropagation()}
              >
                <Dialog.Header>
                  <Dialog.Title>{selected.name} quick-log</Dialog.Title>
                </Dialog.Header>
                <Dialog.CloseTrigger asChild><CloseButton size="sm" /></Dialog.CloseTrigger>
                <Dialog.Body>
                  {process.env.NODE_ENV !== "production" && process.env.NEXT_PUBLIC_QUANTSELF_HABITS_FIXTURE === "1" && (
                    <Link asChild w="fit-content" textStyle="sm" textDecoration="underline" textUnderlineOffset="4px">
                      <NextLink href={{
                        pathname: "/habits",
                        query: { variant: "A", date: selected.date, stack: selected.stackId },
                      }}>Compare quick-log designs</NextLink>
                    </Link>
                  )}
                  <Habits
                    key={`${selected.date}:${selected.stackId}`}
                    initialDate={selected.date}
                    stackId={selected.stackId}
                  />
                </Dialog.Body>
              </Dialog.Content>
            </Dialog.Positioner>
          </Portal>
        )}
      </Dialog.Root>
    </>
  );
}
