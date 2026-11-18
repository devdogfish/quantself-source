import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { prisma } from "@quantself/db";
import { startFlow, getFlow, clearFlow, trackMessage } from "../state.js";
import { sendAndDelete } from "../auto-delete.js";

const CATEGORIES = [
  ["Food", "food"],
  ["Transport", "transport"],
  ["Health", "healthcare"],
  ["Entertainment", "entertainment"],
  ["Shopping", "shopping"],
  ["Other", "other"],
] as const;

export async function handleSpendCommand(ctx: Context) {
  const chatId = ctx.chat!.id;

  // Check for image
  if (ctx.message?.photo) {
    trackMessage(chatId, ctx.message.message_id);
    const msg = await ctx.reply("Receipt parsing isn't available yet — please enter the amount manually.");
    setTimeout(() => {
      ctx.api.deleteMessage(chatId, msg.message_id).catch(() => {});
      ctx.api.deleteMessage(chatId, ctx.message!.message_id).catch(() => {});
    }, 5000);
    return;
  }

  const state = startFlow(chatId, "spend");
  state.step = "amount";

  trackMessage(chatId, ctx.message!.message_id);

  const msg = await ctx.reply("Enter the amount spent:", {
    reply_markup: { force_reply: true },
  });
  trackMessage(chatId, msg.message_id);
}

export async function handleSpendInput(ctx: Context): Promise<boolean> {
  const chatId = ctx.chat!.id;
  const state = getFlow(chatId);
  if (!state || state.flow !== "spend") return false;

  trackMessage(chatId, ctx.message!.message_id);
  const text = ctx.message!.text!;

  if (state.step === "amount") {
    const amount = parseFloat(text);
    if (isNaN(amount) || amount <= 0) {
      const msg = await ctx.reply("Invalid amount. Enter a positive number.");
      trackMessage(chatId, msg.message_id);
      return true;
    }

    state.data.amount = amount;
    state.step = "category";

    const keyboard = new InlineKeyboard();
    for (let i = 0; i < CATEGORIES.length; i += 2) {
      const row = CATEGORIES.slice(i, i + 2);
      for (const [label, value] of row) {
        keyboard.text(label, `spend_cat:${value}`);
      }
      keyboard.row();
    }

    const msg = await ctx.reply("Select a category:", {
      reply_markup: keyboard,
    });
    trackMessage(chatId, msg.message_id);
    return true;
  }

  if (state.step === "merchant") {
    const merchant = text === "—" || text === "-" ? null : text;
    state.data.merchant = merchant;
    await saveSpend(ctx, chatId);
    return true;
  }

  return true;
}

export async function handleSpendCallback(ctx: Context): Promise<boolean> {
  const data = ctx.callbackQuery?.data;
  if (!data?.startsWith("spend_cat:")) return false;

  const chatId = ctx.chat!.id;
  const state = getFlow(chatId);
  if (!state || state.flow !== "spend" || state.step !== "category") return false;

  const category = data.split(":")[1];
  state.data.category = category;
  state.step = "merchant";

  await ctx.answerCallbackQuery();

  const msg = await ctx.api.sendMessage(chatId, "Merchant name? (send — to skip)", {
    reply_markup: { force_reply: true },
  });
  trackMessage(chatId, msg.message_id);
  return true;
}

async function saveSpend(ctx: Context, chatId: number) {
  const state = getFlow(chatId);
  if (!state) return;

  const amount = state.data.amount as number;
  const category = state.data.category as string;
  const merchant = state.data.merchant as string | null;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  await prisma.transaction.create({
    data: {
      date: today,
      amount,
      type: "expense",
      category: category as any,
      merchant,
    },
  });

  const label = CATEGORIES.find(([, v]) => v === category)?.[0] ?? category;
  const flowState = clearFlow(chatId);
  await sendAndDelete(
    ctx.api,
    chatId,
    `Logged: ${amount} (${label})${merchant ? ` at ${merchant}` : ""}`,
    flowState!.messageIds
  );
}
