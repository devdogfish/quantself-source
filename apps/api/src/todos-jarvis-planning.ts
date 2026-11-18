import type { CaptureStore } from "./todos-captures";
import { jarvisConflict, type JarvisProvider } from "./todos-jarvis";
import { TodoWriteError, type TodoCommand } from "./todos-write";
import type { Todo, TodoReader } from "./todos-github";

const clock = (value: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Halifax", hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(value));

export async function verifyJarvisSource(store: CaptureStore, provider: JarvisProvider, owner: string, captureId: string, conversationId: string, phoneAuthenticated = async (id: string, agent: string, session: string) => (await import("./phone-jarvis-conversations")).isAuthenticatedPhoneCapture(id, agent, session)) {
  if (await store.get(`deleted:${captureId}`)) throw new TodoWriteError("CAPTURE_DELETED", "Source deleted by Owner.");
  const session = await store.get(`jarvis:${captureId}`);
  if (!session || session.input.owner !== owner) throw jarvisConflict();
  const conversation = await provider.finalConversation(conversationId);
  if (conversation.userId !== captureId || conversation.conversationId !== conversationId) throw jarvisConflict();
  const phone = await store.get(`phone-jarvis:${captureId}`);
  if (phone) {
    if (typeof phone.input.sessionId !== "string" || phone.input.agentId !== conversation.agentId || !await phoneAuthenticated(captureId, conversation.agentId, phone.input.sessionId)) throw jarvisConflict();
  } else if (conversation.agentId !== provider.agentId()) throw jarvisConflict();
  await store.reserve(`jarvis-binding:${captureId}`, { conversationId });
  await store.reserve(`jarvis-source:${conversationId}`, { id: captureId });
  return { ...conversation, phoneSessionId: phone?.input.sessionId as string | undefined };
}

export async function validateJarvisOverlap(reader: TodoReader, command: TodoCommand, current: Todo | null, confirmed: boolean) {
  const edited = command as TodoCommand & { shiftMinutes?: number; beforeMinutes?: number; afterMinutes?: number };
  if (!["start", "end", "shiftMinutes", "beforeMinutes", "afterMinutes", "allDay"].some(key => key in command)) return;
  let start = command.start === undefined ? current?.start ?? null : command.start;
  let end = command.end === undefined ? current?.end ?? null : command.end;
  if (edited.shiftMinutes !== undefined && start && end) {
    start = new Date(Date.parse(start) + edited.shiftMinutes * 60000).toISOString();
    end = new Date(Date.parse(end) + edited.shiftMinutes * 60000).toISOString();
  }
  if (start && !end) end = new Date(Date.parse(start) + 1800000).toISOString();
  if (end && !start) start = new Date(Date.parse(end) - 1800000).toISOString();
  if (!start || !end || (command.allDay ?? current?.allDay) || confirmed) return;
  const from = Date.parse(start) - (edited.beforeMinutes ?? current?.beforeMinutes ?? 0) * 60000;
  const through = Date.parse(end) + (edited.afterMinutes ?? current?.afterMinutes ?? 0) * 60000;
  // relationships purpose bypasses a read cache and preserves complete timing/readiness facts.
  const overlap = (await reader.list("relationships")).find(todo => todo.number !== current?.number && todo.state === "open" && !todo.trashed && !todo.allDay && todo.start && todo.end &&
    from < Date.parse(todo.end) + (todo.afterMinutes ?? 0) * 60000 && Date.parse(todo.start) - (todo.beforeMinutes ?? 0) * 60000 < through);
  if (overlap) throw new TodoWriteError("OVERLAP_REVIEW_REQUIRED", `Overlaps with your ${clock(overlap.start!)} ${overlap.title}. Schedule anyway?`);
}
