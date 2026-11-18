import type { AnchorHTMLAttributes, CSSProperties } from "react";
import { Button, HStack } from "@chakra-ui/react";
import { ClipboardCheckIcon, ClockIcon, LockKeyholeIcon } from "lucide-react";
import { dateLabel, end, toneFor } from "../todo/task-workspace-context";
import { appointmentHref } from "../../lib/native-appointment-link";
import type { NativeAppointment, NativeCalendarSegment } from "../todo/native-appointments";
import s from "../todo/todo-workspace.module.css";
import { CalendarEventHeadline } from "./task-calendar-source";

type EventProps = { segment: NativeCalendarSegment; onOpen?: (appointment: NativeAppointment) => void };
type LinkProps = Pick<EventProps, "onOpen"> & { appointment: NativeAppointment } &
  Pick<AnchorHTMLAttributes<HTMLAnchorElement>, "className" | "style" | "title" | "children" | "aria-label"> &
  { "data-side"?: "before" | "after"; "data-detailed"?: boolean };

function AppointmentLink({ appointment, onOpen, ...props }: LinkProps) {
  return <a {...props} href={appointmentHref(appointment.id)} data-tone={toneFor(appointment)} data-calendar-event data-appointment-id={appointment.id}
    onDoubleClick={event => event.stopPropagation()} onClick={event => {
      if (!onOpen || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      onOpen(appointment);
    }} />;
}

export function NativeCompactEvent({ segment, onOpen, unplaced }: EventProps & { unplaced?: boolean }) {
  const { appointment } = segment;
  return <div className={s.compactEvent}>
    <AppointmentLink appointment={appointment} onOpen={onOpen} className={unplaced ? s.allDayEvent : s.monthEvent}
      aria-label={`${appointment.title}, ${segment.start}, fixed appointment`} title={segment.timingWarning}>
      <span className={s.compactEventIcon} aria-hidden="true"><LockKeyholeIcon /></span>
      <span className={s.compactEventTitle}>{unplaced ? "Review time · " : ""}{appointment.title}</span>
      {!unplaced && <time>{segment.start}</time>}
    </AppointmentLink>
  </div>;
}

export function NativeTimelineEvent({ segment, onOpen, style, date, week, compact, detailed, minuteHeight }: EventProps & {
  style: CSSProperties; date: string; week: boolean; compact: boolean; detailed: boolean; minuteHeight: number;
}) {
  const { appointment } = segment;
  function extension(side: "before" | "after", minutes: number, edgeStyle: CSSProperties) {
    const label = side === "before" ? "prep time" : "after event";
    return <AppointmentLink appointment={appointment} onOpen={onOpen}
      className={s.prepExtension} data-side={side} style={edgeStyle} title={`${appointment.title}: ${minutes} minutes ${label}`}>
      {side === "before" ? <ClipboardCheckIcon aria-hidden="true" /> : <ClockIcon aria-hidden="true" />}
      <span className={s.prepFullLabel}>{minutes} minutes {label}</span>
      <span className={s.prepCompactLabel}>{side === "before" ? "Prep" : "After"} · {minutes}m</span>
    </AppointmentLink>;
  }
  const before = segment.beforeMinutes ?? 0, after = segment.afterMinutes ?? 0;
  return <div className={s.calendarEvent} data-kind="appointment" data-tone={toneFor(appointment)} data-week={week} data-short={compact} style={style}>
    {segment.prepOnly ? extension(segment.prepOnly, segment.minutes, { height: "100%" }) : <>
      {before > 0 && extension("before", before, { bottom: "100%", height: `${before * minuteHeight}px` })}
      {after > 0 && extension("after", after, { top: "100%", height: `${after * minuteHeight}px` })}
      <div className={s.eventCore}>
        <AppointmentLink appointment={appointment} onOpen={onOpen} className={s.timelineBlock} data-detailed={detailed}
          aria-label={`Event ${appointment.title}, ${dateLabel(date)}, ${segment.start} to ${end(segment)}, fixed appointment`}
          title={segment.timingWarning}>
          <CalendarEventHeadline title={appointment.title} fixed start={segment.start} finish={end(segment)} />
          {detailed && <span className={s.eventContext}>Fixed appointment · {appointment.category}</span>}
        </AppointmentLink>
      </div>
    </>}
  </div>;
}

export function NativeAppointmentsStatus({ error, retry }: { error?: string; retry: () => void }) {
  if (!error) return null;
  return <HStack><span role="status">{error}</span><Button size="xs" variant="outline" onClick={retry}>Retry appointments</Button></HStack>;
}
