"use client";

import { useState } from "react";
import {
  Box,
  Button,
  Field,
  Flex,
  Icon,
  Input,
  Popover,
  Portal,
  RadioGroup,
} from "@chakra-ui/react";
import { Check, ChevronDown } from "lucide-react";
import { useNestedOverlayRegistration } from "@/components/shared/nested-overlay-guard";
import { optimisticSetting, useNotificationSetting } from "./client";

type AlertSetting = { minutes: number | null; morning: string | null };
const resources = new Map<
  number,
  ReturnType<typeof optimisticSetting<AlertSetting>>
>();
const presets = [5, 10, 15, 30, 60, 120, 1440, 2880];
function duration(minutes: number) {
  if (minutes % 1440 === 0)
    return `${minutes / 1440} ${minutes === 1440 ? "day" : "days"}`;
  if (minutes % 60 === 0)
    return `${minutes / 60} ${minutes === 60 ? "hour" : "hours"}`;
  return `${minutes} minutes`;
}

export function TaskAlert({
  number,
  beforeMinutes = 0,
  dateOnly = false,
}: {
  number: number;
  beforeMinutes?: number;
  dateOnly?: boolean;
}) {
  if (!resources.has(number))
    resources.set(number, optimisticSetting<AlertSetting>(`tasks/${number}`));
  const resource = resources.get(number)!;
  const state = useNotificationSetting(resource);
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState(false);
  useNestedOverlayRegistration(open);
  const value = state.value;
  const suffix = beforeMinutes > 0 ? " before prep/travel" : " before";
  function alertLabel(minutes: number | null) {
    if (minutes === null) return "None";
    if (dateOnly) {
      return `On due date (${value?.morning ?? "default morning"})`;
    }
    return `${duration(minutes)}${suffix}`;
  }
  const summary = value ? alertLabel(value.minutes) : "Loading…";
  function select(minutes: number | null) {
    resource.set({ ...value!, minutes });
    setOpen(false);
  }
  return (
    <Field.Root>
      <Field.Label htmlFor={`alert-${number}`}>Alert</Field.Label>
      <Popover.Root
        lazyMount
        unmountOnExit
        open={open}
        positioning={{ placement: "bottom-start" }}
        onOpenChange={({ open: next }) => {
          setOpen(next);
          if (!next) setCustom(false);
        }}
      >
        <Popover.Trigger asChild>
          <Button
            variant="ghost"
            type="button"
            id={`alert-${number}`}
            disabled={!value}
            minH="30px"
            h="auto"
            minW="0"
            justifyContent="space-between"
            gap="2"
            px="1.5"
            textAlign="left"
            fontSize="xs"
          >
            <span>{summary}</span>
            <Icon
              as={ChevronDown}
              boxSize="3"
              flexShrink="0"
              color="fg.muted"
            />
          </Button>
        </Popover.Trigger>
        <Portal>
          <Popover.Positioner>
            <Popover.Content
              aria-label="Task alert"
              w="72"
              maxW="calc(100vw - 2rem)"
              p="4"
            >
              {custom ? (
                <>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    justifyContent="start"
                    onClick={() => setCustom(false)}
                  >
                    ‹ Alert presets
                  </Button>
                  {!dateOnly && (
                    <Field.Root>
                      <Field.Label htmlFor={`alert-minutes-${number}`}>
                        Minutes before{" "}
                        {beforeMinutes > 0
                          ? "prep/travel"
                          : "start or deadline"}
                      </Field.Label>
                      <Input
                        id={`alert-minutes-${number}`}
                        type="number"
                        min={1}
                        max={10080}
                        value={value?.minutes ?? 10}
                        onChange={(event) => {
                          const minutes = event.target.valueAsNumber;
                          if (
                            Number.isInteger(minutes) &&
                            minutes >= 1 &&
                            minutes <= 10080
                          )
                            resource.set({ ...value!, minutes });
                        }}
                      />
                    </Field.Root>
                  )}
                  <Field.Root>
                    <Field.Label htmlFor={`alert-morning-${number}`}>
                      Date-only deadline
                    </Field.Label>
                    <Input
                      id={`alert-morning-${number}`}
                      type="time"
                      value={value?.morning ?? ""}
                      onChange={(event) =>
                        resource.set({
                          ...value!,
                          morning: event.target.value || null,
                        })
                      }
                    />
                    <Field.HelperText>
                      Leave empty to use the morning time in Settings.
                    </Field.HelperText>
                  </Field.Root>
                </>
              ) : (
                <>
                  <RadioGroup.Root
                    aria-label="Alert timing"
                    value={
                      value?.minutes === null ? "none" : String(value?.minutes)
                    }
                    onValueChange={({ value: next }) =>
                      select(next === "none" ? null : Number(next))
                    }
                    display="flex"
                    flexDirection="column"
                    gap="0"
                  >
                    {[
                      null,
                      ...(dateOnly ? [value?.minutes ?? 10] : presets),
                    ].map((minutes) => (
                      <RadioGroup.Item
                        value={minutes === null ? "none" : String(minutes)}
                        key={minutes ?? "none"}
                        gap="2"
                        rounded="sm"
                        px="2"
                        py="1.5"
                        textAlign="left"
                        fontSize="sm"
                        _hover={{ bg: "bg.muted" }}
                        _focusWithin={{
                          bg: "bg.muted",
                          outline: "2px solid",
                          outlineColor: "colorPalette.focusRing",
                        }}
                      >
                        <RadioGroup.ItemHiddenInput />
                        <Icon
                          as={Check}
                          aria-hidden
                          boxSize="4"
                          flexShrink="0"
                          visibility={
                            value?.minutes === minutes ? "visible" : "hidden"
                          }
                        />
                        <RadioGroup.ItemText>
                          {alertLabel(minutes)}
                        </RadioGroup.ItemText>
                      </RadioGroup.Item>
                    ))}
                  </RadioGroup.Root>
                  <Box borderTopWidth="1px" pt="1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      w="full"
                      justifyContent="start"
                      pl="8"
                      onClick={() => {
                        if (value?.minutes === null)
                          resource.set({ ...value, minutes: 10 });
                        setCustom(true);
                      }}
                    >
                      Custom…
                    </Button>
                  </Box>
                </>
              )}
            </Popover.Content>
          </Popover.Positioner>
        </Portal>
      </Popover.Root>
      {(state.pending ||
        state.error ||
        state.undo.length > 0 ||
        state.redo.length > 0) && (
        <Flex
          gridColumnStart="2"
          wrap="wrap"
          align="center"
          gap="1"
          fontSize="xs"
          color="fg.muted"
        >
          {state.pending && <span role="status">Saving…</span>}
          {state.error && (
            <span role="alert">
              {state.error}{" "}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => resource.retry()}
              >
                Retry
              </Button>
            </span>
          )}
          {state.undo.length > 0 && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => resource.undo()}
            >
              Undo
            </Button>
          )}
          {state.redo.length > 0 && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => resource.redo()}
            >
              Redo
            </Button>
          )}
        </Flex>
      )}
    </Field.Root>
  );
}
