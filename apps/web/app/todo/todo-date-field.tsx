"use client";

import { useEffect, useRef, useState } from "react";
import { Button, DatePicker, Flex, Input, Portal } from "@chakra-ui/react";
import { parseDate } from "@internationalized/date";
import { CalendarIcon } from "lucide-react";
import { useNestedOverlayRegistration } from "@/components/shared/nested-overlay-guard";
import styles from "./todo-detail.module.css";

const timeZone = "America/Halifax";
const dateLabel = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric", timeZone });
const positioning = { placement: "bottom-end", gutter: 4 } as const;

function calendarDate(value: string) {
  if (!value) return undefined;
  try {
    return parseDate(value.slice(0, 10));
  } catch {
    return undefined;
  }
}

export function TodoDateField({ id, label, value, onChange, disabled, withTime = false }: {
  id: string; label: string; value: string; onChange(value: string): void; disabled?: boolean; withTime?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const visible = open && !disabled;
  const trigger = useRef<HTMLButtonElement>(null);
  const calendar = useRef<HTMLDivElement>(null);
  function changeOpen(next: boolean) {
    if (!next && calendar.current?.contains(calendar.current.ownerDocument.activeElement)) {
      trigger.current?.focus({ preventScroll: true });
    }
    setOpen(next && !disabled);
  }
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  useNestedOverlayRegistration(visible);
  // Date values are Halifax wall-clock strings. Only the label needs a Date.
  const selected = calendarDate(value);
  const time = value.slice(11);
  return <div className={styles.dateField}>
    <DatePicker.Root ids={{ trigger: id }} open={visible} onOpenChange={({ open }) => changeOpen(open)}
      size="xs" value={selected ? [selected] : []} disabled={disabled} timeZone={timeZone}
      maxView="day" outsideDaySelectable positioning={positioning} lazyMount unmountOnExit
      onValueChange={({ value: dates }) => {
        if (disabled) return;
        const date = dates[0];
        if (date) onChange(date.toString() + (withTime ? `T${time || "09:00"}` : ""));
      }}>
      <DatePicker.Control>
        <DatePicker.Trigger unstyled asChild aria-label={`${label} date`}>
          <Button ref={trigger} type="button" variant="ghost" size="sm" className={styles.calendarTrigger}>
            {selected ? dateLabel.format(selected.toDate(timeZone)) : "Set date"}
            <CalendarIcon aria-hidden="true" />
          </Button>
        </DatePicker.Trigger>
      </DatePicker.Control>
      {(!disabled && open) && <Portal>
        <DatePicker.Positioner>
          <DatePicker.Content ref={calendar} aria-label={`${label} calendar`} minW="0" w="280px" maxW="calc(100vw - 16px)" gap="1" p="2">
            <DatePicker.View view="day" gap="1" css={{ "--table-cell-size": "min(36px, calc((100vw - 32px) / 7))" }}>
              <DatePicker.ViewControl>
                <DatePicker.PrevTrigger />
                <DatePicker.RangeText />
                <DatePicker.NextTrigger />
              </DatePicker.ViewControl>
              <DatePicker.DayTable width="full" />
            </DatePicker.View>
            <Flex justify="end">
              <Button type="button" variant="ghost" size="xs" disabled={!value} onClick={() => {
                if (disabled) return;
                onChange("");
                changeOpen(false);
              }}>Clear date</Button>
            </Flex>
          </DatePicker.Content>
        </DatePicker.Positioner>
      </Portal>}
    </DatePicker.Root>
    {withTime && <Input type="time" aria-label={`${label} time`} disabled={disabled || !selected} value={time} onChange={event => onChange(`${value.slice(0, 10)}T${event.target.value || "00:00"}`)} />}
  </div>;
}
