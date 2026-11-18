import type { FlowState, FlowName } from "./types.js";

const flows = new Map<number, FlowState>();

export function getFlow(chatId: number): FlowState | undefined {
  return flows.get(chatId);
}

export function startFlow(chatId: number, flow: FlowName): FlowState {
  const state: FlowState = { flow, step: "", data: {}, messageIds: [] };
  flows.set(chatId, state);
  return state;
}

export function clearFlow(chatId: number): FlowState | undefined {
  const state = flows.get(chatId);
  flows.delete(chatId);
  return state;
}

export function trackMessage(chatId: number, messageId: number) {
  const state = flows.get(chatId);
  if (state) {
    state.messageIds.push(messageId);
  }
}
