import { expect, test } from "bun:test";
import type { AccessContext } from "@quantself/auth";
import { prisma } from "@quantself/db";
import { createApp } from "./app";
import { createTodoWriter } from "./todos-write";
import { type Todo, type TodoReader } from "./todos-github";

test.skipIf(process.env.TODO_HANDBACK_DOCKER_TEST !== "1")(
  "Agent hand-back, Return and completion Undo preserve scope, revision and remote retry safety",
  async () => {
    const owner = { id: crypto.randomUUID(), name: "Owner", email: "fixture@example.com" };
    const sam = { id: crypto.randomUUID(), name: "Sam", avatar: null, kind: "agent" as const };
    const tyler = { ...sam, id: crypto.randomUUID(), name: "Tyler" };
    let todo: Todo = { id: `I_${crypto.randomUUID()}`, number: 11, databaseId: 11, repository: "fixture/todo",
      url: "https://github.com/fixture/todo/issues/11", title: "Review work", body: null, fields: {}, labels: [],
      state: "open", closureReason: null, updatedAt: "fixture-revision-1", fieldValues: [], start: null, end: null,
      allDay: false, fixed: false, scheduleError: null };
    let closes = 0, reopens = 0, loseClose = true, failRead = false, refuseClose = false;
    const reader: TodoReader = {
      list: async () => [todo], assignedList: async ids => ids.includes(todo.id) ? [todo] : [],
      detail: async () => { if (failRead) { failRead = false; throw Error("Read response lost"); } return todo; },
      assignedDetail: async () => todo,
    };
    reader.write = createTodoWriter({ reader, connect: async () => ({ repository: todo.repository, definitions: [], syncProject: async () => {},
      async request(_path, _method, body) {
        const closing = body.query.includes("closeIssue(") && !body.query.includes("reopenIssue(");
        if (closing && refuseClose) return { errors: [{ type: "FORBIDDEN" }] };
        if (closing) closes++;
        else reopens++;
        todo = { ...todo, state: closing ? "closed" : "open", closureReason: closing ? "completed" : null, updatedAt: `fixture-revision-${1 + closes + reopens}` };
        if (closing && loseClose) { loseClose = false; failRead = true; throw Error("Close response lost"); }
        return { data: { [closing ? "closeIssue" : "reopenIssue"]: { issue: { id: todo.id } } } };
      },
    }) });
    const access = (key: string | null): AccessContext => ({ owner,
      client: key === "sam" || key === "reader" ? sam : key === "tyler" ? tyler : { id: "web", name: "Web", kind: "web" },
      permissions: key === "reader" ? ["todos:read"] : ["todos:read", "todos:write"],
    });
    const app = createApp({ todos: reader, todoDelegation: { db: prisma, directory: async () => [sam, tyler] },
      emitAccessLog: () => {}, resolveAccessContext: async headers => access(headers.get("x-api-key")) });
    const origin = new URL(process.env.BETTER_AUTH_URL ?? "http://localhost").origin;
    const todoPath = `todos/${todo.number}`;
    const identity = { ownerId: owner.id, todoId: todo.id };
    const request = (path: string, body?: object, key?: string, method = body ? "POST" : "GET") => app.request(`${origin}/api/v1/${path}`, {
      method, headers: { origin, ...(body && { "content-type": "application/json" }), ...(key && { "x-api-key": key }) },
      ...(body && { body: JSON.stringify(body) }),
    });
    const command = (expectedRevision: number) => ({ expectedRevision, commandId: crypto.randomUUID(), todoId: todo.id });
    const handBack = (body: object, key?: string) => request(`${todoPath}/hand-back`, body, key);
    const decide = (body: object, key?: string) => request(`${todoPath}/hand-back/decision`, body, key);
    const undo = (id: string) => request(`agent-audit/${id}/undo`, undefined, undefined, "POST");

    try {
      expect((await request(`${todoPath}/delegation`, { ...command(0), delegateId: sam.id }, undefined, "PATCH")).status).toBe(200);
      const review = { ...command(1), handBack: { kind: "review", summary: "Draft ready", links: [{ label: "Draft", url: "https://example.com/draft" }] } };
      expect((await handBack(review)).status).toBe(403);
      expect((await handBack(review, "reader")).status).toBe(403);
      expect((await handBack(review, "tyler")).status).toBe(404);
      expect((await handBack(review, "sam")).status).toBe(409);
      await prisma.todoDelegation.update({ where: { ownerId_todoId: identity }, data: { ownerEditedAt: new Date(Date.now() - 180_001) } });
      const reviewed = await (await handBack(review, "sam")).json() as { auditId: string };
      expect(reviewed).toMatchObject({ delegation: { handBack: review.handBack, revision: 2 } });
      expect(await (await undo(reviewed.auditId)).json()).toMatchObject({ delegation: { state: "working", revision: 3 } });
      await prisma.todoDelegation.update({ where: { ownerId_todoId: identity }, data: { ownerEditedAt: new Date(Date.now() - 180_001) } });

      const question = { ...command(3), handBack: { kind: "question", question: "Which version?", choices: ["First", "Second"] } };
      const waiting = await handBack(question, "sam");
      expect(waiting.status).toBe(200);
      const handBackReceipt = await waiting.json() as { auditId: string };
      expect(handBackReceipt).toMatchObject({ delegation: { handBack: question.handBack, state: "waiting_on_owner", revision: 4 } });
      expect(await (await handBack(question, "sam")).json()).toEqual(handBackReceipt);
      expect((await handBack({ ...question, ...command(1) }, "sam")).status).toBe(409);
      const reply = { kind: "choice", choice: "Second" };
      const returning = { ...command(4), decision: "return", reply };
      expect((await decide(returning, "sam")).status).toBe(403);
      expect((await decide({ ...returning, reply: { kind: "choice", choice: "Third" } })).status).toBe(409);
      const returned = await (await decide(returning)).json() as { auditId: string };
      expect(await (await request(todoPath, undefined, "sam")).json()).toMatchObject({ todo: { delegation: { state: "working", ownerReply: reply, revision: 5 } } });
      expect(await (await undo(returned.auditId)).json()).toMatchObject({ delegation: { state: "waiting_on_owner", handBack: question.handBack, revision: 6 } });
      expect((await undo(handBackReceipt.auditId)).status).toBe(409);

      const accept = { ...command(6), decision: "accept", sourceRevision: todo.updatedAt };
      expect((await decide(accept)).status).toBe(503);
      expect(closes).toBe(1);
      expect(await (await request(todoPath)).json()).toMatchObject({ todo: { delegation: { pendingDecision: { commandId: accept.commandId } } } });
      expect((await decide({ ...command(6), decision: "return", reply })).status).toBe(404);
      const accepted = await decide(accept);
      expect(accepted.status).toBe(200);
      const receipt = await accepted.json() as { auditId: string };
      expect(receipt).toMatchObject({ delegation: { state: "handed_back", revision: 7 } });
      expect(closes).toBe(1);
      expect(await (await decide(accept)).json()).toEqual(receipt);

      const undone = await undo(receipt.auditId);
      expect(undone.status).toBe(200);
      const undoReceipt = await undone.json();
      expect(undoReceipt).toMatchObject({ delegation: { state: "waiting_on_owner", revision: 8 }, audit: { undoneAt: expect.any(String) } });
      expect(todo.state).toBe("open");
      expect(await (await undo(receipt.auditId)).json()).toEqual(undoReceipt);
      expect(reopens).toBe(1);

      const previousRevision = todo.updatedAt;
      todo = { ...todo, updatedAt: "changed-outside-quantself" };
      expect((await decide({ ...command(8), decision: "accept", sourceRevision: previousRevision })).status).toBe(409);
      expect(closes).toBe(1);
      refuseClose = true;
      const refused = await decide({ ...command(8), decision: "accept", sourceRevision: todo.updatedAt });
      expect(await refused.json()).toMatchObject({ message: expect.stringContaining("refused") });
      expect(refused.status).toBe(409);
      refuseClose = false;
      expect((await decide({ ...command(8), decision: "accept", sourceRevision: todo.updatedAt })).status).toBe(200);
      expect(closes).toBe(2);
    } finally {
      await prisma.$transaction([
        prisma.todoDelegation.deleteMany({ where: { ownerId: owner.id } }),
        prisma.agentWriteAudit.deleteMany({ where: { ownerId: owner.id } }),
        prisma.apiIdempotencyKey.deleteMany({ where: { OR: [{ clientId: owner.id }, { clientId: { startsWith: `${owner.id}:` } }] } }),
      ]);
    }
  },
);
