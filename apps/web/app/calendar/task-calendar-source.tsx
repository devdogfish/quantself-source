import { Link2Icon, LockKeyholeIcon } from "lucide-react";
import { end, type Actions } from "../todo/task-workspace-context";
import type { Task } from "../todo/todo-projection";
import s from "../todo/todo-workspace.module.css";
import type { CalendarRange, CalendarSource } from "./calendar-source";

type TaskItem = { date: string; task: Task; actions: Actions };
type TaskBlock = { shownTask: Task; detailed: boolean; blocked: boolean; showPerson: boolean };

export function CalendarEventHeadline({ title, fixed, start, finish }: {
  title: string; fixed?: boolean; start: string; finish: string;
}) {
  return <span className={s.eventHeadline}><strong>{title}</strong><span className={s.eventTime}>
    {fixed && <LockKeyholeIcon aria-label="Fixed appointment" />}{start}–{finish}
  </span></span>;
}

export function taskCalendarSource(
  days: Actions[],
  subscribe: CalendarSource<TaskItem, TaskBlock>["subscribe"],
) {
  const byDate = new Map(days.map(day => [day.date, day]));
  return {
    load({ from, to }: CalendarRange) {
      return days.filter(day => day.date >= from && day.date <= to).flatMap(
        actions => actions.tasks.map(task => ({ date: actions.date, task, actions })),
      );
    },
    subscribe,
    render({ task }: TaskItem, { shownTask, detailed, blocked, showPerson }: TaskBlock) {
      return <>
        <CalendarEventHeadline title={task.title} fixed={task.fixed} start={shownTask.start} finish={end(shownTask)} />
        {detailed && <span className={s.eventContext}>{blocked ? <><Link2Icon />After prerequisite</> : task.fixed ? "Fixed appointment" : task.kind}{showPerson && task.who ? ` · ${task.who}` : ""}</span>}
      </>;
    },
    interact({ date, task }: Pick<TaskItem, "date" | "task">) {
      const actions = byDate.get(date);
      return {
        draggable: !!actions && !actions.readOnly && !task.unplaced,
        resizable: !!actions && !actions.readOnly,
        onOpen: () => actions?.edit(task),
      };
    },
  } satisfies CalendarSource<TaskItem, TaskBlock>;
}
