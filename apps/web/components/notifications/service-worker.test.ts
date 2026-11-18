import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
const source = readFileSync(new URL("../../public/notifications-sw.js",import.meta.url),"utf8");
test("worker displays declarative push without a session and uses stable replacement tags; click opens task", async () => {
  const listeners: Record<string, (event: any) => void> = {};
  const shown: any[] = [], opened: string[] = [];
  const self = { location: { origin: "https://quantself.example" }, addEventListener(name: string, fn: any) { listeners[name] = fn; }, registration: { showNotification: async (...args: any[]) => { shown.push(args); } }, clients: { matchAll: async () => [], openWindow: async (url: string) => { opened.push(url); } } };
  runInNewContext(source, { self, URL });
  const notification = { title: "Dentist", body: "starts at 2:00 PM", tag: "task-alert-key", navigate: "https://quantself.example/todo?task=42" };
  async function push(value: typeof notification) { let work!: Promise<void>; listeners.push!({ data: { json: () => ({ web_push: 8030, notification: value }) }, waitUntil: (value: Promise<void>) => { work = value; } }); await work; }
  await push(notification); await push(notification);
  expect(shown).toHaveLength(2);
  expect(shown.map(entry => entry[1].tag)).toEqual(["task-alert-key", "task-alert-key"]);
  expect(shown[0][1].renotify).toBe(false);
  expect(shown[0][1].actions).toBeUndefined();
  await push({ ...notification, navigate: "https://attacker.invalid" }); expect(shown).toHaveLength(2);
  let click!: Promise<void>;
  listeners.notificationclick!({ notification: { data: { url: "/todo?task=42" }, close() {} }, waitUntil: (work: Promise<void>) => { click = work; } });
  await click; expect(opened).toEqual(["https://quantself.example/todo?task=42"]);
  listeners.notificationclick!({ notification: { data: { url: "/habits" }, close() {} }, waitUntil: (work: Promise<void>) => { click = work; } });
  await click;
  expect(opened[1]).toBe("https://quantself.example/habits");
});
