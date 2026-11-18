import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { prisma } from "@quantself/db";
import { startFlow, getFlow, clearFlow, trackMessage } from "../state.js";
import { sendAndDelete } from "../auto-delete.js";

export async function handleSleepCommand(ctx: Context) {
  const chatId = ctx.chat!.id;
  const state = startFlow(chatId, "sleep");
  state.step = "hours";

  trackMessage(chatId, ctx.message!.message_id);

  const msg = await ctx.reply("How many hours did you sleep?", {
    reply_markup: { force_reply: true },
  });
  trackMessage(chatId, msg.message_id);
}

export async function handleSleepInput(ctx: Context): Promise<boolean> {
  const chatId = ctx.chat!.id;
  const state = getFlow(chatId);
  if (!state || state.flow !== "sleep") return false;

  trackMessage(chatId, ctx.message!.message_id);
  const text = ctx.message!.text!;

  if (state.step === "hours") {
    const hours = parseFloat(text);
    if (isNaN(hours) || hours < 0 || hours > 24) {
      const msg = await ctx.reply("Invalid. Enter a number between 0 and 24.");
      trackMessage(chatId, msg.message_id);
      return true;
    }

    state.data.hours = hours;
    state.step = "quality";

    const keyboard = new InlineKeyboard()
      .text("1", "sleep_q:1")
      .text("2", "sleep_q:2")
      .text("3", "sleep_q:3")
      .text("4", "sleep_q:4")
      .text("5", "sleep_q:5");

    const msg = await ctx.reply("Rate your sleep quality:", {
      reply_markup: keyboard,
    });
    trackMessage(chatId, msg.message_id);
    return true;
  }

  if (state.step === "notes") {
    const notes = text === "—" || text === "-" ? null : text;
    state.data.notes = notes;
    await saveSleep(ctx, chatId);
    return true;
  }

  return true;
}

export async function handleSleepCallback(ctx: Context): Promise<boolean> {
  const data = ctx.callbackQuery?.data;
  if (!data?.startsWith("sleep_q:")) return false;

  const chatId = ctx.chat!.id;
  const state = getFlow(chatId);
  if (!state || state.flow !== "sleep" || state.step !== "quality") return false;

  const quality = parseInt(data.split(":")[1]);
  state.data.quality = quality;
  state.step = "notes";

  await ctx.answerCallbackQuery();

  const msg = await ctx.api.sendMessage(chatId, 'Any notes? (send — to skip)', {
    reply_markup: { force_reply: true },
  });
  trackMessage(chatId, msg.message_id);
  return true;
}

async function saveSleep(ctx: Context, chatId: number) {
  const state = getFlow(chatId);
  if (!state) return;

  const hours = state.data.hours as number;
  const quality = state.data.quality as number;
  const notes = state.data.notes as string | null;

  const now = new Date();
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);

  const durationMin = Math.round(hours * 60);
  const sleepOffset = now;
  const sleepOnset = new Date(now.getTime() - durationMin * 60 * 1000);
  const midsleepTime = new Date(sleepOnset.getTime() + (durationMin * 60 * 1000) / 2);

  await prisma.sleepSession.create({
    data: {
      date: today,
      sleepOnset,
      sleepOffset,
      durationMin,
      midsleepTime,
      qualityScore: quality,
      source: "manual",
      notes,
    },
  });

  const flowState = clearFlow(chatId);
  await sendAndDelete(
    ctx.api,
    chatId,
    `Logged sleep: ${hours}h, quality ${quality}/5${notes ? `, "${notes}"` : ""}`,
    flowState!.messageIds
  );
}
