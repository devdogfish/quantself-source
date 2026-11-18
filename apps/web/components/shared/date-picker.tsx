"use client";

// Chakra DatePicker for plain calendar dates. `value` and `onChange` use YYYY-MM-DD wall-clock strings (no time zone
// conversion, so a date never shifts); parseDate/toString from @internationalized/date work on the date fields only.
import { DatePicker as ChakraDatePicker, IconButton, Portal } from "@chakra-ui/react";
import { parseDate } from "@internationalized/date";
import { CalendarIcon } from "lucide-react";

export function DatePicker({ value, onChange, id, label = "Date", size = "sm", zIndex = 1600 }: {
  value: string;
  onChange: (value: string) => void;
  id?: string;
  /** aria-label for the text input */
  label?: string;
  size?: "xs" | "sm" | "md";
  /** Calendar stacking; the default sits above Chakra popovers and dialogs. */
  zIndex?: number;
}) {
  return (
    <ChakraDatePicker.Root size={size} value={[parseDate(value)]} closeOnSelect lazyMount unmountOnExit positioning={{ sameWidth: false }}
      onValueChange={(e) => { const next = e.value[0]; if (next) onChange(next.toString()); }}>
      <ChakraDatePicker.Control>
        <ChakraDatePicker.Input id={id} aria-label={label} />
        <ChakraDatePicker.IndicatorGroup>
          <ChakraDatePicker.Trigger asChild><IconButton aria-label="Open calendar" size="2xs" variant="ghost"><CalendarIcon /></IconButton></ChakraDatePicker.Trigger>
        </ChakraDatePicker.IndicatorGroup>
      </ChakraDatePicker.Control>
      <Portal>
        <ChakraDatePicker.Positioner zIndex={zIndex}>
          <ChakraDatePicker.Content>
            <ChakraDatePicker.View view="day"><ChakraDatePicker.Header /><ChakraDatePicker.DayTable /></ChakraDatePicker.View>
            <ChakraDatePicker.View view="month"><ChakraDatePicker.Header /><ChakraDatePicker.MonthTable /></ChakraDatePicker.View>
            <ChakraDatePicker.View view="year"><ChakraDatePicker.Header /><ChakraDatePicker.YearTable /></ChakraDatePicker.View>
          </ChakraDatePicker.Content>
        </ChakraDatePicker.Positioner>
      </Portal>
    </ChakraDatePicker.Root>
  );
}
