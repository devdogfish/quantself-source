# Jarvis silent listening

Researched 2026-10-26. Research only; no runtime or provider settings changed.

## Answer

Yes, feasible with changes. Silent connected listening still costs money. Truly free provider idle time requires local listening while the provider session is disconnected.

## Verified provider behavior

- ElevenLabs `turn_timeout` prompts after user silence; documented range 1–30 seconds. Raising it only delays reminders. `soft_timeout_config` is different: filler speech while waiting for an LLM response. Maximum session duration defaults to 600 seconds and supports 60–7,200 seconds. [Conversation flow](https://elevenlabs.io/docs/eleven-agents/customization/conversation-flow)
- The `skip_turn` system tool lets the model wait without speaking. Its documented use is a user-requested pause; it is not a promise of deterministic permanent silence or zero inference. [Skip turn](https://elevenlabs.io/docs/eleven-agents/customization/tools/system-tools/skip-turn)
- A client `user_activity` event resets the turn timeout without adding conversation content. ElevenLabs documents it for maintaining long silent conversations, recommending events tied to actual engagement. Periodic resets could suppress timeout prompts, but require validating speech turn-taking and billing behavior. [Client events](https://elevenlabs.io/docs/eleven-agents/customization/events/client-to-server-events)
- Voice calls are billed by connection duration; silence longer than 10 seconds receives a 95% discount. LLM costs are separate. Muting a microphone or suppressing replies does not disconnect the call. [Billing](https://elevenlabs.io/docs/help-center/product/eleven-agents/how-much-does-eleven-agents-cost)
- Published additional-call pricing is $0.08/minute before LLM costs. At a 95% discount, qualifying silence is approximately $0.004/minute or $0.24/hour; this is illustrative marginal pricing, not an account-specific quote. [Pricing](https://elevenlabs.io/pricing/agents)

## Current implementation

Local inspection by the parent research agent:

- [Browser connection](../../apps/web/app/todo/jarvis-connection.ts) opens the ElevenLabs WebSocket directly and receives provider VAD events. Its inactivity helper expires after 60 seconds.
- [Jarvis UI](../../apps/web/app/todo/todo-jarvis.tsx) ends the conversation on that idle timeout.
- [Server configuration validation](../../apps/api/src/todos-jarvis.ts) allows `end_call`, rejecting other built-in system tools. Using `skip_turn` needs an allowlist change.

The reported five-second reminders fit ElevenLabs silence-turn behavior, but the exact live agent timeout/prompt was not read and the cause remains unconfirmed.

## Options

1. **Simpler:** suppress unsolicited turns, allow silent waiting, adjust local inactivity behavior, and renew sessions when required. Keeps cloud connection latency low; retains discounted idle charges.
2. **Lowest provider idle cost:** run speech or wake-word detection locally; connect only when addressed and disconnect after the exchange. Retain local listening between calls. This is a proposed architecture, not existing behavior. Needs buffered first speech, reconnection/context handling, and testing for browser suspension and background noise. Adds startup latency but avoids provider connection charges while disconnected.

For all-day availability with minimal idle spend, option 2 best matches the request. Local listening still consumes device resources; uninterrupted operation depends on browser and operating-system lifecycle behavior.
