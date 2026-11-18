import { createMeetingEmailWorker, meetingEmailConfig, prismaMeetingOutbox, sesMeetingMailer } from "./meetings-email";

export function createMeetingEmailRuntime(env: Record<string, string | undefined>) {
  // Serve-only containers enqueue mail. The background worker drains the shared outbox.
  if (env.QUANTSELF_API_MODE === "serve") return null;
  const config = meetingEmailConfig(env);
  return config
    ? createMeetingEmailWorker({ outbox: prismaMeetingOutbox(), mailer: sesMeetingMailer(config, env.QUANTSELF_MEETINGS_SES_REGION), config })
    : null;
}

export const productionMeetingEmail = createMeetingEmailRuntime(process.env);
