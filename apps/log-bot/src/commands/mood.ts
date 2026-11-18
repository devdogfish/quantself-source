import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { prisma } from "@quantself/db";
import { startFlow, getFlow, clearFlow, trackMessage } from "../state.js";
import { sendAndDelete } from "../auto-delete.js";

export async function handleMoodCommand(ctx: Context) {
  const chatId = ctx.chat!.id;
  const state = startFlow(chatId, "mood");
  state.step = "score";

  trackMessage(chatId, ctx.message!.message_id);

  const keyboard = new InlineKeyboard()
    .text("1", "mood:1")
    .text("2", "mood:2")
    .text("3", "mood:3")
    .text("4", "mood:4")
    .text("5", "mood:5");

  const msg = await ctx.reply("Rate your mood:", {
    reply_markup: keyboard,
  });
  trackMessage(chatId, msg.message_id);
}

export async function handleMoodCallback(ctx: Context): Promise<boolean> {
  const data = ctx.callbackQuery?.data;
  if (!data?.startsWith("mood:")) return false;

  const chatId = ctx.chat!.id;
  const state = getFlow(chatId);
  if (!state || state.flow !== "mood") return false;

  const score = parseInt(data.split(":")[1]);
  await ctx.answerCallbackQuery();

  const now = new Date();
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);

  await prisma.moodLog.create({
    data: {
      date: today,
      timestamp: now,
      score,
    },
  });

  const flowState = clearFlow(chatId);
  await sendAndDelete(ctx.api, chatId, `Logged mood: ${score}/5`, flowState!.messageIds);
  return true;
}
