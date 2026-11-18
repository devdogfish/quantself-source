import { getPublicOrigin } from "@quantself/auth/public-origin";
import { createTaskDrain } from "./task-drain";
import { habitCatalog } from "./habits-catalog";
import { localHabitDate } from "./habits-definition";
import { planHabitAlerts } from "./habits-calendar";
import webpush from "web-push";
import { prisma } from "@quantself/db";
import {
  DEFAULT_ALERT_MINUTES,
  planAlerts,
  planNativeAppointmentAlert,
  type Alert,
  type NativeAppointmentAlert,
  type NativeReminderAppointment,
} from "./notifications-plan";
import type { TodoReader } from "./todos-github";

type NativeReminderIdentity = Pick<NativeReminderAppointment, "ownerId" | "id">;
type ReminderAlert = Alert | NativeAppointmentAlert | ReturnType<typeof planHabitAlerts>[number];

export type NativeAppointmentReminderReader = {
  // One read across enabled Owners for due alerts: fireAt <= now < prep/start.
  // The contractual prep and lead maxima bound starts to the next eight elapsed days.
  listDue(input: { ownerIds: readonly string[]; now: Date }): Promise<readonly NativeReminderAppointment[]>;
  // One authoritative read for the exact Owner and UUID pairs in the due batch.
  readCurrent(appointments: readonly NativeReminderIdentity[]): Promise<readonly NativeReminderAppointment[]>;
};

const appointmentKey = ({ ownerId, id }: NativeReminderIdentity) => JSON.stringify([ownerId, id]);

export function pushConfiguration() {
  const publicKey = process.env.QUANTSELF_PUSH_PUBLIC_KEY;
  const privateKey = process.env.QUANTSELF_PUSH_PRIVATE_KEY;
  const subject = process.env.QUANTSELF_PUSH_SUBJECT;
  return publicKey && privateKey && subject ? { publicKey, privateKey, subject } : null;
}
export async function notificationSnapshot(reader: TodoReader) {
  const todos = await reader.list();
  const freshness = await reader.freshness?.(todos);
  if (!freshness || freshness.stale || !freshness.readAt || !Number.isFinite(Date.parse(freshness.readAt)) || Date.now() - Date.parse(freshness.readAt) > 90000) throw Error("Notifications waiting for fresh task data.");
  return todos;
}
export function createNotificationWorker(reader: TodoReader, options: {
  send?: typeof webpush.sendNotification;
  now?: () => number;
  ownerId?: string;
  appointments?: NativeAppointmentReminderReader;
} = {}) {
  const send = options.send ?? webpush.sendNotification;
  const clock = options.now ?? Date.now;
  const appointments = options.appointments;
  let running = false;
  async function tick() {
    if (running || !pushConfiguration()) return;
    running = true;
    try {
      const settings = await prisma.notificationSettings.findMany({ where: { enabled: true, ...(options.ownerId ? { ownerId: options.ownerId } : {}) } });
      if (!settings.length) return;
      const owners = settings.map(s => s.ownerId);
      const [todos, devices, overrides, definitions, nativeAppointments] = await Promise.all([
        notificationSnapshot(reader).catch(() => []),
        prisma.notificationDevice.findMany({ where: { ownerId: { in: owners } } }),
        prisma.notificationTask.findMany({ where: { ownerId: { in: owners } } }),
        habitCatalog.currentMany(owners).catch(() => new Map()),
        appointments?.listDue({ ownerIds: owners, now: new Date(clock()) }).catch(() => []) ?? [],
      ]);
      const now = clock();
      const habitDate = localHabitDate(new Date(now));
      const hasHabitAlerts = [...definitions.values()].some(value => planHabitAlerts(value.projection, habitDate, []).length > 0);
      const habitRows = hasHabitAlerts
        ? await prisma.habitOccurrence.findMany({
            where: { ownerId: { in: owners }, date: habitDate },
            select: { ownerId: true, habitId: true, status: true },
          }).catch(() => null)
        : null;
      const habitAlerts = new Map<string, ReturnType<typeof planHabitAlerts>>();
      if (habitRows) {
        const rowsByOwner = new Map<string, typeof habitRows>();
        for (const row of habitRows) {
          const rows = rowsByOwner.get(row.ownerId);
          if (rows) rows.push(row);
          else rowsByOwner.set(row.ownerId, [row]);
        }
        for (const owner of owners) {
          const definition = definitions.get(owner);
          if (definition) habitAlerts.set(owner, planHabitAlerts(definition.projection, habitDate, rowsByOwner.get(owner) ?? []));
        }
      }
      const overrideByTask = new Map(overrides.map(o => [`${o.ownerId}:${o.number}`, o]));
      const settingsByOwner = new Map(settings.map(s => [s.ownerId,s]));
      const appointmentsByOwner = new Map<string, NativeReminderAppointment[]>();
      for (const appointment of nativeAppointments) {
        const rows = appointmentsByOwner.get(appointment.ownerId);
        if (rows) rows.push(appointment);
        else appointmentsByOwner.set(appointment.ownerId, [appointment]);
      }
      // Bounded send concurrency. Task reads are shared across every enrolled device.
      const dueAppointments = new Map<string, NativeReminderIdentity>();
      const jobs = devices.flatMap<{ device: (typeof devices)[number]; alert: ReminderAlert }>(device => {
        const setting = settingsByOwner.get(device.ownerId)!;
        const isDue = (alert: { fireAt: number; expiresAt: number }) =>
          alert.fireAt >= setting.enabledAt.getTime() &&
          alert.fireAt >= device.createdAt.getTime() &&
          alert.fireAt <= now && now < alert.expiresAt;
        const taskJobs = todos.flatMap(todo => {
          const override = overrideByTask.get(`${device.ownerId}:${todo.number}`);
          return planAlerts(todo, override ? override.minutes : DEFAULT_ALERT_MINUTES, override?.morning ?? setting.morning, device.timeZone)
            .filter(isDue)
            .map(alert => ({ device, alert }));
        });
        const habitJobs = (habitAlerts.get(device.ownerId) ?? [])
          .filter(isDue)
          .map(alert => ({device, alert}));
        const appointmentJobs = (appointmentsByOwner.get(device.ownerId) ?? []).flatMap(appointment => {
          const alert = planNativeAppointmentAlert(appointment, device.timeZone);
          if (!alert || !isDue(alert)) return [];
          const target = { ownerId: device.ownerId, id: alert.appointmentId };
          dueAppointments.set(appointmentKey(target), target);
          return [{ device, alert }];
        });
        return [...taskJobs, ...habitJobs, ...appointmentJobs];
      });
      let verifiedAppointments: Promise<Map<string, NativeReminderAppointment>> | undefined;
      async function verifyAppointment(target: NativeReminderIdentity) {
        if (!appointments) return;
        // Wait for a receipt claim before reading current state, then share it across devices.
        verifiedAppointments ??= appointments.readCurrent([...dueAppointments.values()]).then(
          rows => new Map(rows.map(row => [appointmentKey(row), row])),
        );
        return (await verifiedAppointments).get(appointmentKey(target));
      }
      // One current bulk observation read per Owner after receipt claims, shared by devices.
      const verifiedHabits = new Map<string, Promise<ReturnType<typeof planHabitAlerts>>>();
      function verifyHabits(ownerId: string) {
        let pending = verifiedHabits.get(ownerId);
        if (!pending) {
          pending = prisma.habitOccurrence.findMany({
            where: { ownerId, date: habitDate },
            select: { habitId: true, status: true },
          }).then(rows => {
            const definition = definitions.get(ownerId);
            if (!definition) return [];
            return planHabitAlerts(definition.projection, habitDate, rows);
          });
          verifiedHabits.set(ownerId, pending);
        }
        return pending;
      }
      const verifiedTasks = new Map<number, ReturnType<TodoReader["detail"]>>();
      function verifyTask(number: number) {
        let pending = verifiedTasks.get(number);
        if (!pending) { pending = reader.detail(number); verifiedTasks.set(number, pending); }
        return pending;
      }
      let cursor = 0;
      await Promise.all(Array.from({ length: Math.min(4, jobs.length) }, async () => {
        while (cursor < jobs.length) {
          const { device, alert } = jobs[cursor++]!;
          if (clock() >= alert.expiresAt) continue;
          // Atomic durable lease: another worker can recover an interrupted send.
          const claimed = await prisma.notificationReceipt.createMany({ data: [{ deviceId: device.id, key: alert.key }], skipDuplicates: true });
          if (!claimed.count) {
            const recovered = await prisma.notificationReceipt.updateMany({ where: { deviceId: device.id, key: alert.key, sentAt: null, claimedAt: { lt: new Date(now - 60000) } }, data: { claimedAt: new Date(now) } });
            if (!recovered.count) continue;
          }
          try {
            let delivery = alert;
            if ("appointmentId" in alert) {
              const current = await verifyAppointment({ ownerId: device.ownerId, id: alert.appointmentId });
              const verified = current && planNativeAppointmentAlert(current, device.timeZone);
              const sendAt = clock();
              if (!verified || verified.revision !== alert.revision || verified.key !== alert.key ||
                  verified.fireAt > sendAt || sendAt >= verified.expiresAt) continue;
              delivery = verified;
            } else if ("url" in alert) {
              if (!(await verifyHabits(device.ownerId)).some(value => value.key === alert.key && value.fireAt <= clock() && clock() < value.expiresAt)) continue;
            } else {
              const current = await verifyTask(alert.number);
              const setting = settingsByOwner.get(device.ownerId)!;
              const override = overrideByTask.get(`${device.ownerId}:${alert.number}`);
              if (!planAlerts(current, override ? override.minutes : DEFAULT_ALERT_MINUTES, override?.morning ?? setting.morning, device.timeZone).some(value => value.key === alert.key && value.fireAt <= clock() && clock() < value.expiresAt)) continue;
            }
            const url = "url" in delivery ? delivery.url : `/todo?task=${delivery.number}`;
            const configuration = pushConfiguration()!;
            await send({ endpoint: device.endpoint, keys: { p256dh: device.p256dh, auth: device.auth } }, JSON.stringify({ web_push: 8030, notification: {
              title: delivery.title, body: delivery.body, tag: delivery.key, renotify: false,
              navigate: new URL(url, getPublicOrigin() ?? "http://localhost:3000").href,
              data: { url },
            } }), {
              vapidDetails: configuration,
              TTL: Math.max(0, Math.floor((delivery.expiresAt - clock()) / 1000)),
              topic: alert.key.slice(0,32), urgency: "high", timeout: 15000,
            });
            await prisma.notificationReceipt.update({ where: { deviceId_key: { deviceId: device.id, key: alert.key } }, data: { sentAt: new Date() } });
          } catch (error) {
            const status = (error as { statusCode?: number }).statusCode;
            if (status === 404 || status === 410) await prisma.notificationDevice.deleteMany({ where: { id: device.id } });
            // Provider rejection can retry immediately; ambiguous transport outcomes retry
            // after the lease. Stable push topics + device receipts suppress duplicates.
            if (status === 429 || status === 503) {
              const retryAfter = (error as { headers?: Record<string, string> }).headers?.["retry-after"];
              const seconds = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) : NaN;
              const retryAt = Number.isFinite(seconds) ? clock() + seconds * 1000 : retryAfter ? Date.parse(retryAfter) : NaN;
              // The lease becomes reclaimable at the provider's requested time.
              if (Number.isFinite(retryAt) && retryAt > clock()) await prisma.notificationReceipt.updateMany({ where: { deviceId: device.id, key: alert.key, sentAt: null }, data: { claimedAt: new Date(retryAt - 60000) } });
            } else if (status && status !== 404 && status !== 410) await prisma.notificationReceipt.deleteMany({ where: { deviceId: device.id, key: alert.key } });
            console.error("Notification push failed", { status: status ?? "transport-uncertain" });
          }
        }
      }));
      await prisma.notificationReceipt.deleteMany({ where: { claimedAt: { lt: new Date(now - 30 * 86400000) } } });
    } finally { running = false; }
  }
  return { tick, start() { const drain = createTaskDrain(); const run = () => void drain.run(tick).catch(() => console.error("Notification scheduler unavailable; will retry.")); run(); const timer = setInterval(run, 15000); timer.unref(); return () => { clearInterval(timer); return drain.stop(); }; } };
}
