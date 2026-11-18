import { z } from "@hono/zod-openapi";

const note = z.string().trim().min(1).max(2000);
const answer = z.string().trim().min(1).max(160);
const link = z.object({
  label: z.string().trim().min(1).max(120),
  url: z.url().max(2048).refine(value => {
    const url = URL.parse(value);
    return !!url && ["https:", "http:"].includes(url.protocol) && !url.username && !url.password;
  }),
}).strict();
export const todoHandBackSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("review"), summary: note, links: z.array(link).max(10) }).strict(),
  z.object({ kind: z.literal("question"), question: note, choices: z.array(answer).max(8).optional() }).strict(),
]).openapi("TodoHandBack");
export const todoOwnerReplySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("note"), note }).strict(),
  z.object({ kind: z.literal("choice"), choice: answer }).strict(),
]).openapi("TodoOwnerReply");

const command = {
  commandId: z.uuid(),
  todoId: z.string().min(1).max(256),
  expectedRevision: z.number().int().positive().max(2_147_483_645),
};
export const todoHandBackInput = z.object({ ...command, handBack: todoHandBackSchema }).strict();
export const todoHandBackDecisionInput = z.discriminatedUnion("decision", [
  z.object({ ...command, decision: z.literal("return"), reply: todoOwnerReplySchema }).strict(),
  z.object({ ...command, decision: z.literal("accept"), sourceRevision: z.string().min(1).max(128) }).strict(),
]);

export type TodoHandBack = z.infer<typeof todoHandBackSchema>;
export type TodoOwnerReply = z.infer<typeof todoOwnerReplySchema>;
