import { readTodoDeadline } from "./todos-deadline";
import { expect, test, spyOn } from "bun:test";
import {
  createTodoWriter,
  type CommandJournal,
  type TodoWriteResult,
} from "./todos-write";
import { readTodoSchedule, type Todo } from "./todos-github";

function fixture({ atomicJournal = false, checkPersonalCalendar = async () => false } = {}) {
  const commands = new Map<string, any>();
  let captureClaims = 0;
  const journal: CommandJournal = {
    reserve: async (key, hash) => {
      const existing = commands.get(key);
      if (existing) return { fresh: false, ...structuredClone(existing) };
      const receipt = { hash, state: { done: {} } };
      commands.set(key, receipt);
      return { fresh: true, ...structuredClone(receipt) };
    },
    save: async (key, state) => {
      commands.get(key).state = structuredClone(state);
    },
    ...(atomicJournal ? { claimLifecycle: async (key, before, after) => {
      captureClaims++;
      const entry = commands.get(key);
      if (JSON.stringify(entry.state) !== JSON.stringify(before)) return false;
      entry.state = structuredClone(after);
      return true;
    } } : {}),
  };
  const todos: Todo[] = [];
  const writes: { path: string; body: any; method: string }[] = [];
  let failField = false,
    loseCreate = false,
    projectFailure = false,
    dropCreate = false;
  let projectCalls = 0;
  let dropComment = false;
  let rejectLifecycle = false;
  const reader = {
    list: async () => structuredClone(todos),
    detail: async (number: number) => { const todo = todos.find((t) => t.number === number)!; return structuredClone({ ...todo, ...readTodoDeadline(todo.body, todo.fields.Due) }); },
  };
  const connect: Parameters<
    typeof createTodoWriter
  >[0]["connect"] = async () => ({
    repository: "tasks/personal",
    definitions: [
      {
        id: 1,
        name: "Commitment",
        data_type: "single_select",
        options: ["Inbox", "Active", "Someday"].map((name) => ({ name })),
      },
      {
        id: 2,
        name: "Client",
        data_type: "single_select",
        options: [{ name: "Personal" }],
      },
      { id: 3, name: "Estimate", data_type: "number" },
      { id: 6, name: "Location", data_type: "text" },
      { id: 7, name: "Due", data_type: "date" },
      { id: 8, name: "URL", data_type: "text" },
      { id: 4, name: "Rank", data_type: "number" },
      {
        id: 5,
        name: "Top priority",
        data_type: "single_select",
        options: [{ name: "Yes" }, { name: "No" }],
      },
    ],
    request: async (path, method, body) => {
      writes.push({ path, method, body });
      if (path.endsWith("/issues")) {
        if (dropCreate) throw Error("unknown create outcome");
        const number = todos.length + 1;
        todos.push({
          id: `I_${number}`,
          databaseId: number,
          number,
          repository: "tasks/personal",
          url: "https://example.com",
          title: body.title,
          issueType: "Task",
          body: body.body,
          state: "open",
          closureReason: null,
          updatedAt: "now",
          labels: body.labels,
          fields: {},
          fieldValues: [],
          ...readTodoSchedule(body.body),
        });
        if (loseCreate) throw Error("connection lost");
        return { number, type: { name: "Task" } };
      }
      if (path.endsWith("/comments")) {
        if (dropComment) throw Error("Comment delivery unknown");
        const todo = todos.find(
          (t) => t.number === Number(path.split("/").at(-2)),
        )!;
        (todo.comments ??= []).push({
          id: 1,
          body: body.body,
          url: "https://example.com/comment",
          updatedAt: "now",
        });
        return {};
      }
      if (path === "/graphql") {
        if (rejectLifecycle) return { errors: [{ message: "Forbidden" }] };
        const input = body.variables.input;
        const todo = todos.find((t) => t.id === input.issueId)!;
        todo.state = input.stateReason ? "closed" : "open";
        todo.closureReason = input.stateReason?.toLowerCase() ?? "reopened";
        const target = todos.find((t) => t.id === input.duplicateIssueId);
        todo.duplicateOf = target
          ? {
              id: target.id,
              number: target.number,
              repository: target.repository,
              url: target.url,
            }
          : null;
        return { data: { issue: { id: todo.id } } };
      }
      const number = Number(path.match(/issues\/(\d+)/)?.[1]);
      const todo = todos.find((t) => t.number === number)!;
      if (path.includes("issue-field-values")) {
        if (failField) throw Error("field write unavailable");
        if (method === "DELETE") { delete todo.fields[path.endsWith("/8") ? "URL" : "Location"]; return {}; }
        for (const field of body.issue_field_values) {
          const fieldNames: Record<number, string> = {
            1: "Commitment",
            2: "Client",
            4: "Rank",
            5: "Top priority",
            6: "Location",
            7: "Due",
            8: "URL",
          };
          todo.fields[fieldNames[field.field_id] ?? "Estimate"] = field.value;
        }
      } else {
        Object.assign(todo, body);
        if (body.body !== undefined)
          Object.assign(todo, readTodoSchedule(body.body));
      }
      return {};
    },
    syncProject: async () => {
      projectCalls++;
      if (projectFailure) throw Error("project unavailable");
    },
  });
  const writer = createTodoWriter({ reader, journal, connect, checkPersonalCalendar });
  return {
    writer,
    dropComment: () => {
      dropComment = true;
    },
    rejectLifecycle: () => {
      rejectLifecycle = true;
    },
    restart: () => createTodoWriter({ reader, journal, connect, checkPersonalCalendar }),
    captureClaims: () => captureClaims,
    dropCreate: () => {
      dropCreate = true;
    },
    projectCalls: () => projectCalls,
    todos,
    writes,
    journal,
    reader,
    failFields: (v: boolean) => {
      failField = v;
    },
    loseCreate: () => {
      loseCreate = true;
    },
    failProject: (v: boolean) => {
      projectFailure = v;
    },
  };
}

test("minimal capture creates one native Task, Inbox, provenance and no execution approval; retries reconcile", async () => {
  const f = fixture();
  f.loseCreate();
  const input = { commandId: crypto.randomUUID(), title: "Call plumber" };
  const result = await f.writer("client", input);
  expect(result.outcomes.issue).toBe("saved");
  expect(result.todo?.fields).toEqual({ Commitment: "Inbox" });
  expect(f.writes[0].body).toMatchObject({
    type: "Task",
    labels: ["task", "needs-triage"],
  });
  expect(result.todo?.body).toContain("Source: client message");
  await f.writer("client", input);
  expect(f.todos).toHaveLength(1);
  await expect(
    f.writer("client", { ...input, title: "Different" }),
  ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
});

test("personal Gmail captures reconcile a lost response and preserve the private source boundary", async () => {
  const f = fixture();
  f.loseCreate();
  const personalMail = { ownerId: "owner", messageId: "mail-fixture", actionKey: "call-fixture" };
  const command = { commandId: crypto.randomUUID(), title: "Call the plumber", personalMail };
  const captured = await f.writer("personal-assistant:owner", command);
  expect(captured.outcomes.issue).toBe("saved");
  expect(captured.todo?.body).toContain("Source: Personal Gmail");
  expect(captured.todo?.body).not.toContain(personalMail.messageId);
  const replay = await f.restart()("personal-assistant:owner", command);
  expect(replay.todo?.number).toBe(captured.todo?.number!);
  expect(f.writes.filter(write => write.method === "POST" && /\/issues$/.test(write.path))).toHaveLength(1);
});

test("personal Appointments refuse a calendar collision without creating an issue on replay", async () => {
  const f = fixture();
  const start = "2026-11-18T14:00:00.000Z";
  const end = "2026-11-18T14:30:00.000Z";
  await f.writer("owner", { commandId: crypto.randomUUID(), title: "Existing event", start, end, fixed: true });
  const command = {
    commandId: crypto.randomUUID(), title: "Overlapping event", start, end, fixed: true,
    personalMail: { ownerId: "owner", messageId: "mail-fixture", actionKey: "appointment-fixture" },
  };
  await expect(f.writer("personal-assistant:owner", command)).rejects.toMatchObject({ code: "OVERLAP_REVIEW_REQUIRED" });
  await expect(f.restart()("personal-assistant:owner", command)).rejects.toMatchObject({ code: "OVERLAP_REVIEW_REQUIRED" });
  expect(f.writes.filter(write => write.method === "POST" && /\/issues$/.test(write.path))).toHaveLength(1);
});

test("concurrent personal Appointments use a fresh calendar read before the second create", async () => {
  let calendarChecks = 0;
  const f = fixture({ checkPersonalCalendar: async () => {
    calendarChecks++;
    return false;
  } });
  const start = "2026-11-18T14:00:00.000Z";
  const end = "2026-11-18T14:30:00.000Z";
  const make = (actionKey: string) => ({
    commandId: crypto.randomUUID(), title: actionKey, start, end, fixed: true,
    personalMail: { ownerId: "owner", messageId: "mail-fixture", actionKey },
  });
  const [first, second] = await Promise.allSettled([
    f.writer("personal-assistant:owner", make("first")),
    f.writer("personal-assistant:owner", make("second")),
  ]);
  expect(first).toMatchObject({ status: "fulfilled", value: { outcomes: { issue: "saved", timing: "saved" } } });
  expect(second).toMatchObject({ status: "rejected", reason: { code: "OVERLAP_REVIEW_REQUIRED" } });
  expect(calendarChecks).toBe(1);
  expect(f.todos).toHaveLength(1);
});

test("independent writers claim a personal capture at most once before GitHub", async () => {
  const f = fixture({ atomicJournal: true });
  const command = {
    commandId: crypto.randomUUID(), title: "Call the plumber",
    personalMail: { ownerId: "owner", messageId: "mail-fixture", actionKey: "call-fixture" },
  };
  const namespace = "personal-assistant:owner";
  const outcomes = await Promise.allSettled([f.writer(namespace, command), f.restart()(namespace, command)]);
  expect(outcomes.filter(item => item.status === "fulfilled")).toHaveLength(1);
  expect(outcomes.filter(item => item.status === "rejected")).toMatchObject([{ reason: { code: "CREATE_CONFLICT" } }]);
  expect(f.captureClaims()).toBe(2);
  expect((await f.restart()(namespace, command)).todo?.number).toBe(1);
  expect(f.writes.filter(write => write.method === "POST" && /\/issues$/.test(write.path))).toHaveLength(1);
});

test("partial fields retry without duplicating capture; Project failures stay separate and bounded", async () => {
  const f = fixture();
  f.failFields(true);
  f.failProject(true);
  const input = {
    commandId: crypto.randomUUID(),
    title: "Invoice",
    description: "Client owes me CAD 500; timing estimated; urgent after reply.",
    fields: { Estimate: 30 },
  };
  const first = await f.writer("client", input);
  expect(first.outcomes).toMatchObject({
    issue: "saved",
    Commitment: "uncertain",
    Estimate: "uncertain",
    project: "failed",
  });
  f.failFields(false);
  f.failProject(false);
  const second = await f.writer("client", input);
  expect(second.outcomes).toEqual({
    issue: "saved",
    type: "saved",
    Commitment: "saved",
    Estimate: "saved",
    project: "saved",
  });
  expect(second.todo?.body).toContain(input.description);
  expect(f.todos).toHaveLength(1);
});

test("edits preserve external prose, labels, unknown fields; conflicting targets are not overwritten", async () => {
  const f = fixture();
  await f.writer("client", {
    commandId: crypto.randomUUID(),
    title: "Old",
    description: "Original description",
  });
  f.todos[0].body +=
    "\nExternal note\n<!-- quantself:todo-schedule -->\nunknown block\n<!-- /quantself:todo-schedule -->";
  f.todos[0].fields.Estimate = 60;
  f.todos[0].fields.Unknown = "keep";
  f.todos[0].labels.push("external-label");
  const result = await f.writer("client", {
    commandId: crypto.randomUUID(),
    number: 1,
    title: { before: "Old", after: "New" },
    description: { before: "Original description", after: "Owes CAD 500" },
    fields: { Estimate: { before: null, after: 30 } },
  });
  expect(result.outcomes).toMatchObject({
    title: "saved",
    description: "saved",
    Estimate: "conflict",
  });
  expect(result.todo?.body).toContain("External note");
  expect(result.todo?.body).toContain("unknown block");
  expect(result.todo?.fields).toMatchObject({ Estimate: 60, Unknown: "keep" });
  expect(result.todo?.labels).toContain("external-label");
  const count = f.writes.length;
  await expect(
    f.writer("client", {
      commandId: crypto.randomUUID(),
      number: 1,
      fields: {},
    }),
  ).rejects.toThrow();
  expect(f.writes).toHaveLength(count);
});

test("undo is a narrow compensating edit and detects later target changes", async () => {
  const f = fixture();
  await f.writer("client", { commandId: crypto.randomUUID(), title: "Before" });
  await f.writer("client", {
    commandId: crypto.randomUUID(),
    number: 1,
    title: { before: "Before", after: "After" },
  });
  f.todos[0].body += "\nKeep external";
  const undo = await f.writer("client", {
    commandId: crypto.randomUUID(),
    number: 1,
    title: { before: "After", after: "Before" },
  });
  expect(undo.todo?.title).toBe("Before");
  expect(undo.todo?.body).toContain("Keep external");
});

test("uncertain absent create never re-POSTs after restart; Project retries are bounded", async () => {
  const f = fixture();
  f.dropCreate();
  const command = { commandId: crypto.randomUUID(), title: "Uncertain" };
  expect((await f.writer("client", command)).outcomes.issue).toBe("uncertain");
  expect((await f.restart()("client", command)).outcomes.issue).toBe(
    "uncertain",
  );
  expect(f.writes.filter((w) => w.path.endsWith("/issues"))).toHaveLength(1);
  const g = fixture();
  g.failProject(true);
  for (let i = 0; i < 5; i++) await g.writer("client", command);
  expect(g.projectCalls()).toBe(3);
  expect(g.todos).toHaveLength(1);
});

test("bounded phone reconciliation never blindly repeats an uncertain create", async () => {
  const { reconcilePhoneJarvisWrite } = await import("./phone-jarvis-write-retry");
  const f = fixture();
  f.dropCreate();
  const command = { commandId: crypto.randomUUID(), title: "Uncertain phone task" };
  let attempts = 0;
  const result = await reconcilePhoneJarvisWrite(async () => { attempts++; return f.writer("phone", command); });
  expect(attempts).toBe(2);
  expect(result.outcomes.issue).toBe("uncertain");
  expect(result.retryable).toBe(true);
  expect(f.writes.filter(write => write.method === "POST" && /\/issues$/.test(write.path))).toHaveLength(1);
  expect(f.todos).toHaveLength(0);
});

test("public HTTP capture, duplicate retry, description edit and partial field failure use real command behavior", async () => {
  const { createApp } = await import("./app");
  const f = fixture();
  const app = createApp({
    todos: { ...f.reader, write: f.writer },
    emitAccessLog: () => {},
    resolveAccessContext: async () => ({
      owner: { id: "owner", email: "owner@example.com", name: "Owner" },
      client: { id: "client", name: "Client", kind: "api-key" },
      permissions: ["todos:write"],
    }),
  });
  const send = async (path: string, method: string, body: unknown) => {
    const response = await app.request(path, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    return (await response.json()) as TodoWriteResult;
  };
  const command = {
    commandId: crypto.randomUUID(),
    title: "Capture",
    description: "Owes me CAD 500, estimated, urgent",
    fields: { Client: "Personal" },
  };
  expect((await send("/api/v1/todos", "POST", command)).todo?.fields).toEqual({
    Commitment: "Inbox",
    Client: "Personal",
  });
  await send("/api/v1/todos", "POST", command);
  expect(f.todos).toHaveLength(1);
  f.todos[0].body += "\nExternal note";
  f.failFields(true);
  const edit = {
    commandId: crypto.randomUUID(),
    description: {
      before: command.description,
      after: "Paid CAD 500; urgency resolved",
    },
    fields: { Estimate: { before: null, after: 30 } },
  };
  const result = await send("/api/v1/todos/1", "PATCH", edit);
  expect(result.outcomes).toMatchObject({
    description: "saved",
    Estimate: "uncertain",
  });
  expect(result.todo?.body).toContain("External note");
  f.failFields(false);
  expect((await send("/api/v1/todos/1", "PATCH", edit)).outcomes.Estimate).toBe(
    "saved",
  );
  f.todos[0].title = "External title";
  expect(
    (
      await send("/api/v1/todos/1", "PATCH", {
        commandId: crypto.randomUUID(),
        title: { before: "Capture", after: "Overwrite" },
      })
    ).outcomes.title,
  ).toBe("conflict");
});

test("capture readback reports divergence rather than claiming the issue saved correctly", async () => {
  const f = fixture();
  const detail = f.reader.detail;
  f.reader.detail = async (number) => ({
    ...(await detail(number)),
    title: "Diverged title",
  });
  const result = await f.writer("client", {
    commandId: crypto.randomUUID(),
    title: "Requested title",
  });
  expect(result.outcomes.issue).toBe("uncertain");
});

test("shortened whole descriptions save once and retries detect later divergence", async () => {
  for (const [before, after] of [
    ["Bring insurance card", "Bring"],
    ["Bring Bring", "Bring"],
    ["Bring", "Bring Bring"],
    ["Bring Bring", ""],
  ]) {
    const f = fixture();
    await f.writer("client", { commandId: crypto.randomUUID(), title: "Capture", description: before });
    const originalBody = f.todos[0].body!;
    const command = { commandId: crypto.randomUUID(), number: 1, description: { before, after } };
    const patches = () => f.writes.filter((write) => write.method === "PATCH" && write.body.body !== undefined).length;
    const result = await f.writer("client", command);
    expect(result.outcomes.description).toBe("saved");
    expect(result.todo?.description).toBe(after);
    expect(patches()).toBe(1);
    await f.restart()("client", command);
    expect(patches()).toBe(1);
    f.todos[0].body = originalBody;
    expect((await f.restart()("client", command)).outcomes.description).toBe("conflict");
    expect(patches()).toBe(1);
  }
});

test("description patches preserve partial replacement, expansion and append contracts", async () => {
  const f = fixture();
  await f.writer("client", { commandId: crypto.randomUUID(), title: "Capture", description: "Bring card to appointment" });
  for (const [before, after, expected] of [
    ["card", "insurance card", "Bring insurance card to appointment"],
    ["insurance card", "card", "Bring card to appointment"],
    ["", " tomorrow", "Bring card to appointment tomorrow"],
  ]) {
    const command = { commandId: crypto.randomUUID(), number: 1, description: { before, after } };
    const result = await f.writer("client", command);
    expect(result.outcomes.description).toBe("saved");
    expect(result.todo?.description).toBe(expected);
    const writes = f.writes.length;
    await f.restart()("client", command);
    expect(f.writes.length).toBe(writes);
  }
});

test("description patches conflict when separate old and new fragments coexist", async () => {
  const f = fixture();
  await f.writer("client", { commandId: crypto.randomUUID(), title: "Capture", description: "Old instructions; new instructions" });
  const writes = f.writes.length;
  const result = await f.writer("client", { commandId: crypto.randomUUID(), number: 1, description: { before: "Old instructions", after: "new instructions" } });
  expect(result.outcomes.description).toBe("conflict");
  expect(f.writes.length).toBe(writes);
});

test("description patches cannot target provenance or managed/unknown body data", async () => {
  const f = fixture();
  await f.writer("client", {
    commandId: crypto.randomUUID(),
    title: "Capture",
    description: "Editable prose",
  });
  f.todos[0].body +=
    '\n<!-- quantself:todo-schedule -->\n{"version":1,"unknown":"preserve"}\n<!-- /quantself:todo-schedule -->';
  for (const before of ["client message", '"unknown":"preserve"']) {
    const result = await f.writer("client", {
      commandId: crypto.randomUUID(),
      number: 1,
      description: { before, after: "overwrite" },
    });
    expect(result.outcomes.description).toBe("conflict");
  }
});

test("whole-task completion retries once, preserves commitment/timing and conflicts after external reopen", async () => {
  const f = fixture();
  await f.writer("client", {
    commandId: crypto.randomUUID(),
    title: "Multi-day",
  });
  const body = f.todos[0].body;
  const command = {
    commandId: crypto.randomUUID(),
    number: 1,
    closure: {
      before: { outcome: "open" as const },
      after: { outcome: "completed" as const },
    },
  };
  const saved = await f.writer("client", command);
  expect(saved.todo?.state).toBe("closed");
  expect(saved.todo?.closureReason).toBe("completed");
  const count = f.writes.length;
  await f.restart()("client", command);
  expect(f.writes.length).toBe(count);
  f.todos[0].state = "open";
  f.todos[0].closureReason = "reopened";
  expect((await f.writer("client", command)).outcomes.closure).toBe("conflict");
  expect(f.todos[0].body).toBe(body);
  expect(f.todos[0].fields.Commitment).toBe("Inbox");
});

test("HTTP lifecycle keeps commitment, closure reasons and duplicate targets independent; narrow undo preserves external edits", async () => {
  const { createApp } = await import("./app");
  const f = fixture();
  let permissions = ["todos:write"];
  const app = createApp({
    todos: { ...f.reader, write: f.writer },
    emitAccessLog: () => {},
    resolveAccessContext: async () => ({
      owner: { id: "owner", email: "owner@example.com", name: "Owner" },
      client: { id: "client", name: "Client", kind: "api-key" },
      permissions,
    }),
  });
  for (const title of ["Task", "Canonical"])
    await f.writer("client", { commandId: crypto.randomUUID(), title });
  const timing = { start: "2026-10-25T09:00:00-03:00", end: "2026-10-25T09:30:00-03:00", allDay: false, fixed: false };
  Object.assign(f.todos[0], timing);
  f.todos[0].labels.push("ready-for-agent");
  const originalBody = f.todos[0].body;
  const patch = async (input: object, status = 200) => {
    const response = await app.request("/api/v1/todos/1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commandId: crypto.randomUUID(), ...input }),
    });
    expect(response.status).toBe(status);
    return (await response.json()) as TodoWriteResult;
  };
  for (const [before, after] of [
    ["Inbox", "Someday"],
    ["Someday", "Active"],
  ] as const) {
    const result = await patch({ fields: { Commitment: { before, after } } });
    expect(result.todo?.state).toBe("open");
    expect(result.todo?.fields.Commitment).toBe(after);
  }
  for (const outcome of ["completed", "not_planned", "duplicate"]) {
    const after = {
      outcome,
      ...(outcome === "duplicate" ? { number: 2 } : {}),
    };
    const closed = await patch({
      closure: { before: { outcome: "open" }, after },
    });
    expect(closed.todo?.closureReason).toBe(outcome);
    expect(closed.todo?.state).toBe("closed");
    if (outcome === "duplicate")
      expect(closed.todo?.duplicateOf?.number).toBe(2);
    f.todos[0].title = "External title";
    const reopened = await patch({
      closure: { before: after, after: { outcome: "open" } },
    });
    expect(reopened.todo?.state).toBe("open");
    expect(reopened.todo?.title).toBe("External title");
    expect(reopened.todo?.fields.Commitment).toBe("Active");
    expect(reopened.todo).toMatchObject(timing);
    expect(reopened.todo?.body).toBe(originalBody);
    expect(reopened.todo?.labels).toContain("ready-for-agent");
  }
  const count = f.writes.length;
  await patch(
    {
      closure: {
        before: { outcome: "open" },
        after: { outcome: "duplicate", number: 1 },
      },
    },
    400,
  );
  expect(f.writes).toHaveLength(count);
  permissions = ["todos:read"];
  await patch(
    {
      closure: { before: { outcome: "open" }, after: { outcome: "completed" } },
    },
    403,
  );
  permissions = ["todos:approve"];
  await patch(
    { fields: { Commitment: { before: "Active", after: "Someday" } } },
    403,
  );
  expect(f.writes).toHaveLength(count);
});

test("rejected lifecycle writes never project completion; duplicate chains and non-repository targets rejected", async () => {
  const f = fixture();
  for (const title of ["Task", "Canonical"])
    await f.writer("client", { commandId: crypto.randomUUID(), title });
  const originalDetail = f.reader.detail;
  f.rejectLifecycle();
  const command = {
    commandId: crypto.randomUUID(),
    number: 1,
    closure: {
      before: { outcome: "open" as const },
      after: { outcome: "completed" as const },
    },
  };
  const result = await f.writer("client", command);
  expect(result.outcomes.closure).toBe("uncertain");
  expect(result.todo?.state).toBe("open");
  f.reader.detail = originalDetail;
  const duplicate = {
    commandId: crypto.randomUUID(),
    number: 1,
    closure: {
      before: { outcome: "open" as const },
      after: { outcome: "duplicate" as const, number: 2 },
    },
  };
  f.todos[1].closureReason = "duplicate";
  await expect(f.writer("client", duplicate)).rejects.toMatchObject({
    code: "INVALID_DUPLICATE",
  });
  f.todos[1].closureReason = null;
  f.todos[1].repository = "other/repo";
  await expect(f.writer("client", duplicate)).rejects.toMatchObject({
    code: "INVALID_DUPLICATE",
  });
});

test("ambiguous lifecycle receipt reconciles without repeating a transition after a later reopen", async () => {
  const f = fixture();
  await f.writer("client", { commandId: crypto.randomUUID(), title: "Task" });
  const originalDetail = f.reader.detail;
  f.reader.detail = async (number) => {
    const todo = await originalDetail(number);
    if (todo.state === "closed") throw Error("Readback lost");
    return todo;
  };
  const command = {
    commandId: crypto.randomUUID(),
    number: 1,
    closure: {
      before: { outcome: "open" as const },
      after: { outcome: "completed" as const },
    },
  };
  expect((await f.writer("client", command)).outcomes.closure).toBe(
    "uncertain",
  );
  f.todos[0].state = "open";
  f.todos[0].closureReason = "reopened";
  const count = f.writes.length;
  expect((await f.restart()("client", command)).outcomes.closure).toBe(
    "uncertain",
  );
  expect(f.writes.length).toBe(count);
  expect(f.todos[0].state).toBe("open");
});

test("current rank and priority are independent editable facts", async () => {
  const { todoEditSchema } = await import("./todos-write");
  expect(
    todoEditSchema.safeParse({
      commandId: crypto.randomUUID(),
      fields: {
        Rank: { before: null, after: 2 },
        "Top priority": { before: null, after: "Yes" },
      },
    }).success,
  ).toBe(true);
});

test("HTTP priority limit, excess reconciliation, stale rank, partial failure and retry preserve task facts", async () => {
  const f = fixture();
  for (let i = 0; i < 4; i++)
    await f.writer("client", {
      commandId: crypto.randomUUID(),
      title: `Task ${i}`,
    });
  const { createApp } = await import("./app");
  const app = createApp({
    todos: { ...f.reader, write: f.writer },
    emitAccessLog: () => {},
    resolveAccessContext: async () => ({
      owner: { id: "owner", email: "owner@example.com", name: "Owner" },
      client: { id: "client", name: "Client", kind: "api-key" },
      permissions: ["todos:read", "todos:write"],
    }),
  });
  const patch = async (
    number: number,
    fields: unknown,
    commandId = crypto.randomUUID(),
  ) => {
    const response = await app.request(`/api/v1/todos/${number}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commandId, fields }),
    });
    expect(response.status).toBe(200);
    return (await response.json()) as TodoWriteResult;
  };
  for (const todo of f.todos.slice(0, 3)) todo.fields["Top priority"] = "Yes";
  expect(
    (await patch(4, { "Top priority": { before: null, after: "Yes" } }))
      .outcomes["Top priority"],
  ).toBe("conflict");
  f.todos[3].fields["Top priority"] = "Yes"; // external excess: retain until explicit reconciliation
  expect(
    (await patch(1, { "Top priority": { before: "Yes", after: "No" } }))
      .outcomes["Top priority"],
  ).toBe("saved");
  expect(
    f.todos.filter((t) => t.fields["Top priority"] === "Yes"),
  ).toHaveLength(3);
  const body = f.todos[0].body;
  expect(
    (await patch(1, { Rank: { before: 99, after: 1 } })).outcomes.Rank,
  ).toBe("conflict");
  expect(
    (await patch(1, { Rank: { before: null, after: 2 } })).outcomes.Rank,
  ).toBe("saved");
  f.failFields(true);
  const id = crypto.randomUUID();
  expect(
    (await patch(2, { Rank: { before: null, after: 1 } }, id)).outcomes.Rank,
  ).toBe("uncertain");
  f.failFields(false);
  expect(
    (await patch(2, { Rank: { before: null, after: 1 } }, id)).outcomes.Rank,
  ).toBe("saved");
  expect(f.todos[0].body).toBe(body);
  expect(f.todos[0].fields.Commitment).toBe("Inbox");
  f.todos[0].fields.Rank = 8;
  expect(
    (await patch(1, { Rank: { before: 2, after: null } })).outcomes.Rank,
  ).toBe("conflict");
});

const range = { start: "2026-10-27T18:00:00-03:00", end: "2026-10-27T22:00:00-03:00", allDay: false, fixed: false };
test("create saves task and range in one issue POST; replay and move retain identity", async () => {
  const f = fixture();
  const create = { commandId: crypto.randomUUID(), title: "Work", description: "Owner prose", ...range };
  const saved = await f.writer("client", create);
  expect(saved.outcomes).toMatchObject({ issue: "saved", timing: "saved" });
  expect(saved.todo).toMatchObject(range);
  expect(f.writes.filter(w => w.path.endsWith("/issues") && w.method === "POST")).toHaveLength(1);
  expect(f.writes.filter(w => w.method === "PATCH" && w.body.body !== undefined)).toHaveLength(0);
  const count = f.writes.length;
  await f.restart()("client", create);
  expect(f.writes).toHaveLength(count);
  f.todos[0].body = f.todos[0].body!.replace('"version": 2', '"extension": {"keep":true}, "version": 2') + "\nExternal prose";
  const command = { commandId: crypto.randomUUID(), number: 1, revision: f.todos[0].updatedAt, ...range, end: "2026-10-28T02:00:00-03:00" };
  const moved = await f.writer("client", command);
  expect(moved.outcomes.timing).toBe("saved");
  expect(moved.todo?.id).toBe(saved.todo?.id);
  expect(moved.todo?.body).toContain('"extension"');
  expect(moved.todo?.body).toEndWith("\nExternal prose");
  expect(f.todos).toHaveLength(1);
  const clear = await f.writer("client", { number: 1, commandId: crypto.randomUUID(), revision: f.todos[0].updatedAt, start: null, end: null, fixed: false, allDay: false });
  expect(clear.todo).toMatchObject({ start: null, end: null, state: "open" });
});
test("timing rejects null partial bounds, old session commands and stale edits", async () => {
  const { todoCreateSchema, todoEditSchema } = await import("./todos-write");
  for (const extra of [{ start: null }, { ...range, end: range.start }, { ...range, start: null }, { start: null, end: null, fixed: true }, { sessions: [] }])
    expect(todoCreateSchema.safeParse({ commandId: crypto.randomUUID(), title: "Invalid", ...extra }).success).toBe(false);
  expect(todoEditSchema.safeParse({ commandId: crypto.randomUUID(), ...range }).success).toBe(false);
  const f = fixture();
  await f.writer("client", { commandId: crypto.randomUUID(), title: "Work", ...range });
  const count = f.writes.length;
  expect((await f.writer("client", { commandId: crypto.randomUUID(), number: 1, revision: "stale", ...range, end: "2026-10-28T01:00:00-03:00" })).outcomes.timing).toBe("conflict");
  expect(f.writes).toHaveLength(count);
  expect(f.todos[0]).toMatchObject(range);
});
test("HTTP range survives reload, midnight/DST filtering and task closure", async () => {
  const { createApp } = await import("./app");
  const f = fixture();
  const app = createApp({ emitAccessLog: () => {}, todos: { ...f.reader, write: f.writer }, resolveAccessContext: async () => ({ owner: { id: "o", email: "o@example.com", name: "Owner" }, client: { id: "c", name: "Client", kind: "api-key" }, permissions: ["todos:read", "todos:write"] }) });
  const send = async (path: string, method = "GET", body?: object) => { const response = await app.request(`/api/v1/todos${path}`, { method, ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) }); return { status: response.status, body: await response.json() as any }; };
  const timing = { start: "2026-10-31T23:30:00-03:00", end: "2026-11-01T02:00:00-04:00" };
  expect((await send("", "POST", { commandId: crypto.randomUUID(), title: "Overnight", ...timing })).body.todo).toMatchObject(timing);
  expect((await send("/1")).body.todo).toMatchObject(timing);
  for (const day of ["2026-10-31", "2026-11-01"]) expect((await send(`?from=${day}&through=${day}`)).body.todos).toHaveLength(1);
  expect((await send("?from=2026-11-02&through=2026-11-02")).body.todos).toHaveLength(0);
  expect((await send("?from=2026-11-01")).status).toBe(400);
  await send("/1", "PATCH", { commandId: crypto.randomUUID(), closure: { before: { outcome: "open" }, after: { outcome: "completed" } } });
  expect((await send("/1")).body.todo).toMatchObject({ ...timing, state: "closed" });
  expect(f.todos).toHaveLength(1);
});
test("invalid legacy data and oversized writes retain source", async () => {
  const f = fixture();
  await f.writer("client", { commandId: crypto.randomUUID(), title: "Source" });
  for (const body of ["x".repeat(65536), "<!-- quantself:todo-schedule -->invalid"]) {
    f.todos[0].body = body;
    const saved = await f.writer("client", { commandId: crypto.randomUUID(), number: 1, revision: f.todos[0].updatedAt, ...range });
    expect(saved.outcomes.timing).not.toBe("saved");
    expect(f.todos[0].body).toBe(body);
  }
});

test("ordinary HTTP editor prepares a complete Agent Brief comment without granting execution; retries preserve one brief", async () => {
  const f = fixture();
  await f.writer("editor", {
    commandId: crypto.randomUUID(),
    title: "Research",
  });
  const { createApp } = await import("./app");
  const app = createApp({
    todos: { ...f.reader, write: f.writer },
    emitAccessLog: () => {},
    resolveAccessContext: async () => ({
      owner: { id: "owner", email: "o@example.com", name: "Owner" },
      client: { id: "editor", name: "Editor", kind: "api-key" },
      permissions: ["todos:write"],
    }),
  });
  const agentBrief = {
    goal: "Compare options",
    inputs: "Owner notes",
    output: "Summary in issue",
    constraints: "No messages or spending",
    doneWhen: "Three options documented",
  };
  const command = { commandId: crypto.randomUUID(), agentBrief };
  for (let i = 0; i < 2; i++) {
    const response = await app.request("/api/v1/todos/1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(command),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      outcomes: { agentBrief: "saved" },
    });
  }
  expect(f.todos[0].comments).toHaveLength(1);
  for (const value of Object.values(agentBrief))
    expect(f.todos[0].comments![0].body).toContain(value);
  expect(f.todos[0].labels).toEqual(["task", "needs-triage"]);
});

test("conversational commands retain one source comment across replay without changing executor labels", async () => {
  const f = fixture();
  const command = {
    commandId: crypto.randomUUID(),
    title: "Call plumber",
    provenance: {
      captureId: crypto.randomUUID(),
      conversationId: "conv_1",
      operationId: "tool_1",
      capturedAt: "2026-10-26T12:00:00Z",
    },
  };
  const first = await f.writer("voice", command);
  expect(first.outcomes.provenance).toBe("saved");
  const again = await f.writer("voice", command);
  expect(again.todo?.number).toBe(first.todo?.number);
  expect(f.writes.filter((w) => w.path.endsWith("/comments"))).toHaveLength(1);
  expect(again.todo?.comments?.[0].body).toContain(
    `Capture ID: ${command.provenance.captureId}`,
  );
  expect(again.todo?.labels).toEqual(["task", "needs-triage"]);
});

test("Jarvis HTTP commands reuse shared writes, preserve one-to-many provenance and expose partial/conflicting delivery", async () => {
  const { OpenAPIHono } = await import("@hono/zod-openapi");
  const { registerJarvisRoutes } = await import("./todos-jarvis-route");
  const { createCaptureService } = await import("./todos-captures");
  const { TodoWriteError } = await import("./todos-write");
  const f = fixture();
  const id = crypto.randomUUID();
  const rows = new Map<string, any>();
  const store = {
    async get(key: string) {
      return rows.get(key) ?? null;
    },
    async reserve(key: string, input: unknown) {
      const prior = rows.get(key);
      if (prior && JSON.stringify(prior.input) !== JSON.stringify(input))
        throw new TodoWriteError("CAPTURE_CONFLICT", "Operation already used.");
      if (!prior) rows.set(key, { input, result: null });
      return rows.get(key);
    },
    async save(key: string, result: unknown) {
      rows.get(key).result = result;
    },
    async list(prefix: string) {
      return [...rows].filter(([k]) => k.startsWith(prefix)).map(([, v]) => v);
    },
  };
  let permissions = ["todos:read", "todos:write"];
  let userId = id;
  let clientKind: "web" | "api-key" = "api-key";
  const app = new OpenAPIHono<any>();
  app.use("*", async (c, next) => {
    c.set("accessContext", {
      owner: { id: "owner", email: "owner@example.com", name: "Owner" },
      client: { id: "voice", name: "Jarvis", kind: clientKind },
      permissions,
    });
    await next();
  });
  let beforeWrite: (() => Promise<void>) | null = null;
  let failWrite = false;
  const reader = {
    ...f.reader,
    write: async (...args: Parameters<typeof f.writer>) => {
      if (beforeWrite) await beforeWrite();
      if (failWrite) throw Error("GitHub rejected the task.");
      return f.writer(...args);
    },
  };
  registerJarvisRoutes(app, reader, {
    store,
    provider: {
      agentId: () => "agent",
      temporaryAccess: async () => "unused",
      finalConversation: async (conversationId) => ({
        agentId: "agent",
        userId,
        conversationId,
        capturedAt: "2026-10-26T12:00:00Z",
        done: false,
        conversation: [],
      }),
      audio: async () => {
        throw Error("not ready");
      },
    },
  });
  await store.reserve(`jarvis:${id}`, { owner: "owner", id });
  const send = async (
    command: unknown,
    intent = "requested",
    conversationId = "conv_1",
  ) =>
    app.request(`/api/v1/todo-jarvis/${id}/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationId, intent, command }),
    });
  const command = { commandId: "f6a7b8c9-6666-4f06-9g06-000000000001", title: "Voice capture" };
  expect((await send(command, "suggested")).status).toBe(409);
  expect((await send(command, "ambiguous")).status).toBe(409);
  permissions = ["todos:read", "todos:approve"];
  expect((await send(command)).status).toBe(403);
  expect(f.todos).toHaveLength(0);
  permissions = ["todos:read", "todos:write"];
  userId = crypto.randomUUID();
  expect((await send(command)).status).toBe(409);
  userId = id;
  f.failProject(true);
  const first = await send(command);
  expect(first.status).toBe(200);
  expect(await first.json()).toMatchObject({
    outcomes: { issue: "saved", project: "failed", provenance: "saved" },
    retryable: true,
  });
  f.failProject(false);
  expect(await (await send(JSON.stringify(command))).json()).toMatchObject({
    outcomes: { issue: "saved", project: "saved", provenance: "saved" },
  });
  expect(f.todos).toHaveLength(1);
  expect((await send({ ...command, title: "Changed input" })).status).toBe(409);
  const second = { commandId: crypto.randomUUID(), title: "Second task" };
  const phone = await import("./phone-jarvis-conversations");
  const authenticated = spyOn(phone, "isAuthenticatedPhoneCapture").mockResolvedValue(true);
  const active = spyOn(phone, "isActiveAuthenticatedPhoneCapture").mockResolvedValue(true);
  await store.reserve(`phone-jarvis:${id}`, { sessionId: "phone-session", agentId: "agent" });
  const attempted: Parameters<typeof f.writer>[1][] = [];
  f.failProject(true);
  beforeWrite = async () => { if (attempted.length === 2) f.failProject(false); };
  const originalWrite = reader.write;
  reader.write = async (...args) => { attempted.push(args[1]); return originalWrite(...args); };
  try {
    const reconciled = await send(JSON.stringify(second), "reviewed");
    expect(reconciled.status).toBe(200);
    expect(await reconciled.json()).toMatchObject({ outcomes: { issue: "saved", project: "saved", provenance: "saved" }, retryable: false });
    expect(attempted).toHaveLength(2);
    expect(attempted[0]).toBe(attempted[1]);
    expect(attempted[0]!.commandId).toBe(second.commandId);
    expect(f.todos).toHaveLength(2);
    expect(f.writes.filter(write => write.method === "POST" && /\/issues$/.test(write.path))).toHaveLength(2);
  } finally {
    reader.write = originalWrite;
    beforeWrite = null;
    rows.delete(`phone-jarvis:${id}`);
    authenticated.mockRestore(); active.mockRestore();
  }
  const patch = {
    commandId: crypto.randomUUID(),
    number: 1,
    title: { before: "Voice capture", after: "Renamed" },
    fields: {
      Rank: { before: null, after: 2 },
      "Top priority": { before: null, after: "Yes" },
    },
  };
  expect(await (await send(patch)).json()).toMatchObject({
    outcomes: { title: "saved", Rank: "saved", "Top priority": "saved" },
  });
  const schedule = { commandId: crypto.randomUUID(), number: 1, revision: "now", ...range, fixed: true };
  const { revision: _revision, ...missingRevision } = schedule;
  const writesBeforeInvalidSession = f.writes.length;
  expect((await send(JSON.stringify(missingRevision))).status).toBe(400);
  expect(f.writes).toHaveLength(writesBeforeInvalidSession);
  expect(await store.get(`jarvis-command:${id}:${schedule.commandId}`)).toBeNull();
  // A pre-write validation rejection can be corrected with the same operation ID.
  expect(await (await send(JSON.stringify(schedule))).json()).toMatchObject({
    outcomes: { timing: "saved" },
  });
  expect(await (await send(schedule)).json()).toMatchObject({
    outcomes: { timing: "saved" },
  });
  expect(f.todos[0]).toMatchObject({ ...range, fixed: true });
  for (const invalid of ["{broken", "[]", JSON.stringify({ ...schedule, labels: ["agent:implement"] })]) {
    expect((await send(invalid)).status).toBe(400);
  }
  for (const todo of f.todos) {
    todo.blockedBy = [];
    todo.children = [];
  }
  const close = {
    commandId: crypto.randomUUID(),
    number: 1,
    closure: { before: { outcome: "open" }, after: { outcome: "completed" } },
    relationships: [
      { kind: "blockedBy", number: 2, before: false, after: false },
    ],
  };
  expect(await (await send(close)).json()).toMatchObject({
    outcomes: { closure: "saved", "blockedBy:2": "saved" },
  });
  expect(f.todos[0]).toMatchObject({ ...range, fixed: true });
  expect(f.todos[0].labels).toEqual(["task", "needs-triage"]);
  expect(
    (
      await send({
        ...patch,
        commandId: crypto.randomUUID(),
        labels: ["agent:implement"],
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await send({
        ...patch,
        commandId: crypto.randomUUID(),
        intent: "execute",
        confirmed: true,
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await send(
        { ...second, commandId: crypto.randomUUID() },
        "requested",
        "other-conversation",
      )
    ).status,
  ).toBe(409);
  const captures = createCaptureService(store, reader);
  await captures.create({
    id,
    source: "jarvis",
    capturedAt: "2026-10-26T12:00:00Z",
    transcript: "Two task instructions",
  });
  const archive = await captures.read(id);
  expect(archive.links.map((l) => l.number)).toEqual([1, 2, 1, 1, 1]);
  expect(archive.links.every((l) => l.status === "linked")).toBe(true);
  const outcomesPath = `/api/v1/todo-jarvis/${id}/commands`;
  expect((await app.request(outcomesPath)).status).toBe(403);
  clientKind = "web";
  const receiptResponse = await app.request(outcomesPath);
  expect(receiptResponse.status).toBe(200);
  expect(receiptResponse.headers.get("cache-control")).toContain("no-store");
  expect(await receiptResponse.json()).toMatchObject({
    commands: [
      { number: 1 },
      { number: 2 },
      { number: 1 },
      { number: 1 },
      { number: 1 },
    ],
  });
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  beforeWrite = async () => {
    started();
    await gate;
  };
  failWrite = true;
  const pendingCommand = {
    commandId: crypto.randomUUID(),
    title: "Pending then rejected",
  };
  clientKind = "api-key";
  const writing = send(pendingCommand);
  await entered;
  clientKind = "web";
  const pendingRows = (await (await app.request(outcomesPath)).json()) as {
    commands: unknown[];
  };
  expect(pendingRows.commands.at(-1)).toMatchObject({
    state: "pending",
    create: pendingCommand,
  });
  release();
  expect((await writing).status).toBe(503);
  const failedRows = (await (await app.request(outcomesPath)).json()) as {
    commands: unknown[];
  };
  expect(failedRows.commands.at(-1)).toMatchObject({
    state: "failed",
    create: pendingCommand,
    outcomes: { delivery: "failed" },
  });
  beforeWrite = null;
  failWrite = false;
  permissions = [];
  expect((await app.request(outcomesPath)).status).toBe(403);
  expect((await send(second)).status).toBe(403);
  await store.reserve(`deleted:${id}`, { id });
  permissions = ["todos:write"];
  expect((await send(second)).status).toBe(409);
});

test("uncertain source comment delivery is never blindly repeated", async () => {
  const f = fixture();
  f.dropComment();
  const command = {
    commandId: crypto.randomUUID(),
    title: "Voice task",
    provenance: {
      captureId: crypto.randomUUID(),
      conversationId: "conv_1",
      operationId: "tool_1",
      capturedAt: "2026-10-26T12:00:00Z",
    },
  };
  expect((await f.writer("voice", command)).outcomes.provenance).toBe(
    "uncertain",
  );
  expect((await f.restart()("voice", command)).outcomes.provenance).toBe(
    "uncertain",
  );
  expect(f.todos).toHaveLength(1);
  expect(f.writes.filter((w) => w.path.endsWith("/comments"))).toHaveLength(1);
});

test("reviewed advice applies through ordinary HTTP permissions, conflicts and partial writer outcomes", async () => {
  const { createApp } = await import("./app");
  const f = fixture();
  const created = await f.writer("client", {
    commandId: crypto.randomUUID(),
    title: "Client commitment",
    fields: { Estimate: 30 },
  });
  const todo = created.todo!;
  let permissions = ["todos:read"];
  const app = createApp({
    emitAccessLog: () => {},
    todos: { ...f.reader, write: f.writer },
    resolveAccessContext: async () => ({
      owner: { id: "owner", email: "owner@example.com", name: "Owner" },
      client: { id: "client", name: "AI", kind: "api-key" },
      permissions,
    }),
  });
  const proposal = {
    number: todo.number,
    revision: todo.updatedAt,
    reason: "Allow enough time for client work",
    command: {
      commandId: crypto.randomUUID(),
      fields: { Estimate: { before: 30, after: 45 } },
    },
  };
  const send = (path: string, method: string, body: unknown) =>
    app.request(path, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const before = f.writes.length;
  expect(
    (await send("/api/v1/todo-suggestions/review", "POST", proposal)).status,
  ).toBe(200);
  expect(f.writes.length).toBe(before);
  const path = `/api/v1/todos/${todo.number}`;
  expect((await send(path, "PATCH", proposal.command)).status).toBe(403);
  permissions = ["todos:read", "todos:write"];
  f.todos[0].fields.Estimate = 35;
  expect(
    await (
      await send("/api/v1/todo-suggestions/review", "POST", proposal)
    ).json(),
  ).toMatchObject({ stale: true });
  expect(
    await (await send(path, "PATCH", proposal.command)).json(),
  ).toMatchObject({ outcomes: { Estimate: "conflict" } });
  const fresh = {
    commandId: crypto.randomUUID(),
    fields: { Estimate: { before: 35, after: 45 } },
  };
  f.failFields(true);
  expect(await (await send(path, "PATCH", fresh)).json()).toMatchObject({
    outcomes: { Estimate: "uncertain" },
  });
  f.failFields(false);
  expect(await (await send(path, "PATCH", fresh)).json()).toMatchObject({
    outcomes: { Estimate: "saved" },
  });
  expect(f.todos[0].fields.Estimate).toBe(45);
});

test("relative shift preserves mixed-offset duration and never shifts twice on retry", async () => {
  const f = fixture();
  await f.writer("client", { commandId: crypto.randomUUID(), title: "Shopping", start: "2026-10-27T17:30:00-03:00", end: "2026-10-27T20:40:00.000Z" });
  const command = { commandId: crypto.randomUUID(), number: 1, revision: f.todos[0].updatedAt, shiftMinutes: 30 };
  const saved = await f.writer("client", command);
  expect(saved.outcomes.timing).toBe("saved");
  expect(Date.parse(saved.todo!.start!)).toBe(Date.parse("2026-10-27T18:00:00-03:00"));
  expect(Date.parse(saved.todo!.end!)).toBe(Date.parse("2026-10-27T18:10:00-03:00"));
  expect(Date.parse(saved.todo!.end!) - Date.parse(saved.todo!.start!)).toBe(10 * 60000);
  const count = f.writes.length;
  const retried = await f.restart()("client", command);
  expect(retried.todo?.start).toBe(saved.todo?.start);
  expect(retried.todo?.end).toBe(saved.todo?.end);
  expect(f.writes).toHaveLength(count);
});

test("relative timing edits reject contradictory bounds and stale revisions without writing", async () => {
  const { todoEditSchema, todoCreateSchema } = await import("./todos-write");
  const base = { commandId: crypto.randomUUID(), revision: "now", shiftMinutes: 30 };
  expect(todoEditSchema.safeParse(base).success).toBe(true);
  for (const extra of [{ start: null }, { end: range.end }, { fixed: true }, { allDay: false }, { shiftMinutes: 0 }, { revision: undefined }])
    expect(todoEditSchema.safeParse({ ...base, ...extra }).success).toBe(false);
  expect(todoCreateSchema.safeParse({ commandId: base.commandId, title: "Invalid", shiftMinutes: 30 }).success).toBe(false);
  const f = fixture();
  await f.writer("client", { commandId: crypto.randomUUID(), title: "Shopping", ...range });
  const count = f.writes.length;
  const result = await f.writer("client", { ...base, number: 1, revision: "stale" });
  expect(result.outcomes.timing).toBe("conflict");
  expect(f.writes).toHaveLength(count);
  expect(f.todos[0]).toMatchObject(range);
});

test("description and location round-trip independently, detect conflicts and replay without duplicate writes", async () => {
  const f = fixture();
  const create = { commandId: crypto.randomUUID(), title: "Dentist", description: "Bring insurance card", fields: { Location: "123 Main Street" }, start: "2026-11-02T09:00:00-04:00", end: "2026-11-02T10:00:00-04:00" };
  const created = await f.writer("owner", create);
  expect(created.todo).toMatchObject({ description: create.description, fields: { Location: create.fields.Location }, start: create.start });
  const creationWrites = f.writes.filter(w => w.method === "POST" && w.path.endsWith("/issues"));
  expect(creationWrites).toHaveLength(1);
  const command = { commandId: crypto.randomUUID(), number: 1, description: { before: create.description, after: "Bring updated insurance" }, fields: { Location: { before: create.fields.Location, after: "456 Other Street" } } };
  const result = await f.writer("owner", command);
  expect(result.outcomes).toMatchObject({ description: "saved", Location: "saved" });
  expect(result.todo).toMatchObject({ description: command.description.after, fields: { Location: command.fields.Location.after }, start: create.start, end: create.end });
  expect(result.todo?.body).toContain("Source: client message");
  expect(result.todo?.body).not.toContain("quantself:todo-location");
  expect(f.writes.filter(w => w.path.endsWith("issue-field-values") && w.method === "POST")).toHaveLength(2);
  const count = f.writes.length;
  expect((await f.writer("owner", command)).outcomes).toMatchObject({ description: "saved", Location: "saved" });
  expect(f.writes.length).toBe(count);
  const conflict = await f.writer("owner", { ...command, commandId: crypto.randomUUID(), fields: { Location: { before: create.fields.Location, after: "Wrong address" } } });
  expect(conflict.outcomes.Location).toBe("conflict");
  const cleared = await f.writer("owner", { commandId: crypto.randomUUID(), number: 1, description: { before: command.description.after, after: "" }, fields: { Location: { before: command.fields.Location.after, after: null } } });
  expect(cleared.todo).toMatchObject({ description: "", fields: {}, start: create.start });
  expect(cleared.outcomes).toMatchObject({ description: "saved", Location: "saved" });
});


test("prep-only edits preserve event bounds, replay once, conflict on stale revision and remove cleanly", async () => {
  const f = fixture();
  await f.writer("client", { commandId: crypto.randomUUID(), title: "Appointment", ...range });
  const command = { commandId: crypto.randomUUID(), number: 1, revision: f.todos[0].updatedAt, beforeMinutes: 10, afterMinutes: 5 };
  const result = await f.writer("client", command);
  expect(result.outcomes.timing).toBe("saved");
  expect(result.todo).toMatchObject({ ...range, beforeMinutes: 10, afterMinutes: 5 });
  const writes = f.writes.length;
  await f.restart()("client", command);
  expect(f.writes.length).toBe(writes);
  const stale = await f.writer("client", { ...command, commandId: crypto.randomUUID(), revision: "stale", beforeMinutes: 20 });
  expect(stale.outcomes.timing).toBe("conflict");
  const cleared = await f.writer("client", { commandId: crypto.randomUUID(), number: 1, revision: f.todos[0].updatedAt, beforeMinutes: 0 });
  expect(cleared.outcomes.timing).toBe("saved");
  expect(cleared.todo).toMatchObject(range);
  expect(cleared.todo?.beforeMinutes ?? 0).toBe(0);
  expect(cleared.todo?.afterMinutes).toBe(5);
});

test("lone timing bounds seed thirty minutes while scheduled partial edits retain the opposite bound", async () => {
  const f = fixture();
  const created = await f.writer("client", { commandId: crypto.randomUUID(), title: "Start only", start: "2026-10-31T23:45:00-03:00" });
  expect(created.todo?.end).toBe("2026-11-01T03:15:00.000Z");
  const endOnly = await f.writer("client", { commandId: crypto.randomUUID(), title: "End only", end: "2026-11-01T01:15:00-04:00" });
  expect(endOnly.todo?.start).toBe("2026-11-01T04:45:00.000Z");
  const edit = await f.writer("client", { commandId: crypto.randomUUID(), number: 1, revision: created.todo!.updatedAt, start: "2026-10-31T23:50:00-03:00" });
  expect(edit.todo?.end).toBe(created.todo?.end);
  const before = f.writes.length;
  await expect(f.writer("client", { commandId: crypto.randomUUID(), number: 1, revision: edit.todo!.updatedAt, start: "2026-11-02T01:00:00-04:00" })).rejects.toMatchObject({ code: "INVALID_TIMING" });
  expect(f.writes).toHaveLength(before);
});

test("timed deadlines preserve scheduling and detect external date changes", async () => {
  const f = fixture();
  const at = "2026-11-02T17:00:00-04:00";
  const created = await f.writer("client", { commandId: crypto.randomUUID(), title: "Application", fields: { Due: "2026-11-02" }, deadlineAt: at, ...range });
  expect(created.outcomes.deadlineAt).toBe("saved");
  expect(created.todo).toMatchObject({ deadlineAt: at, ...range });
  const body = created.todo!.body;
  f.todos[0].fields.Due = "2026-11-03";
  const changed = await f.reader.detail(1);
  expect(changed.deadlineAt).toBeNull();
  expect(changed.deadlineError).toContain("changed outside");
  expect(changed.body).toBe(body);
  const repaired = await f.writer("client", { commandId: crypto.randomUUID(), number: 1, revision: changed.updatedAt, deadlineAt: { before: null, after: "2026-11-03T17:00:00-04:00" } });
  expect(repaired.outcomes.deadlineAt).toBe("saved");
  expect(repaired.todo).toMatchObject({ deadlineAt: "2026-11-03T17:00:00-04:00", deadlineError: null, ...range });
  const stale = await f.writer("client", { commandId: crypto.randomUUID(), number: 1, revision: "old", deadlineAt: { before: repaired.todo!.deadlineAt!, after: null } });
  expect(stale.outcomes.deadlineAt).toBe("conflict");
});

test("Due and deadline edit together, retry once, and explicit clear removes stale metadata", async () => {
  const f = fixture();
  const created = await f.writer("client", { commandId: crypto.randomUUID(), title: "Deadline", fields: { Due: "2026-11-02" }, deadlineAt: "2026-11-02T17:00:00-04:00" });
  const command = { commandId: crypto.randomUUID(), number: 1, revision: created.todo!.updatedAt, fields: { Due: { before: "2026-11-02", after: "2026-11-03" } }, deadlineAt: { before: created.todo!.deadlineAt!, after: "2026-11-03T18:00:00-04:00" } };
  const result = await f.writer("client", command);
  expect(result.outcomes).toMatchObject({ Due: "saved", deadlineAt: "saved" });
  expect(result.todo?.deadlineAt).toBe(command.deadlineAt.after);
  const writes = f.writes.length;
  await f.restart()("client", command);
  expect(f.writes).toHaveLength(writes);
  f.todos[0].fields.Due = "2026-11-04";
  const cleared = await f.writer("client", { commandId: crypto.randomUUID(), number: 1, revision: f.todos[0].updatedAt, deadlineAt: { before: null, after: null } });
  expect(cleared.outcomes.deadlineAt).toBe("saved");
  expect(cleared.todo?.body).not.toContain("quantself:deadline");
  expect(cleared.todo?.deadlineError).toBeNull();
});


test("URL text rows round-trip, replay, conflict independently and clear", async () => {
  const f = fixture();
  const original = "example.com/path\nplain text\nhttps://example.org";
  const created = await f.writer("owner", { commandId: crypto.randomUUID(), title: "Research", fields: { URL: original } });
  expect(created.todo?.fields.URL).toBe(original);
  const updated = "https://example.com/path\nnot a URL";
  const command = { commandId: crypto.randomUUID(), number: 1, fields: { URL: { before: original, after: updated } } };
  const saved = await f.writer("owner", command);
  expect(saved.outcomes.URL).toBe("saved");
  expect(saved.todo?.fields.URL).toBe(updated);
  const count = f.writes.length;
  await f.restart()("owner", command);
  expect(f.writes).toHaveLength(count);
  const partial = await f.writer("owner", { commandId: crypto.randomUUID(), number: 1, fields: { URL: { before: original, after: "stale" }, Location: { before: null, after: "Office" } } });
  expect(partial.outcomes).toMatchObject({ URL: "conflict", Location: "saved" });
  expect(partial.todo?.fields.URL).toBe(updated);
  const cleared = await f.writer("owner", { commandId: crypto.randomUUID(), number: 1, fields: { URL: { before: updated, after: null } } });
  expect(cleared.outcomes.URL).toBe("saved");
  expect(cleared.todo?.fields.URL).toBeUndefined();
  expect(cleared.todo?.fields.Location).toBe("Office");
});
