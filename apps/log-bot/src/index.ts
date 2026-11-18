import "dotenv/config";
import { Bot } from "grammy";
import { getFlow } from "./state.js";
import { handleWeightCommand, handleWeightInput } from "./commands/weight.js";
import { handleMoodCommand, handleMoodCallback } from "./commands/mood.js";
import {
  handleSleepCommand,
  handleSleepInput,
  handleSleepCallback,
} from "./commands/sleep.js";
import {
  handleSpendCommand,
  handleSpendInput,
  handleSpendCallback,
} from "./commands/spend.js";
import { handleLogCommand } from "./commands/log.js";
import { handleCancelCommand } from "./commands/cancel.js";

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error("BOT_TOKEN environment variable is required");
  process.exit(1);
}

const ownerId = process.env.OWNER_ID ? parseInt(process.env.OWNER_ID) : null;
if (!ownerId) {
  console.error("OWNER_ID environment variable is required");
  process.exit(1);
}

const bot = new Bot(token);

// --- Access control: reject anyone who isn't the owner ---
bot.use(async (ctx, next) => {
  const userId = ctx.from?.id;
  if (userId !== ownerId) {
    return; // silently ignore
  }
  await next();
});

// --- Commands ---
bot.command("weight", handleWeightCommand);
bot.command("mood", handleMoodCommand);
bot.command("sleep", handleSleepCommand);
bot.command("spend", handleSpendCommand);
bot.command("log", handleLogCommand);
bot.command("cancel", handleCancelCommand);
bot.command("start", async (ctx) => {
  const msg = await ctx.reply(
    "QuantSelf Logger Bot\n\n" +
      "Commands:\n" +
      "/weight — Log body weight\n" +
      "/mood — Log mood (1-5)\n" +
      "/sleep — Log sleep\n" +
      "/spend — Log a transaction\n" +
      "/log — Quick shorthand (e.g. /log water 2)\n" +
      "/cancel — Cancel current flow"
  );
  // Don't auto-delete the start message
});

// --- Callback queries (inline keyboard taps) ---
bot.on("callback_query:data", async (ctx) => {
  if (await handleMoodCallback(ctx)) return;
  if (await handleSleepCallback(ctx)) return;
  if (await handleSpendCallback(ctx)) return;
  await ctx.answerCallbackQuery();
});

// --- Text messages (force reply inputs) ---
bot.on("message:text", async (ctx) => {
  const chatId = ctx.chat.id;
  const state = getFlow(chatId);
  if (!state) return;

  switch (state.flow) {
    case "weight":
      await handleWeightInput(ctx);
      break;
    case "sleep":
      await handleSleepInput(ctx);
      break;
    case "spend":
      await handleSpendInput(ctx);
      break;
  }
});

// --- Photo messages (receipt stub) ---
bot.on("message:photo", async (ctx) => {
  const msg = await ctx.reply(
    "Receipt parsing isn't available yet — please use /spend to enter manually."
  );
  setTimeout(() => {
    ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => {});
    ctx.api.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {});
  }, 5000);
});

// --- Start ---
bot.start({
  drop_pending_updates: true,
  onStart: (info) => {
    console.log(`Logger bot started as @${info.username}`);
  },
});

// Graceful shutdown
const stop = () => bot.stop();
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
