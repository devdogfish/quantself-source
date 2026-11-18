import type { Context } from "grammy";
import { prisma } from "@quantself/db";
import { deleteAfterDelay } from "../auto-delete.js";

const USAGE = "Usage: /log <type> <value>\nTypes: weight, mood, water, sleep";

export async function handleLogCommand(ctx: Context) {
  const chatId = ctx.chat!.id;
  const msgId = ctx.message!.message_id;
  const text = ctx.message!.text!;

  const parts = text.split(/\s+/).slice(1); // remove /log
  if (parts.length < 2) {
    const msg = await ctx.reply(USAGE);
    deleteAfterDelay(ctx.api, chatId, [msgId, msg.message_id]);
    return;
  }

  const type = parts[0].toLowerCase();
  const rawValue = parts[1];
  const value = parseFloat(rawValue);

  if (isNaN(value)) {
    const msg = await ctx.reply(`Invalid value: "${rawValue}". Must be a number.`);
    deleteAfterDelay(ctx.api, chatId, [msgId, msg.message_id]);
    return;
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const now = new Date();
  let confirmText = "";

  try {
    switch (type) {
      case "weight":
        if (value < 20 || value > 300) throw new Error("Weight must be 20–300 kg");
        await prisma.weightLog.create({
          data: { date: today, valueKg: value, source: "manual" },
        });
        confirmText = `Logged weight: ${value} kg`;
        break;

      case "mood":
        if (value < 1 || value > 5 || !Number.isInteger(value))
          throw new Error("Mood must be 1–5");
        await prisma.moodLog.create({
          data: { date: today, timestamp: now, score: value },
        });
        confirmText = `Logged mood: ${value}/5`;
        break;

      case "water":
        if (value <= 0 || value > 20) throw new Error("Water must be 0–20 litres");
        await prisma.dailyLog.create({
          data: { date: today, category: "water_liters", value },
        });
        confirmText = `Logged water: ${value}L`;
        break;

      case "sleep": {
        if (value < 0 || value > 24) throw new Error("Sleep must be 0–24 hours");
        const durationMin = Math.round(value * 60);
        const sleepOffset = now;
        const sleepOnset = new Date(now.getTime() - durationMin * 60 * 1000);
        const midsleepTime = new Date(
          sleepOnset.getTime() + (durationMin * 60 * 1000) / 2
        );
        await prisma.sleepSession.create({
          data: {
            date: today,
            sleepOnset,
            sleepOffset,
            durationMin,
            midsleepTime,
            source: "manual",
          },
        });
        confirmText = `Logged sleep: ${value}h`;
        break;
      }

      default: {
        const msg = await ctx.reply(`Unknown type: "${type}". ${USAGE}`);
        deleteAfterDelay(ctx.api, chatId, [msgId, msg.message_id]);
        return;
      }
    }
  } catch (err: any) {
    const msg = await ctx.reply(err.message);
    deleteAfterDelay(ctx.api, chatId, [msgId, msg.message_id]);
    return;
  }

  const msg = await ctx.reply(confirmText);
  deleteAfterDelay(ctx.api, chatId, [msgId, msg.message_id]);
}
