import { createTaskDrain } from "./task-drain";
import { phoneBackgroundTick } from "./phone-jarvis-background";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AccessContext } from "@quantself/auth";
import type { TodoReader } from "./todos-github";
import { createPhoneJarvisProvider, readPhoneJarvisConfig } from "./phone-jarvis-provider";
import { registerPhoneJarvisRoutes } from "./phone-jarvis-route";
import { phoneJarvisStore } from "./phone-jarvis-store";
import { createPhoneScheduler } from "./phone-jarvis-scheduler";
import { createPhoneConversations } from "./phone-jarvis-conversations";

export function createPhoneRuntime(reader: TodoReader, env = process.env) {
  if (env.QUANTSELF_PHONE_ENABLED !== "1") return null;
  // Explicit enablement with missing configuration fails startup visibly.
  const config = readPhoneJarvisConfig(env);
  const provider = createPhoneJarvisProvider(config);
  const conversations = createPhoneConversations({ config, reader });
  const schedule = createPhoneScheduler(phoneJarvisStore, id => provider.createOwnerCall(id));
  let timer: ReturnType<typeof setInterval> | undefined;
  const drain = createTaskDrain();
  const work = phoneBackgroundTick(schedule, conversations.tickArchive);
  const tick = () => drain.run(work);
  return {
    register(app: OpenAPIHono<{ Variables: { accessContext: AccessContext | null } }>) {
      registerPhoneJarvisRoutes(app, { config, provider, store: phoneJarvisStore, prepareConversation: conversations.prepareConversation });
    },
    start() { if (timer) return; void tick(); timer = setInterval(() => void tick(), 15_000); timer.unref(); },
    stop() { if (timer) clearInterval(timer); timer = undefined; return drain.stop(); },
  };
}
