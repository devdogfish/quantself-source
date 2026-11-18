import type { Context } from "grammy";
import { clearFlow, trackMessage } from "../state.js";
import { sendAndDelete } from "../auto-delete.js";

export async function handleCancelCommand(ctx: Context) {
  const chatId = ctx.chat!.id;
  const flowState = clearFlow(chatId);

  const ids = flowState?.messageIds ?? [];
  ids.push(ctx.message!.message_id);

  await sendAndDelete(ctx.api, chatId, "Cancelled.", ids, 1000);
}
