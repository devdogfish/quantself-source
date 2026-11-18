export type PhoneJarvisConfig = {
  publicUrl: string;
  accountSid: string;
  authToken: string;
  ownerNumber: string;
  twilioNumber: string;
  pinHash: string;
  agentId: string;
  elevenLabsApiKey: string;
};
export function readPhoneJarvisConfig(env: Record<string, string | undefined> = process.env): PhoneJarvisConfig {
  const required = (name: string) => { const value = env[name]?.trim(); if (!value) throw new Error("Phone Jarvis is not configured"); return value; };
  const config = {
    publicUrl: required("QUANTSELF_PHONE_PUBLIC_URL"), accountSid: required("QUANTSELF_TWILIO_ACCOUNT_SID"),
    authToken: required("QUANTSELF_TWILIO_AUTH_TOKEN"), ownerNumber: required("QUANTSELF_PHONE_OWNER_NUMBER"),
    twilioNumber: required("QUANTSELF_TWILIO_PHONE_NUMBER"), pinHash: required("QUANTSELF_PHONE_PIN_HASH"),
    agentId: required("QUANTSELF_ELEVENLABS_PHONE_AGENT_ID"), elevenLabsApiKey: required("QUANTSELF_ELEVENLABS_API_KEY"),
  };
  const url = new URL(config.publicUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/" || !/^AC[a-f0-9]{32}$/i.test(config.accountSid) || ![config.ownerNumber, config.twilioNumber].every(n => /^\+[1-9]\d{7,14}$/.test(n)) || !/^scrypt:[a-f0-9]{32}:[a-f0-9]{64}$/.test(config.pinHash)) throw new Error("Invalid Phone Jarvis configuration");
  config.publicUrl = url.origin;
  return config;
}
export type PhoneJarvisProvider = ReturnType<typeof createPhoneJarvisProvider>;
export function createPhoneJarvisProvider(config: PhoneJarvisConfig, request: typeof fetch = fetch) {
  const callback = (sessionId: string, kind: "answer" | "pin" | "status") => `${config.publicUrl}/api/v1/phone-jarvis/${encodeURIComponent(sessionId)}/${kind}`;
  return {
    callback,
    /** Call creation must be claimed durably before invoking: ambiguous network
     * failures must never automatically redial. Twilio has no create idempotency key. */
    async createOwnerCall(sessionId: string): Promise<string> {
      const response = await request(`https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Calls.json`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
        headers: { Authorization: `Basic ${Buffer.from(`${config.accountSid}:${config.authToken}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ To: config.ownerNumber, From: config.twilioNumber, Url: callback(sessionId, "answer"), Method: "POST", MachineDetection: "Enable", AsyncAmd: "false", StatusCallback: callback(sessionId, "status"), StatusCallbackMethod: "POST", StatusCallbackEvent: "completed", Timeout: "25", Record: "false" }),
      });
      if (!response.ok) throw new Error("Phone call creation unavailable");
      const body = await response.json() as { sid?: string };
      if (!body.sid || !/^CA[a-f0-9]{32}$/i.test(body.sid)) throw new Error("Invalid phone call response");
      return body.sid;
    },
    /** Invoke only after durable PIN authorization and single connection claim. */
    async registerAuthenticatedCall(sessionId: string, direction: "inbound" | "outbound", conversation: { captureId: string; context: string }): Promise<string> {
      const response = await request("https://api.elevenlabs.io/v1/convai/twilio/register-call", {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
        headers: { "xi-api-key": config.elevenLabsApiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ agent_id: config.agentId, from_number: direction === "inbound" ? config.ownerNumber : config.twilioNumber, to_number: direction === "inbound" ? config.twilioNumber : config.ownerNumber, direction, conversation_initiation_client_data: { user_id: conversation.captureId, dynamic_variables: { phone_session_id: sessionId, todo_jarvis_capture_id: conversation.captureId, capture_id: conversation.captureId, phone_context: conversation.context, phone_first_message: direction === "outbound" ? "Let’s review today and plan tomorrow. How did today go?" : "Hello. How can I help?" } } }),
      });
      if (!response.ok) throw new Error("Phone conversation unavailable");
      const raw = await response.text();
      const twiml: unknown = response.headers.get("content-type")?.includes("json") ? JSON.parse(raw) : raw;
      if (typeof twiml !== "string" || twiml.length > 100_000 || !/<Response[\s>]/.test(twiml)) throw new Error("Invalid phone conversation response");
      return twiml;
    },
  };
}
