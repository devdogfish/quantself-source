import type { Api } from "grammy";

const DELETE_DELAY_MS = 2000;

export async function deleteMessages(api: Api, chatId: number, messageIds: number[]) {
  for (const id of messageIds) {
    try {
      await api.deleteMessage(chatId, id);
    } catch {
      // Message may already be deleted or too old — ignore
    }
  }
}

export async function deleteAfterDelay(api: Api, chatId: number, messageIds: number[]) {
  setTimeout(() => deleteMessages(api, chatId, messageIds), DELETE_DELAY_MS);
}

export async function sendAndDelete(
  api: Api,
  chatId: number,
  text: string,
  flowMessageIds: number[],
  delayMs = DELETE_DELAY_MS
) {
  const msg = await api.sendMessage(chatId, text);
  const allIds = [...flowMessageIds, msg.message_id];
  setTimeout(() => deleteMessages(api, chatId, allIds), delayMs);
}
