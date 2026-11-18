"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Trash2Icon, ArrowLeftIcon, ArrowRightIcon, KeyboardIcon, PlusIcon, SlidersHorizontalIcon } from "lucide-react";
import { Box, Button, Field, Flex, Heading, HStack, IconButton, Popover, Portal, SegmentGroup, Stack } from "@chakra-ui/react";
import { Tooltip } from "@/components/chakra/tooltip";
import { DatePicker } from "@/components/shared/date-picker";
import { FilterSelect } from "@/components/shared/filter-select";

export type CalendarView = "calendar" | "week" | "month" | "year" | "list";
const views = [["calendar", "Day"], ["week", "Week"], ["month", "Month"], ["year", "Year"], ["list", "List"]] as const;
const viewItems = views.map(([value, label]) => ({ value, label }));

type CalendarTopBarProps = {
  categoryControl?: ReactNode;
  onOpenTrash?: () => void;
  date: string;
  view: CalendarView;
  todayInView: boolean;
  onPrevious: () => void;
  onNext: () => void;
  onToday: () => void;
  onDateChange: (date: string) => void;
  onViewChange?: (view: CalendarView) => void;
  onAddTask: () => void;
  readOnly?: boolean;
  onOpenShortcuts: () => void;
};

function ViewSelect({ view, onViewChange, id, fieldLabel, w }: Required<Pick<CalendarTopBarProps, "view" | "onViewChange">> & { id?: string; fieldLabel?: string; w?: string }) {
  return <FilterSelect size="sm" w={w} id={id} label="Calendar view" fieldLabel={fieldLabel} highlightActive={false} items={viewItems} value={view} onChange={(value) => onViewChange(value as CalendarView)} />;
}

const compactButton = { size: "sm", h: "8", minW: "8", px: "2.5", gap: "1.5", rounded: "lg" } as const;
const iconButton = { ...compactButton, w: "8", px: "0" } as const;

// One 56px row at every width (same height token as the app shell bar). Rules collapse by the workspace's container width.
const responsive = {
  "& .view-select, & .filters, & .short-title": { display: "none" },
  "& .date-navigation": { display: "grid", gridTemplateColumns: "minmax(0, max-content) 32px 32px 64px" },
  "& .page-title": { fontSize: "24px" },
  "& :is(.category, .view-select) [data-part='root']": { "--select-trigger-height": "32px" },
  "& :is(.category, .view-select) [data-part='trigger']": { rounded: "lg" },
  "& .category [data-part='trigger'] > svg": { display: "none" },
  "@container (max-width: 1199px)": {
    "& .view-tabs": { display: "none" },
    "& .view-select": { display: "block" },
    "& .add-task": { width: "8", paddingInline: "0", gap: "0" },
    "& .add-label": { display: "none" },
  },
  "@container (max-width: 939px)": {
    "& .view-select, & .tools": { display: "none" },
    "& .filters": { display: "block" },
    "& .category .category-label, & .category .category-chevron": { display: "none" },
    "& .category [data-part='root']": { width: "auto" },
    "& .category [data-part='trigger']": { width: "8", paddingInline: "0", justifyContent: "center", gap: "0" },
    "& .category [data-part='trigger'] > svg": { display: "block" },
  },
  "@container (max-width: 600px)": {
    "& .date-navigation": { gridTemplateColumns: "minmax(0, max-content) 32px 32px" },
    "& .today-slot": { display: "none" },
    "& .page-title": { fontSize: "22px" },
  },
  "@container (max-width: 480px)": {
    "& .period-arrow": { display: "none" },
    "& .date-navigation": { display: "block", flex: "1 1 auto" },
    "& .long-title": { display: "none" },
    "& .short-title": { display: "inline" },
    "& .page-title": { fontSize: "20px", marginInlineEnd: "0" },
    "& .filter-label": { display: "none" },
    "& .filters-trigger": { width: "8", paddingInline: "0", gap: "0" },
  },
  "@media print": { display: "none" },
} as const;

export function CalendarTopBar({ onOpenTrash, categoryControl, date, view, todayInView, onPrevious, onNext, onToday, onDateChange, onViewChange, onAddTask, onOpenShortcuts, readOnly }: CalendarTopBarProps) {
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [restoreFocus, setRestoreFocus] = useState(true);
  const headerRef = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    if (!headerRef.current) return;
    const observer = new ResizeObserver(([entry]) => { if ((entry.borderBoxSize[0]?.inlineSize || entry.contentRect.width + 24) >= 940) setFiltersOpen(false); });
    observer.observe(headerRef.current);
    return () => observer.disconnect();
  }, []);
  const title = (short: boolean) => view === "year" ? "" : new Intl.DateTimeFormat("en", { month: short ? "short" : "long", ...(view === "calendar" || view === "list" ? { day: "numeric" as const } : {}), year: "numeric", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`)).slice(0, -4);
  // Actions that move focus elsewhere (the month grid, the shortcuts sheet) must not have it pulled back to the trigger.
  const closeAndRun = (action: () => void, handOffFocus: boolean) => { if (handOffFocus) setRestoreFocus(false); setFiltersOpen(false); action(); };
  const previous = (className?: string) => <Tooltip content="Previous period"><IconButton className={className} {...iconButton} variant="outline" aria-label="Previous period" onClick={onPrevious}><ArrowLeftIcon /></IconButton></Tooltip>;
  const next = (className?: string) => <Tooltip content="Next period"><IconButton className={className} {...iconButton} variant="outline" aria-label="Next period" onClick={onNext}><ArrowRightIcon /></IconButton></Tooltip>;
  return <Flex as="header" ref={headerRef} data-slot="calendar-top-bar" aria-label="Calendar toolbar" align="center" gap="2" flex="0 0 var(--app-header-height, 56px)" h="var(--app-header-height, 56px)"
    minH="var(--app-header-height, 56px)" maxH="var(--app-header-height, 56px)" w="full" minW="0" px="3" bg="bg" colorPalette="gray" css={responsive}>
    <HStack className="date-navigation" gap="2" flex="0 1 auto" minW="0">
      <Heading as="h1" className="page-title" fontWeight="semibold" letterSpacing="-0.035em" lineHeight="32px" truncate me="2">
        <span className="long-title">{title(false)}</span><span className="short-title">{title(true)}</span><Box as="span" fontWeight="normal">{date.slice(0, 4)}</Box>
      </Heading>
      {previous("period-arrow")}
      {next("period-arrow")}
      <Box className="today-slot" minH="8">{!todayInView && <Button {...compactButton} variant="outline" w="full" onClick={onToday}>Today</Button>}</Box>
    </HStack>
    <HStack gap="2" ms="auto" flex="0 0 auto" flexWrap="nowrap">
      {categoryControl && <Box className="category">{categoryControl}</Box>}
      {onViewChange && <>
        <SegmentGroup.Root className="view-tabs" size="sm" aria-label="Calendar view" value={view} onValueChange={(e) => { if (e.value) onViewChange(e.value as CalendarView); }}
          bg="transparent" shadow="none" rounded="lg">
          <SegmentGroup.Items items={viewItems} w="14" px="2" rounded="none" borderWidth="1px" borderColor="border"
            css={{
              "&::before": { display: "none" },
              "&:first-of-type": { borderStartRadius: "lg" },
              "&:last-of-type": { borderEndRadius: "lg" },
              "& + &": { borderInlineStartWidth: "0" },
              "&[data-state=checked], &[data-state=checked][data-ssr], &:hover": { bg: "bg.muted", shadow: "none" },
              "&:focus-within": { zIndex: 1 },
            }} />
        </SegmentGroup.Root>
        <Box className="view-select"><ViewSelect w="104px" view={view} onViewChange={onViewChange} /></Box>
      </>}
      <Box className="filters">
        <Popover.Root lazyMount unmountOnExit open={filtersOpen} onOpenChange={(e) => { setFiltersOpen(e.open); if (e.open) setRestoreFocus(true); }} restoreFocus={restoreFocus} positioning={{ placement: "bottom-end" }}>
          <Popover.Trigger asChild>
            <Button className="filters-trigger" {...compactButton} variant="outline" aria-label="Calendar filters" title="Calendar filters"><SlidersHorizontalIcon /><span className="filter-label">Filters</span></Button>
          </Popover.Trigger>
          <Portal>
            <Popover.Positioner>
              <Popover.Content aria-label="Calendar filters" w="72" maxW="calc(100vw - 24px)" colorPalette="gray">
                <Popover.Body>
                  <Stack gap="4">
                    <Popover.Title fontWeight="semibold">Calendar controls</Popover.Title>
                    {onViewChange && <ViewSelect id={`${id}-view`} fieldLabel="View" view={view} onViewChange={onViewChange} />}
                    <Field.Root>
                      <Field.Label htmlFor={`${id}-date`}>Date</Field.Label>
                      <DatePicker id={`${id}-date`} value={date} onChange={onDateChange} />
                    </Field.Root>
                    <HStack justify="space-between" gap="2">
                      {previous()}
                      <Box flex="1" minH="8">{!todayInView && <Button {...compactButton} variant="outline" w="full" onClick={() => closeAndRun(onToday, view === "month")}>Today</Button>}</Box>
                      {next()}
                    </HStack>
                    <Button {...compactButton} variant="ghost" onClick={() => closeAndRun(onOpenShortcuts, true)}><KeyboardIcon />Keyboard shortcuts</Button>
                  </Stack>
                </Popover.Body>
              </Popover.Content>
            </Popover.Positioner>
          </Portal>
        </Popover.Root>
      </Box>
      {onOpenTrash && <Tooltip content="Trash"><IconButton {...iconButton} variant="ghost" aria-label="Trash" onClick={onOpenTrash}><Trash2Icon /></IconButton></Tooltip>}
      <Button data-new-task-anchor className="add-task" {...compactButton} variant="outline" aria-label="Add task" disabled={readOnly} onClick={onAddTask}><PlusIcon /><span className="add-label">Add task</span></Button>
      <Tooltip content="Keyboard shortcuts"><IconButton className="tools" {...iconButton} variant="ghost" aria-label="Keyboard shortcuts" onClick={onOpenShortcuts}><KeyboardIcon /></IconButton></Tooltip>
    </HStack>
  </Flex>;
}
