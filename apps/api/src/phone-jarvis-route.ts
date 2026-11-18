import { z, type OpenAPIHono } from "@hono/zod-openapi";
import type { AccessContext } from "@quantself/auth";
import { PHONE_HANGUP, phonePinPrompt, validateTwilioSignature, verifyPhonePin } from "./phone-jarvis-security";
import type { PhoneJarvisConfig, PhoneJarvisProvider } from "./phone-jarvis-provider";
import type { PhoneJarvisStore, PhoneSession } from "./phone-jarvis-store-types";

export function registerPhoneJarvisRoutes(
  app: OpenAPIHono<{ Variables: { accessContext: AccessContext | null } }>,
  { config, provider, store, prepareConversation }: { config: PhoneJarvisConfig; provider: PhoneJarvisProvider; store: PhoneJarvisStore; prepareConversation: (session: PhoneSession) => Promise<{ captureId: string; context: string }> },
) {
  app.openAPIRegistry.registerComponent("securitySchemes", "twilioSignature", { type: "apiKey", in: "header", name: "X-Twilio-Signature", description: "Twilio HMAC-SHA1 of exact configured public URL and complete POST form, verified server-side with account auth token." });
  const prompt = (session: PhoneSession) => phonePinPrompt(`${provider.callback(session.id, "pin")}?attempt=${session.attempts}`);
  const terminal = new Set(["completed", "busy", "failed", "no-answer", "canceled"]);
  for (const path of ["/api/v1/phone-jarvis/inbound", "/api/v1/phone-jarvis/:id/:operation"]) {
    // Document without request validators: the handler must authenticate the exact
    // complete signed form before interpreting fields or returning validation errors.
    app.openAPIRegistry.registerPath({
      method: "post", path: path.replace(":id", "{id}").replace(":operation", "{operation}"),
      operationId: path.endsWith("/inbound") ? "receivePhoneJarvisCall" : "receivePhoneJarvisCallback",
      summary: "Receive signed Twilio phone callback", tags: ["To-Dos"],
      security: [{ twilioSignature: [] }], "x-required-permissions": [], "x-destructive": false,
      description: "Authentication: Twilio X-Twilio-Signature over the exact configured public URL, query and full form; account and call/session binding also checked. Required permissions: none. Provider signature required instead of Owner/API-key authentication. Inputs: Twilio application/x-www-form-urlencoded call fields, optional PIN Digits, server-issued attempt query, and session callback path. Success response: 200 text/xml TwiML PIN prompt, authenticated voice connection, or silent Hangup. Failure responses: 403 absent/invalid provider signature or unsupported form. Side effects: durable call status/PIN attempts; voice connection only after PIN authorization. Destructive: no. Retry safety: CallSid and server-side attempt compare-and-set prevent duplicate attempts and connections; terminal status is monotonic. PINs and full provider forms are never logged. This endpoint is for Twilio only.",
      request: {
        ...(path.endsWith("/inbound") ? {} : { params: z.object({ id: z.string(), operation: z.enum(["answer", "pin", "status"]) }) }),
        query: z.object({ attempt: z.string().optional() }),
        body: { required: false, content: { "application/x-www-form-urlencoded": { schema: z.record(z.string(), z.string()) } } },
      },
      responses: { 200: { description: "Provider TwiML response", content: { "text/xml": { schema: z.string(), example: PHONE_HANGUP } } }, 403: { description: "Provider authentication failed; empty body" } },
    });
    app.post(path, async c => {
      const xml = (body: string) => c.body(body, 200, { "Content-Type": "text/xml; charset=utf-8", "Cache-Control": "no-store" });
      try {
        if (!c.req.header("content-type")?.startsWith("application/x-www-form-urlencoded")) return c.body(null, 403);
        const raw = await c.req.text();
        if (raw.length > 16_384) return c.body(null, 403);
        const form = new URLSearchParams(raw);
        // Use configured canonical origin; never trust forwarded headers/Host.
        const incoming = new URL(c.req.url);
        const publicUrl = config.publicUrl + incoming.pathname + incoming.search;
        if (!validateTwilioSignature(publicUrl, form, c.req.header("x-twilio-signature") ?? null, config.authToken) || form.get("AccountSid") !== config.accountSid) return c.body(null, 403);
        const callSid = form.get("CallSid") ?? "";
        if (!/^CA[a-f0-9]{32}$/i.test(callSid)) return xml(PHONE_HANGUP);
        const operation = c.req.param("operation");
        if (path.endsWith("/inbound")) {
          if (form.get("From") !== config.ownerNumber || form.get("To") !== config.twilioNumber || form.get("Direction") !== "inbound") return xml(PHONE_HANGUP);
          const session = await store.createInbound(callSid);
          return xml(session.connection === "pending" && session.expiresAt.getTime() > Date.now() && session.attempts < 3 ? prompt(session) : PHONE_HANGUP);
        }
        const id = c.req.param("id")!;
        const session = await store.get(id);
        if (!session) return xml(PHONE_HANGUP);
        const outbound = session.direction === "outbound";
        if (form.get("From") !== (outbound ? config.twilioNumber : config.ownerNumber) || form.get("To") !== (outbound ? config.ownerNumber : config.twilioNumber)) return xml(PHONE_HANGUP);
        // Provider-authenticated outbound callbacks may beat call creation response.
        if (session.callSid !== callSid && !(outbound && (operation === "answer" || operation === "status") && session.callSid === null && await store.bindCall(id, callSid))) return xml(PHONE_HANGUP);
        if (operation === "status") {
          const status = form.get("CallStatus") ?? "";
          if (terminal.has(status)) await store.close(id, callSid, status);
          return xml(PHONE_HANGUP);
        }
        if (session.expiresAt.getTime() <= Date.now() || session.connection !== "pending" || session.attempts >= 3) return xml(PHONE_HANGUP);
        if (operation === "answer") {
          // AMD can return unknown for an answered human call. Let the PIN gate
          // authenticate them; detected machines and missing classifications still stop.
          if (!outbound || !["human", "unknown"].includes(form.get("AnsweredBy") ?? "")) { await store.close(id, callSid, "machine-or-unknown"); return xml(PHONE_HANGUP); }
          return xml(prompt(session));
        }
        if (operation !== "pin") return xml(PHONE_HANGUP);
        const attempt = incoming.searchParams.get("attempt");
        if (attempt !== String(session.attempts)) return xml(PHONE_HANGUP);
        const correct = verifyPhonePin(form.get("Digits") ?? "", config.pinHash);
        const updated = await store.consumePinAttempt(id, callSid, session.attempts, correct);
        if (!updated) return xml(PHONE_HANGUP);
        if (!correct) return xml(updated.attempts < 3 ? prompt(updated) : PHONE_HANGUP);
        if (!updated.authenticated || !await store.claimConnection(id, callSid)) return xml(PHONE_HANGUP);
        // No ElevenLabs request, private context, or audio before durable PIN gate.
        const conversation = await prepareConversation(updated);
        const twiml = await provider.registerAuthenticatedCall(id, session.direction, conversation);
        await store.markConnected(id, callSid);
        return xml(twiml);
      } catch {
        // Never expose/log provider errors, POST fields, PIN, or credentials.
        return xml(PHONE_HANGUP);
      }
    });
  }
}
