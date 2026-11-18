"use client";
import { Field, Input } from "@chakra-ui/react";

import { useEffect, useRef, useState } from "react";
import { habitStore } from "./habits-api";
import type { Occurrence } from "./habit-store";

export function HabitNote({
  occurrence,
  disabled,
}: {
  occurrence: Occurrence;
  disabled: boolean;
}) {
  const note = habitStore.row(occurrence).note;
  const [draft, setDraft] = useState(note);
  const [editing, setEditing] = useState(false);
  const cancel = useRef(false);
  useEffect(() => {
    if (!editing) setDraft(note);
  }, [note, editing]);

  return (
    <Field.Root mt="3" disabled={disabled}>
      <Field.Label>Note</Field.Label>
      <Input
        marginTop="1"
        display="block"
        minHeight="10"
        width="full"
        borderRadius="md"
        borderWidth="1px"
        background="transparent"
        paddingInline="3"
        css={{
          _focusVisible: {
            outlineWidth: "2px",
            outlineColor: "colorPalette.focusRing",
          },
        }}
        aria-label={`${occurrence.habitId} note`}
        maxLength={4000}
        value={draft}
        disabled={disabled}
        onFocus={() => {
          cancel.current = false;
          setEditing(true);
        }}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (!cancel.current) {
            const current = habitStore.row(occurrence);
            habitStore.edit(occurrence, {
              status: current.status,
              note: draft,
            });
          }
          cancel.current = false;
          setEditing(false);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            cancel.current = true;
            setDraft(note);
            event.currentTarget.blur();
          } else if (event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.blur();
          }
        }}
      />
      <Field.HelperText mt="1" textStyle="xs" color="fg.muted">
        Saves when you leave the field. Enter to save, Escape to cancel.
      </Field.HelperText>
    </Field.Root>
  );
}
