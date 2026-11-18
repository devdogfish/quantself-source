export const MODEL: "claude-haiku-5-5";
export const ANTHROPIC_MESSAGES_URL: "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_API_VERSION: "2026-10-21";

type Keep = {
  decision: "keep";
  category: "admin" | "excel" | "web" | "engineering";
  fitNote: string;
  resumeTrack: "admin" | "web" | "engineering";
};

export function buildScreenRequest(
  posting: { company: string; role: string; description: string },
  careerCriteria: string,
): { model: typeof MODEL; max_tokens: number };

export function settleScreenResponse(response: { statusCode: number; body: unknown }):
  { ok: false } | { ok: true; result: Keep | { decision: "skip" } };
