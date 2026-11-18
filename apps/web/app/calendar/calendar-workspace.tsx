"use client";

import { TodoWorkspace, type CalendarSurfaceProps } from "../todo/todo-workspace";
import { CalendarTimeGrid, MonthCalendar, YearCalendar } from "./calendar-views";
import { useEventLook } from "@/lib/habit-look";
import theme from "./calendar-theme.module.css";

function CalendarSurface({ hasSubscriptions, hasHabits, hasNativeAppointments, hasMeetings, canCancelMeetings, openAppointment, subscribeTasks, date, view, todayScrollRequest, onCurrentTimeVisibilityChange, actionsForDate, navigate }: CalendarSurfaceProps) {
  const openDay = (day: string) => navigate(day, "calendar");
  const task = useEventLook("task").look, appointment = useEventLook("appointment").look, meeting = useEventLook("meeting").look;
  const surface = view === "year" ? <YearCalendar date={date} todayScrollRequest={todayScrollRequest} openDay={openDay} openMonth={day => navigate(day, "month")} navigateYear={day => navigate(day, "year")} />
    : view === "month" ? <MonthCalendar hasSubscriptions={hasSubscriptions} hasNativeAppointments={hasNativeAppointments} openAppointment={openAppointment} date={date} todayScrollRequest={todayScrollRequest} actionsForDate={actionsForDate} openDay={openDay} navigateMonth={day => navigate(day, "month")} />
    : <CalendarTimeGrid hasSubscriptions={hasSubscriptions} hasHabits={hasHabits} hasMeetings={hasMeetings} canCancelMeetings={canCancelMeetings} hasNativeAppointments={hasNativeAppointments} openAppointment={openAppointment} subscribeTasks={subscribeTasks} date={date} mode={view} navigateDate={day => navigate(day, view)} todayScrollRequest={todayScrollRequest} onCurrentTimeVisibilityChange={onCurrentTimeVisibilityChange} actionsForDate={actionsForDate} openDay={openDay} />;
  return <div className={theme.theme} data-calendar-theme data-look-task={task} data-look-appointment={appointment} data-look-meeting={meeting}>{surface}</div>;
}

export function CalendarWorkspace() {
  return <TodoWorkspace CalendarSurface={CalendarSurface} />;
}
