import type { Context } from "grammy";
import { prisma } from "@quantself/db";
import { startFlow, getFlow, clearFlow, trackMessage } from "../state.js";
import { sendAndDelete } from "../auto-delete.js";

export async function handleWeightCommand(ctx: Context) {
  const chatId = ctx.chat!.id;
  const state = startFlow(chatId, "weight");
  state.step = "weight";

  trackMessage(chatId, ctx.message!.message_id);

  const msg = await ctx.reply("Enter your weight in kg:", {
    reply_markup: { force_reply: true },
  });
  trackMessage(chatId, msg.message_id);
}

export async function handleWeightInput(ctx: Context): Promise<boolean> {
  const chatId = ctx.chat!.id;
  const state = getFlow(chatId);
  if (!state || state.flow !== "weight") return false;

  trackMessage(chatId, ctx.message!.message_id);

  const value = parseFloat(ctx.message!.text!);
  if (isNaN(value) || value < 20 || value > 300) {
    const msg = await ctx.reply("Invalid weight. Enter a number between 20 and 300 kg.");
    trackMessage(chatId, msg.message_id);
    return true;
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  await prisma.weightLog.create({
    data: {
      date: today,
      valueKg: value,
      source: "manual",
    },
  });

  const flowState = clearFlow(chatId);
  await sendAndDelete(ctx.api, chatId, `Logged weight: ${value} kg`, flowState!.messageIds);
  return true;
}
