"use client";
import { useEffect, useState } from "react";
import type { JarvisUiBridge, JarvisUiContext } from "./jarvis-ui";
import { TodoBrowserError, type LiveTodo } from "./todo-live";
import { readTodoDetail, invalidateTodoDetailReads } from "./todo-detail-reader";
import { jarvisTaskContext } from "./jarvis-task-context";

export function useJarvisTaskContext(ui: JarvisUiBridge | null, context: JarvisUiContext, todos: LiveTodo[], visibleTodos: LiveTodo[], today: string, status: string) {
  const [detail, setDetail] = useState<LiveTodo | null>(null);
  const [unavailableNumbers, setUnavailableNumbers] = useState<number[]>([]);
  const [accessDenied, setAccessDenied] = useState(false);
  const number = context.selectedTask?.number;
  const revision = todos.find(todo => todo.number === number)?.updatedAt;
  useEffect(() => {
    let current = true;
    if (!ui || !number || number <= 0 || status === "denied") {
      if (status === "denied") invalidateTodoDetailReads();
      setDetail(null); return;
    }
    void readTodoDetail(number, revision).then(({ todo }) => {
      if (current) { setDetail(todo); setUnavailableNumbers(previous => previous.filter(value => value !== number)); setAccessDenied(false); }
    }).catch((error: unknown) => {
      if (!current) return;
      setDetail(null);
      if (error instanceof TodoBrowserError && [401, 403].includes(error.status)) { invalidateTodoDetailReads(); setAccessDenied(true); }
      if (error instanceof TodoBrowserError && error.status === 404) setUnavailableNumbers(previous => previous.includes(number) ? previous : [...previous, number]);
    });
    return () => { current = false; };
  }, [!!ui, number, revision, status === "denied"]);
  const message = JSON.stringify(jarvisTaskContext({ context, todos, visibleTodos, today, status: accessDenied ? "denied" : status, detail, unavailableNumbers }));
  useEffect(() => { ui?.publish(JSON.parse(message)); }, [ui, message]);
}
