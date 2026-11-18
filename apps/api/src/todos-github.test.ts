import { expect, test } from "bun:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import { createTodoGitHub, canonicalTodoFields } from "./todos-github";
import { categorySnapshot } from "./todos-categories";
import { approvalRevision } from "./todos-approval";

const key = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();
const env = {
  QUANTSELF_TODO_REPOSITORY: "tasks/personal",
  QUANTSELF_TODO_TEST_REPOSITORY: "tasks/test",
  QUANTSELF_GITHUB_APP_ID: "12",
  QUANTSELF_GITHUB_INSTALLATION_ID: "34",
  QUANTSELF_GITHUB_PRIVATE_KEY: key,
  QUANTSELF_TODO_PROJECT_NUMBER: "1",
};
const definitions = Object.entries(canonicalTodoFields).map(
  ([name, spec], index) => ({
    id: index + 1,
    name,
    data_type: spec.type,
    options: spec.options?.map((name, id) => ({ id, name })),
  }),
);
const page = (nodes: any[], endCursor: string | null = null) => ({
  nodes,
  pageInfo: { hasNextPage: endCursor !== null, endCursor },
});
function issue(number: number): any {
  return {
    id: `I_${number}`,
    databaseId: number + 100,
    number,
    title: `Task ${number}`,
    body: "Original prose",
    state: "OPEN",
    stateReason: null,
    updatedAt: "2026-10-26T10:00:00Z",
    url: `https://github.com/tasks/personal/issues/${number}`,
    repository: { nameWithOwner: "tasks/personal" },
    issueType: { name: "Task" },
    duplicateOf: null,
    blockedBy: page([]),
    subIssues: page([]),
    parent: null,
    labels: page([{ name: "ready-for-human" }]),
    issueFieldValues: page([]),
    comments: page([]),
  };
}
function field(id: number, value: string | number | null, name?: string): any {
  const definition = definitions.find((d) => d.id === id);
  const kind = definition?.data_type ?? "text";
  return {
    field: {
      fullDatabaseId: String(id),
      name: definition?.name ?? "Unknown",
      dataType: kind.toUpperCase(),
    },
    ...(kind === "number" ? { numberValue: value } : { value }),
    ...(kind === "single_select" ? { name: name ?? value } : {}),
  };
}
function fixture() {
  let now = Date.now();
  const issues = [issue(1), issue(2)];
  const calls: { path: string; body: any; method: string }[] = [];
  const receipts = new Map<string, any>();
  let hook:
    | ((
        call: (typeof calls)[number],
      ) => Response | undefined | Promise<Response | undefined>)
    | undefined;
  const fetcher: NonNullable<
    Parameters<typeof createTodoGitHub>[0]
  >["fetch"] = async (input, init) => {
    const call = {
      path: new URL(String(input)).pathname,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      method: init?.method ?? "GET",
    };
    calls.push(call);
    expect(new Headers(init?.headers).get("authorization")).toMatch(/^Bearer /);
    const override = await hook?.(call);
    if (override) return override;
    const { path, body, method } = call;
    if (path === "/app") return Response.json({ id: 12 });
    if (path === "/app/installations/34")
      return Response.json({
        app_id: 12,
        account: { login: "tasks" },
        repository_selection: "selected",
        permissions: { issue_fields: "write" },
      });
    if (path.endsWith("/access_tokens")) {
      expect(body.repositories).toEqual(["personal"]);
      expect(body.permissions).toEqual({
        issues: body.permissions.issues,
        issue_fields: "read",
        metadata: "read",
        ...(body.permissions.issues === "write"
          ? { organization_projects: "write" }
          : {}),
      });
      return Response.json({
        token: "test",
        expires_at: new Date(now + 3600000).toISOString(),
      });
    }
    if (path === "/installation/repositories")
      return Response.json({
        total_count: 1,
        repositories: [{ full_name: "tasks/personal", private: true }],
      });
    if (path === "/orgs/tasks/issue-fields") return Response.json(definitions);
    if (path === "/graphql") {
      const { query, variables } = body;
      if (query.includes("query TodoTask("))
        return Response.json({
          data: {
            repository: {
              issue: issues.find((i) => i.number === variables.number) ?? null,
            },
          },
        });
      if (query.includes("query TodoCollection("))
        return Response.json({
          data: { repository: { issues: page(issues) } },
        });
      if (query.includes("query TodoAssignments("))
        return Response.json({
          data: { nodes: variables.ids.map((id: string) => issues.find(issue => issue.id === id) ?? null) },
        });
      if (query.includes("organization(login"))
        return Response.json({
          data: {
            organization: {
              projectV2: { id: "P_1", title: "Me", public: false },
            },
          },
        });
      if (query.includes("addProjectV2ItemById"))
        return Response.json({
          data: {
            addProjectV2ItemById: { item: { id: `PI_${variables.content}` } },
          },
        });
      if (query.includes("ProjectV2Item"))
        return Response.json({
          data: {
            node: {
              project: { id: "P_1" },
              content: { id: variables.id.slice(3) },
            },
          },
        });
      if (query.includes("Issue(input:")) {
        const task = issues.find((i) => i.id === variables.input.issueId)!;
        task.state = variables.input.stateReason ? "CLOSED" : "OPEN";
        task.stateReason = variables.input.stateReason ?? "REOPENED";
        task.duplicateOf =
          issues.find((i) => i.id === variables.input.duplicateIssueId) ?? null;
        return Response.json({ data: { issue: { id: task.id } } });
      }
      throw Error(`Unexpected query: ${query}`);
    }
    if (path === "/repos/tasks/personal/issues" && method === "POST") {
      const task = {
        ...issue(issues.length + 1),
        title: body.title,
        body: body.body,
        labels: page(body.labels.map((name: string) => ({ name }))),
      };
      expect(body.type).toBe("Task");
      issues.push(task);
      return Response.json({ number: task.number, type: { name: "Task" } });
    }
    const task = issues.find(
      (i) => i.number === Number(path.match(/issues\/(\d+)/)?.[1]),
    );
    if (task && path.includes("issue-field-values")) {
      const updates =
        method === "DELETE"
          ? [{ field_id: Number(path.split("/").at(-1)), value: null }]
          : body.issue_field_values;
      for (const update of updates) {
        task.issueFieldValues.nodes = task.issueFieldValues.nodes.filter(
          (f: any) => Number(f.field.fullDatabaseId) !== update.field_id,
        );
        if (update.value !== null)
          task.issueFieldValues.nodes.push(
            field(update.field_id, update.value),
          );
      }
      return Response.json({});
    }
    if (task && method === "PATCH") {
      Object.assign(task, body);
      return Response.json({});
    }
    throw Error(`Unexpected endpoint ${method} ${path}`);
  };
  const options = {
    env,
    fetch: fetcher,
    now: () => now,
    journal: {
      reserve: async (key: string, hash: string) => {
        if (receipts.has(key)) return { ...receipts.get(key), fresh: false };
        const receipt = { hash, state: { done: {} } };
        receipts.set(key, receipt);
        return { ...receipt, fresh: true };
      },
      save: async (key: string, state: any) => {
        receipts.get(key).state = structuredClone(state);
      },
    },
  };
  return {
    issues,
    receipts,
    calls,
    options,
    adapter: createTodoGitHub(options),
    hook: (fn: NonNullable<typeof hook>) => {
      hook = fn;
    },
    advance: () => {
      now += 11000;
    },
    now: () => now,
  };
}

test("configuration validates before fetch, including field IDs/types and selected repository scope", async () => {
  await expect(
    createTodoGitHub({
      env: {},
      fetch: async () => {
        throw Error("must not fetch");
      },
    }).list(),
  ).rejects.toMatchObject({ code: "TODO_CONFIGURATION_ERROR" });
  for (const [path, response] of [
    ["/app", { id: 999 }],
    ["/installation/repositories", { total_count: 2, repositories: [] }],
    ["/orgs/tasks/issue-fields", definitions.map((f) => ({ ...f, id: 1 }))],
    ["/orgs/tasks/issue-fields", [{ ...definitions[0], data_type: "text" }]],
  ] as const) {
    const f = fixture();
    f.hook((call) =>
      call.path === path ? Response.json(response) : undefined,
    );
    await expect(f.adapter.list()).rejects.toMatchObject({
      code: "TODO_CONFIGURATION_ERROR",
    });
    expect(f.calls.some((c) => c.path === "/graphql")).toBe(false);
  }
});

test("calendar/list reads batch many tasks in one request; concurrent reads coalesce, later reads are fresh", async () => {
  const f = fixture();
  f.issues.push(...Array.from({ length: 30 }, (_, n) => issue(n + 3)));
  f.issues[0].issueFieldValues = page([field(1, "Active")]);
  const [first, second] = await Promise.all([
    f.adapter.list(),
    f.adapter.list(),
  ]);
  expect(first).toEqual(second);
  expect(first).toHaveLength(32);
  expect(first[0]).toMatchObject({
    id: "I_1",
    body: "Original prose",
    description: "Original prose",
    fields: { Commitment: "Active" },
    labels: ["ready-for-human"],
  });
  expect(f.calls.filter((c) => c.path === "/graphql")).toHaveLength(1);
  expect(f.calls.find((c) => c.path === "/graphql")!.body.query).not.toContain(
    "comments(",
  );
  f.calls.length = 0;
  f.issues[0].title = "Fresh title";
  expect((await f.adapter.list()).find((t) => t.number === 1)?.title).toBe(
    "Fresh title",
  );
  expect(f.calls).toHaveLength(1);
});

test("normal detail uses two independent queries and preserves the existing global approval revision", async () => {
  const f = fixture();
  f.issues[0].body = "Appointment notes";
  f.issues[0].issueFieldValues = page([field(definitions.find(d => d.name === "Location")!.id, "Office"), field(definitions.find(d => d.name === "URL")!.id, "example.com\nReference text")]);
  f.issues[0].blockedBy = page([f.issues[1]]);
  f.issues[1].state = "CLOSED";
  f.issues[1].stateReason = "COMPLETED";
  await f.adapter.list();
  f.calls.length = 0;
  // Both queries must start before either is allowed to complete.
  let started = 0,
    release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.hook(async (c) => {
    if (c.path === "/graphql") {
      if (++started === 2) release();
      await gate;
    }
    return undefined;
  });
  const detail = await f.adapter.detail(1);
  expect(f.calls).toHaveLength(2);
  expect(detail).toMatchObject({ description: "Appointment notes", fields: { Location: "Office", URL: "example.com\nReference text" } });
  expect(detail.readiness).toBe("ready");
  expect(detail.prerequisiteStates).toEqual([
    { id: "I_2", number: 2, state: "closed", closureReason: "completed" },
  ]);
  const checkQuery = f.calls.find((c) =>
    c.body?.query?.includes("TodoCollection"),
  )!.body.query;
  expect(checkQuery).not.toContain("issueFieldValues");
  expect(checkQuery).not.toContain("comments(");
  f.hook(() => undefined);
  expect(detail.approvalRevision).toBe(
    approvalRevision(detail, await f.adapter.list()),
  );
});

test("Agent task reads hydrate only requested IDs, with no repository scan or relationship query", async () => {
  const f = fixture();
  const reader = f.adapter;
  await reader.list();
  f.calls.length = 0;
  expect(await reader.assignedList!([])).toEqual([]);
  expect(f.calls).toHaveLength(0);
  const tasks = await reader.assignedList!(["I_2", "I_missing"]);
  expect(tasks.map(todo => todo.id)).toEqual(["I_2"]);
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0].body.variables).toEqual({ ids: ["I_2", "I_missing"] });
  expect(f.calls[0].body.query).not.toMatch(/TodoCollection|blockedBy|subIssues|comments\(/);

  f.calls.length = 0;
  expect((await reader.assignedDetail!(2)).id).toBe("I_2");
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0].body.query).toContain("comments(");
  expect(f.calls[0].body.query).not.toMatch(/TodoCollection|blockedBy|subIssues/);

  f.calls.length = 0;
  await reader.assignedDetail!(2, false);
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0].body.query).not.toMatch(/comments\(|issueFieldValues/);
});

test("paginates repository and nested collections in batches without losing blockers or comments", async () => {
  const f = fixture();
  f.issues[0].blockedBy = page([], "blockers-next");
  f.issues[0].comments = page([], "comments-next");
  f.hook((c) => {
    const query = c.body?.query ?? "";
    if (query.includes("TodoCollection"))
      return Response.json({
        data: {
          repository: {
            issues: c.body.variables.cursor
              ? page([f.issues[1]])
              : page([f.issues[0]], "tasks-next"),
          },
        },
      });
    if (query.includes("TodoConnectionPages")) {
      const data: Record<string, unknown> = {};
      for (const [key, cursor] of Object.entries(c.body.variables)) {
        if (!key.startsWith("cursor")) continue;
        data[`p${key.slice(6)}`] =
          cursor === "blockers-next"
            ? { blockedBy: page([f.issues[1]]) }
            : {
                comments: page([
                  {
                    databaseId: 1,
                    body: "Agent Brief",
                    url: "https://example.com/comment",
                    updatedAt: "now",
                  },
                ]),
              };
      }
      return Response.json({ data });
    }
    return undefined;
  });
  const detail = await f.adapter.detail(1);
  expect(detail.readiness).toBe("blocked");
  expect(detail.comments).toHaveLength(1);
  const pages = f.calls.filter((c) =>
    c.body?.query?.includes("TodoConnectionPages"),
  );
  expect(pages.some((c) => Object.keys(c.body.variables).length === 4)).toBe(
    true,
  );
});

test("partial GraphQL errors, null connections and stuck pagination fail closed", async () => {
  for (const response of [
    {
      data: { repository: { issues: page([issue(1)]) } },
      errors: [{ message: "Unavailable relationship" }],
    },
    {
      data: {
        repository: { issues: page([{ ...issue(1), blockedBy: null }]) },
      },
    },
    { data: { repository: { issues: page([issue(1)], "same-cursor") } } },
  ]) {
    const f = fixture();
    f.hook((c) =>
      c.path === "/graphql" ? Response.json(response) : undefined,
    );
    await expect(f.adapter.list()).rejects.toMatchObject({
      code: "TODO_UNAVAILABLE",
    });
  }
});

test("duplicate completion, external blockers, trashed prerequisites and hierarchy retain semantics", async () => {
  const f = fixture();
  const target = issue(3);
  target.state = "CLOSED";
  target.stateReason = "COMPLETED";
  f.issues.push(target);
  f.issues[0].blockedBy = page([f.issues[1]]);
  f.issues[0].parent = target;
  f.issues[0].subIssues = page([f.issues[1]]);
  f.issues[1].state = "CLOSED";
  f.issues[1].stateReason = "DUPLICATE";
  f.issues[1].duplicateOf = target;
  expect((await f.adapter.detail(1)).readiness).toBe("ready");
  target.body = '<!-- quantself:trash {"version":1,"reopen":false} -->';
  expect((await f.adapter.detail(1)).readiness).toBe("blocked");
  target.body = "Original prose";
  target.stateReason = "NOT_PLANNED";
  expect((await f.adapter.detail(1)).readiness).toBe("blocked");
  // Use a reference without circular JSON to represent a duplicate cycle.
  f.issues[1].duplicateOf = { ...issue(2), duplicateOf: null };
  expect((await f.adapter.detail(1)).readiness).toBe("blocked");
  f.issues[0].blockedBy = page([
    { ...issue(77), repository: { nameWithOwner: "external/private" } },
  ]);
  expect(await f.adapter.detail(1)).toMatchObject({
    readiness: "blocked",
    blockedBy: [{ repository: "external/private" }],
    parent: { number: 3 },
    children: [{ number: 2 }],
  });
});

test("typed fields, unknown fields, rank order and missing values survive GraphQL normalization", async () => {
  const f = fixture();
  f.issues[0].issueFieldValues = page([
    field(5, null),
    field(8, 2),
    field(999, "unknown"),
  ]);
  f.issues[1].issueFieldValues = page([field(8, 1)]);
  const tasks = await f.adapter.list();
  expect(tasks.map((t) => t.number)).toEqual([2, 1]);
  expect(tasks[1].fields).toEqual({ Estimate: null, Rank: 2 });
  expect(tasks[1].fieldValues.at(-1)).toMatchObject({
    issue_field_id: 999,
    value: "unknown",
  });
  f.issues[1].issueFieldValues = page([field(8, "invalid number")]);
  await expect(f.adapter.list()).rejects.toMatchObject({
    code: "TODO_CONFIGURATION_ERROR",
  });
});

test("rate limits prevent further requests and recover; missing issues retain not-found semantics", async () => {
  const f = fixture();
  await f.adapter.list();
  f.hook((c) =>
    c.path === "/graphql"
      ? Response.json(
          {},
          {
            status: 403,
            headers: {
              "x-ratelimit-remaining": "0",
              "x-ratelimit-reset": String(Math.ceil((f.now() + 10000) / 1000)),
            },
          },
        )
      : undefined,
  );
  await expect(f.adapter.list()).rejects.toMatchObject({
    code: "TODO_UNAVAILABLE",
  });
  const count = f.calls.length;
  await expect(f.adapter.list()).rejects.toMatchObject({
    code: "TODO_UNAVAILABLE",
  });
  expect(f.calls).toHaveLength(count);
  f.advance();
  f.hook(() => undefined);
  expect(await f.adapter.list()).toHaveLength(2);
  await expect(f.adapter.detail(404)).rejects.toMatchObject({
    code: "TODO_NOT_FOUND",
  });
  f.hook((c) =>
    c.body?.query?.includes("TodoTask")
      ? Response.json({
          data: { repository: { issue: null } },
          errors: [{ type: "NOT_FOUND", path: ["repository", "issue"] }],
        })
      : undefined,
  );
  await expect(f.adapter.detail(404)).rejects.toMatchObject({
    code: "TODO_NOT_FOUND",
  });
});

test("public HTTP reads use bulk adapter and return no-store plus outage errors", async () => {
  const { createApp } = await import("./app");
  const f = fixture();
  const app = createApp({
    emitAccessLog: () => {},
    todos: f.adapter,
    resolveAccessContext: async () => ({
      owner: { id: "owner", name: "Owner", email: "owner@example.com" },
      client: { id: "reader", name: "Reader", kind: "api-key" },
      permissions: ["todos:read"],
    }),
  });
  const first = await app.request("/api/v1/todos");
  expect(first.status).toBe(200);
  expect(first.headers.get("cache-control")).toContain("no-store");
  expect(((await first.json()) as { todos: unknown[] }).todos).toHaveLength(2);
  expect((await app.request("/api/v1/todos/1")).status).toBe(200);
  f.hook((c) =>
    c.path === "/graphql"
      ? Response.json({}, { status: 503, headers: { "retry-after": "10" } })
      : undefined,
  );
  expect((await app.request("/api/v1/todos")).status).toBe(503);
  f.advance();
  f.hook(() => undefined);
  expect((await app.request("/api/v1/todos")).status).toBe(200);
});

test("create batches fields, scans only capture facts, verifies private project and edits without collection reads", async () => {
  const f = fixture();
  const created = await f.adapter.write!("client", {
    commandId: crypto.randomUUID(),
    title: "New",
    fields: { Estimate: 30, Category: "Work" },
  });
  expect(created.outcomes).toEqual({
    issue: "saved",
    type: "saved",
    Commitment: "saved",
    Estimate: "saved",
    Category: "saved",
    project: "saved",
  });
  expect(
    f.calls.filter((c) => c.body?.query?.includes("TodoCollection")),
  ).toHaveLength(1);
  const posts = f.calls.filter(
    (c) => c.path.endsWith("issue-field-values") && c.method === "POST",
  );
  expect(posts).toHaveLength(1);
  expect(posts[0].body.issue_field_values).toHaveLength(3);
  f.calls.length = 0;
  const edited = await f.adapter.write!("client", {
    commandId: crypto.randomUUID(),
    number: 3,
    fields: {
      Estimate: { before: 30, after: null },
      Category: { before: "Work", after: "Home" },
    },
  });
  expect(edited.outcomes).toEqual({
    issue: "saved",
    Estimate: "saved",
    Category: "saved",
  });
  expect(
    f.calls.filter((c) => c.body?.query?.includes("TodoCollection")),
  ).toHaveLength(0);
  expect(
    f.calls.filter((c) => c.body?.query?.includes("TodoTask")),
  ).toHaveLength(3);
  expect(edited.todo?.fields.Commitment).toBe("Inbox");
});

test("native lifecycle GraphQL reads preserve completion and duplicate targets across retries", async () => {
  const f = fixture();
  for (const outcome of ["completed", "not_planned", "duplicate"] as const) {
    const after =
      outcome === "duplicate" ? { outcome, number: 2 } : { outcome };
    const command = {
      commandId: crypto.randomUUID(),
      number: 1,
      closure: { before: { outcome: "open" as const }, after },
    };
    const result = await f.adapter.write!("client", command);
    expect(result.outcomes.closure).toBe("saved");
    expect(result.todo?.closureReason).toBe(outcome);
    if (outcome === "duplicate")
      expect(result.todo?.duplicateOf?.number).toBe(2);
    await f.adapter.write!("client", command);
    expect(
      f.calls.filter(
        (c) => c.body?.variables?.input?.stateReason === outcome.toUpperCase(),
      ),
    ).toHaveLength(1);
    expect(
      (
        await f.adapter.write!("client", {
          commandId: crypto.randomUUID(),
          number: 1,
          closure: { before: after, after: { outcome: "open" } },
        })
      ).outcomes.closure,
    ).toBe("saved");
  }
});

test("bulk fields preserve conflicts and reconcile partial or lost responses without resending saved fields", async () => {
  const f = fixture();
  f.issues[0].issueFieldValues = page([
    field(1, "Inbox"),
    field(3, "Work"),
    field(5, 10),
  ]);
  let first = true;
  f.hook((c) => {
    if (first && c.path.endsWith("issue-field-values") && c.method === "POST") {
      first = false;
      expect(c.body.issue_field_values).toEqual([
        { field_id: 5, value: 30 },
        { field_id: 1, value: "Active" },
      ]);
      f.issues[0].issueFieldValues.nodes = [
        field(1, "Inbox"),
        field(3, "Work"),
        field(5, 30),
      ];
      return Response.json({}, { status: 503 });
    }
    return undefined;
  });
  const command = {
    commandId: crypto.randomUUID(),
    number: 1,
    fields: {
      Estimate: { before: 10, after: 30 },
      Commitment: { before: "Inbox", after: "Active" },
      Category: { before: "Home", after: "Health" },
    },
  } as const;
  expect((await f.adapter.write!("client", command)).outcomes).toEqual({
    issue: "saved",
    Category: "conflict",
    Estimate: "saved",
    Commitment: "uncertain",
  });
  f.calls.length = 0;
  expect((await f.adapter.write!("client", command)).outcomes).toEqual({
    issue: "saved",
    Category: "conflict",
    Estimate: "saved",
    Commitment: "saved",
  });
  expect(
    f.calls.find((c) => c.path.endsWith("issue-field-values"))!.body
      .issue_field_values,
  ).toEqual([{ field_id: 1, value: "Active" }]);
});

test("write-purpose scans select only required collections", async () => {
  const f = fixture();
  for (const purpose of ["capture", "relationships", "priority"] as const) {
    await f.adapter.list(purpose);
    const query = f.calls.at(-1)!.body.query;
    expect(query).not.toContain("comments(");
    expect(query).not.toContain("labels(");
    expect(query.includes("issueFieldValues(")).toBe(purpose === "priority");
    expect(query.includes("blockedBy(")).toBe(purpose === "relationships");
  }
});

test("category management preserves IDs, blocks used categories and reconciles lost responses", async () => {
  const f = fixture();
  const customDefinitions = structuredClone(definitions);
  const area = customDefinitions.find(field => field.name === "Category")!;
  area.options = [{ id: 10, name: "Work", color: "blue", description: "Preserve", priority: 1 }, { id: 20, name: "Garden", color: "green", priority: 2 }] as any;
  let patches = 0, loseResponse = false;
  f.hook(call => {
    if (call.path.endsWith("access_tokens") && call.body.permissions.issue_fields === "write") {
      expect(call.body.repositories).toEqual(["personal"]);
      return Response.json({ token: "categories", expires_at: new Date(f.now() + 3600000).toISOString() });
    }
    if (call.path === "/orgs/tasks/issue-fields") return Response.json(customDefinitions);
    if (call.path === `/orgs/tasks/issue-fields/${area.id}` && call.method === "PATCH") {
      patches++;
      area.options = call.body.options.map((option: any) => ({ ...option, id: option.id ?? 30 }));
      if (loseResponse) { loseResponse = false; throw Error("Response lost after commit"); }
      return Response.json(area);
    }
  });
  let categories = f.adapter.categories!;
  const initial = await categories.list();
  expect(initial.categories.map(c => c.name)).toEqual(["Work", "Garden"]);
  const warmStart = f.calls.length;
  const started = performance.now();
  await categories.list();
  expect(f.calls.slice(warmStart)).toHaveLength(1);
  console.log(`Category metadata warm read: 1 GitHub request, ${(performance.now() - started).toFixed(2)}ms mocked transport; cold setup ${warmStart} requests.`);
  loseResponse = true;
  const create = { commandId: crypto.randomUUID(), revision: initial.revision, action: "create" as const, name: "Fitness", color: "pink" as const };
  await expect(categories.write("owner", create)).rejects.toThrow();
  categories = createTodoGitHub(f.options).categories!; // Restart: durable receipt still reconciles the committed option.
  const created = await categories.write("owner", create);
  expect(patches).toBe(1);
  expect(created.categories.find(c => c.name === "Fitness")?.id).toBe(30);
  expect(created.categories.find(c => c.id === 10)).toMatchObject({ name: "Work", description: "Preserve", color: "blue" });
  const renamed = await categories.write("owner", { commandId: crypto.randomUUID(), revision: created.revision, action: "update", id: 30, name: "Exercise", color: "purple" });
  expect(renamed.categories.find(c => c.id === 30)?.name).toBe("Exercise");
  f.issues[0].state = "CLOSED";
  f.issues[0].issueFieldValues = page([field(area.id, 30, "Exercise")]);
  const deletion = { commandId: crypto.randomUUID(), revision: renamed.revision, action: "delete" as const, id: 30 };
  await expect(categories.write("owner", deletion)).rejects.toThrow("Move all tasks");
  expect(patches).toBe(2);
  f.issues[0].issueFieldValues = page([]);
  expect((await categories.write("owner", deletion)).categories.some(c => c.id === 30)).toBe(false);
  expect(patches).toBe(3);
  await expect(categories.write("owner", { ...create, name: "Changed payload" })).rejects.toThrow("original category command");
});

test("read-only Issue Fields access preserves colors and rejects category edits before any write", async () => {
  const f = fixture();
  f.hook(call => {
    if (call.path === "/app/installations/34") return Response.json({ app_id: 12, account: { login: "tasks" }, repository_selection: "selected", permissions: { issue_fields: "read" } });
  });
  const initial = await f.adapter.categories!.list();
  const command = { commandId: crypto.randomUUID(), revision: initial.revision, action: "update" as const, id: initial.categories[0].id, name: initial.categories[0].name, color: "green" as const };
  await expect(f.adapter.categories!.write("owner", command)).rejects.toMatchObject({ status: 403, code: "TODO_CATEGORY_PERMISSION" });
  expect(f.calls.some(c => c.method === "PATCH")).toBe(false);
  expect(f.calls.some(c => c.body?.permissions?.issue_fields === "write")).toBe(false);
  expect((await f.adapter.categories!.list()).categories).toEqual(initial.categories);
  await expect(f.adapter.categories!.write("owner", { ...command, commandId: crypto.randomUUID() })).rejects.toMatchObject({ status: 403 });
});

test("permission denial is distinguished from transient/rate-limit failure for cache purging", async () => {
  const f = fixture(); await f.adapter.list();
  f.hook(call => call.path === "/graphql" ? Response.json({ message: "Resource not accessible by integration" }, { status: 403 }) : undefined);
  await expect(f.adapter.list()).rejects.toMatchObject({ code: "TODO_ACCESS_DENIED" });
  f.hook(call => call.path === "/graphql" ? Response.json({ data: null, errors: [{ type: "FORBIDDEN" }] }) : undefined);
  await expect(f.adapter.list()).rejects.toMatchObject({ code: "TODO_ACCESS_DENIED" });
});

test.each(["Area", "Category"])("%s GitHub field retains identity while public reads/writes use Category", async sourceName => {
  const f = fixture();
  const category = definitions.find(d => d.name === "Category")!;
  f.hook(call => call.path === "/orgs/tasks/issue-fields"
    ? Response.json(definitions.map(d => d.id === category.id ? { ...d, name: sourceName } : d))
    : undefined);
  f.issues[0].issueFieldValues = page([field(category.id, 0, "Work")]);
  const before = await f.adapter.detail(1);
  expect(before.fields.Category).toBe("Work");
  expect(before.fields).not.toHaveProperty("Area");
  expect(before.categoryId).toBe(category.options!.find(o => o.name === "Work")!.id);
  const result = await f.adapter.write!("owner", {
    commandId: crypto.randomUUID(), number: 1,
    fields: { Category: { before: "Work", after: "Home" } },
  });
  expect(result.outcomes.Category).toBe("saved");
  expect(result.outcomes).not.toHaveProperty("Area");
  expect(result.todo!.fields.Category).toBe("Home");
  const updates = f.calls.filter(call => call.path.endsWith("/issue-field-values") && call.method === "POST");
  expect(updates.at(-1)!.body.issue_field_values).toEqual([{ field_id: category.id, value: "Home" }]);
  expect(f.calls.some(call => call.path.includes("/issue-fields/") && call.method !== "GET")).toBe(false);
});

test("canonical Category wins over a separate legacy Area field", async () => {
  const f = fixture();
  const category = definitions.find(d => d.name === "Category")!;
  f.hook(call => call.path === "/orgs/tasks/issue-fields"
    ? Response.json([...definitions, { ...category, id: 999, name: "Area" }]) : undefined);
  const legacyValue = { ...field(category.id, 0, "Work"), field: { fullDatabaseId: "999", name: "Area", dataType: "SINGLE_SELECT" } };
  f.issues[0].issueFieldValues = page([field(category.id, 1, "Home"), legacyValue]);
  expect((await f.adapter.detail(1)).fields).toEqual({ Category: "Home" });
  expect((await f.adapter.categories!.list()).revision).toBe(categorySnapshot({ ...category, options: category.options!.map(o => ({ ...o, color: "gray" })) }).revision);
});


test("legacy completed receipt reconciles canonical command without repeating a later-changed field", async () => {
  const f = fixture();
  const category = definitions.find(d => d.name === "Category")!;
  const commandId = crypto.randomUUID();
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  const key = digest(`tasks/personal:owner:${commandId}`);
  // Historical fingerprints sort every object key recursively.
  const legacyPayload = { commandId, fields: { Area: { after: "Home", before: "Work" } }, number: 1 };
  f.receipts.set(key, { hash: digest(JSON.stringify(legacyPayload)), state: { done: { Area: true } } });
  f.issues[0].issueFieldValues = page([field(category.id, 0, "Work")]); // External edit restored the original before value.
  const result = await f.adapter.write!("owner", { commandId, number: 1, fields: { Category: { before: "Work", after: "Home" } } });
  expect(result.outcomes.Category).toBe("conflict");
  expect(result.outcomes).not.toHaveProperty("Area");
  expect(f.calls.some(call => call.path.endsWith("/issue-field-values") && call.method === "POST")).toBe(false);
  await expect(f.adapter.write!("owner", { commandId, number: 1, fields: { Category: { before: "Work", after: "Health" } } })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
});

test("legacy HTTP Area commands normalize before validation; mixed names fail and OpenAPI stays Category", async () => {
  const { createApp } = await import("./app");
  const f = fixture();
  const app = createApp({ emitAccessLog: () => {}, todos: f.adapter,
    resolveAccessContext: async () => ({
      owner: { id: "owner", name: "Owner", email: "owner@example.com" },
      client: { id: "writer", name: "Writer", kind: "api-key" },
      permissions: ["todos:read", "todos:write"],
    }),
  });
  const commandId = crypto.randomUUID();
  const request = (body: unknown) => app.request("/api/v1/todos/1", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const response = await request({ commandId, fields: { Area: { before: null, after: "Work" } } });
  expect(response.status).toBe(200);
  const result: any = await response.json();
  expect(result.outcomes.Category).toBe("saved");
  expect(result.outcomes).not.toHaveProperty("Area");
  expect(result.todo.fields).toHaveProperty("Category", "Work");
  expect(result.todo.fields).not.toHaveProperty("Area");
  const replay = await request({ commandId, fields: { Category: { before: null, after: "Work" } } });
  expect(replay.status).toBe(200);
  expect((await replay.json() as any).outcomes.Category).toBe("saved");
  expect(f.calls.filter(call => call.path.endsWith("/issue-field-values") && call.method === "POST")).toHaveLength(1);
  const mixed = await request({ commandId: crypto.randomUUID(), fields: { Area: { before: "Work", after: "Home" }, Category: { before: "Work", after: "Health" } } });
  expect(mixed.status).toBe(400);
  const created = await app.request("/api/v1/todos", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ commandId: crypto.randomUUID(), title: "Legacy capture", fields: { Area: "Home" } }) });
  expect(created.status).toBe(200);
  expect((await created.json() as any).todo.fields.Category).toBe("Home");
  const document: any = await (await app.request("/api/openapi.json")).json();
  for (const name of ["TodoCreate", "TodoEdit"]) {
    const properties = document.components.schemas[name].properties.fields.properties;
    expect(properties).toHaveProperty("Category");
    expect(properties).not.toHaveProperty("Area");
  }
});


test("URL rollout permits absent definitions for reads and unrelated writes, rejects URL writes explicitly", async () => {
  const f = fixture();
  f.hook(call => call.path === "/orgs/tasks/issue-fields" ? Response.json(definitions.filter(field => field.name !== "URL")) : undefined);
  expect(await f.adapter.list()).toHaveLength(2);
  expect((await f.adapter.detail(1)).number).toBe(1);
  const created = await f.adapter.write!("client", { commandId: crypto.randomUUID(), title: "Existing capture" });
  expect(created.todo?.title).toBe("Existing capture");
  const edited = await f.adapter.write!("client", { commandId: crypto.randomUUID(), number: 1, fields: { Location: { before: null, after: "Office" } } });
  expect(edited.outcomes.Location).toBe("saved");
  for (const command of [
    { commandId: crypto.randomUUID(), title: "URL capture", fields: { URL: "example.com" } },
    { commandId: crypto.randomUUID(), number: 1, fields: { URL: { before: null, after: "example.com" } } },
  ]) {
    const writes = f.calls.filter(call => call.method !== "GET" && !call.path.endsWith("access_tokens") && call.path !== "/graphql").length;
    await expect(f.adapter.write!("client", command)).rejects.toMatchObject({ code: "INVALID_FIELD", message: "Unknown option or field: URL." });
    expect(f.calls.filter(call => call.method !== "GET" && !call.path.endsWith("access_tokens") && call.path !== "/graphql")).toHaveLength(writes);
  }
});

test("present URL definitions require a unique text field", async () => {
  const url = definitions.find(field => field.name === "URL")!;
  for (const invalid of [
    definitions.map(field => field.name === "URL" ? { ...field, data_type: "number" } : field),
    [...definitions, { ...url, id: 999 }],
  ]) {
    const f = fixture();
    f.hook(call => call.path === "/orgs/tasks/issue-fields" ? Response.json(invalid) : undefined);
    await expect(f.adapter.list()).rejects.toThrow("Canonical organization field mismatch: URL");
  }
});
