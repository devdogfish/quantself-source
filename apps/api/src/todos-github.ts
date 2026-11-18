import { todoDeadlineAtSchema, readTodoDeadline } from "./todos-deadline";
import { CategoryPermissionError, categorySchema, categorySnapshot, changedCategories, type CategoryService } from "./todos-categories";
import { TodoWriteError } from "./todos-write";
import { readTaskDescription } from "./todos-description";
import {
  approvalRevision,
  createTodoApprover,
  type TodoApproval,
} from "./todos-approval";
import { createTaskQueries, type TaskProjection } from "./todos-graphql";
import { deriveReadiness } from "./todos-relationships";
import { readTodoTrash } from "./todos-trash";
import {
  localDate,
  todoInstantSchema,
  readTodoSchedule,
  taskTimingSummary,
} from "./todos-schedule";
export { readTodoSchedule } from "./todos-schedule";
import {
  createTodoWriter,
  type TodoWriter,
  type CommandJournal,
  todoCommandJournal,
  type TodoWriteResult,
} from "./todos-write";
import { createHash, createPrivateKey, sign } from "node:crypto";
import { z } from "@hono/zod-openapi";
import { todoDelegationSchema } from "./todo-delegation";

export const canonicalTodoFields: Record<
  string,
  { type: string; options?: string[] }
> = {
  Commitment: {
    type: "single_select",
    options: ["Inbox", "Active", "Someday"],
  },
  Client: { type: "single_select", options: ["Personal"] },
  Category: {
    type: "single_select",
    options: ["Work", "School", "Home", "Health", "Admin"],
  },
  Due: { type: "date" },
  Estimate: { type: "number" },
  "Cost of waiting": {
    type: "single_select",
    options: ["Low", "Medium", "High"],
  },
  "Waiting since": { type: "date" },
  Rank: { type: "number" },
  "Top priority": { type: "single_select", options: ["Yes", "No"] },
  Location: { type: "text" },
  URL: { type: "text" },
};

export const todoReferenceSchema = z.object({
  id: z.string(),
  databaseId: z.number(),
  number: z.number().int(),
  repository: z.string(),
  url: z.string(),
  title: z.string(),
});
export const todoSchema = z
  .object({
    id: z.string(),
    databaseId: z.number(),
    repository: z.string(),
    number: z.number().int(),
    url: z.string(),
    title: z.string(),
    categoryId: z.number().nullable().optional(),
    issueType: z.string().nullable().optional(),
    body: z.string().nullable(),
    description: z.string().describe("Editable task description / event notes; excludes managed metadata.").optional(),
    trashed: z.boolean().optional(),
    trashError: z.string().nullable().optional(),
    state: z.enum(["open", "closed"]),
    closureReason: z.string().nullable(),
    duplicateOf: z
      .object({
        id: z.string(),
        number: z.number().int(),
        repository: z.string(),
        url: z.string(),
      })
      .nullable()
      .optional(),
    blockedBy: z.array(todoReferenceSchema).optional(),
    children: z.array(todoReferenceSchema).optional(),
    parent: todoReferenceSchema.nullable().optional(),
    readiness: z.enum(["ready", "blocked"]).optional(),
    relationshipError: z.string().nullable().optional(),
    prerequisiteStates: z
      .array(
        z.object({
          id: z.string(),
          number: z.number(),
          state: z.string(),
          closureReason: z.string().nullable(),
        }),
      )
      .optional(),
    approvalRevision: z.string().optional(),
    comments: z
      .array(
        z.object({
          id: z.number(),
          body: z.string(),
          url: z.string(),
          updatedAt: z.string(),
        }),
      )
      .optional(),
    updatedAt: z.string(),
    labels: z.array(z.string()),
    fields: z
      .object({
        Commitment: z
          .enum(["Inbox", "Active", "Someday"])
          .nullable()
          .optional(),
        Location: z.string().nullable().optional(),
        URL: z.string().nullable().optional(),
        Client: z.string().nullable().optional(),
        Category: z
          .string().min(1)
          .nullable()
          .optional(),
        Due: localDate.nullable().optional(),
        Estimate: z.number().nullable().optional(),
        "Cost of waiting": z
          .enum(["Low", "Medium", "High"])
          .nullable()
          .optional(),
        "Waiting since": localDate.nullable().optional(),
        Rank: z.number().nullable().optional(),
        "Top priority": z.enum(["Yes", "No"]).nullable().optional(),
      })
      .catchall(z.union([z.string(), z.number(), z.null()])),
    fieldValues: z.array(z.record(z.string(), z.unknown())),
    start: todoInstantSchema,
    end: todoInstantSchema,
    allDay: z.boolean(),
    fixed: z.boolean(),
    beforeMinutes: z.number().int().min(0).max(1440).optional(),
    afterMinutes: z.number().int().min(0).max(1440).optional(),
    scheduleError: z.string().nullable(),
    deadlineAt: todoDeadlineAtSchema.optional(),
    deadlineError: z.string().nullable().optional(),
    timingWarnings: z.array(z.string()).optional(),
    personalCaptureUndoId: z.uuid().optional(),
    delegation: todoDelegationSchema.optional(),
    timingSummary: z.string().describe("Derived start/end in America/Halifax with UTC offsets and elapsed duration. Use for spoken timing; never interpret UTC clock digits as local time.").optional(),
  })
  .openapi("Todo");
// Compatibility for disposable projections saved before the public Category rename.
export function canonicalTodoCategory(todo: Todo): Todo {
  if (!Object.hasOwn(todo.fields, "Area")) return todo;
  const { Area: legacy, ...fields } = todo.fields;
  if (!Object.hasOwn(fields, "Category") && (typeof legacy === "string" || legacy === null)) fields.Category = legacy;
  return { ...todo, fields };
}
export type Todo = z.infer<typeof todoSchema>;
export type TodoReader = {
  // Passing list rows requests the metadata captured with that exact snapshot.
  freshness?: (rows?: Todo[]) => Promise<{ generation: number; readAt: string | null; stale: boolean }>;
  categories?: CategoryService;
  list(purpose?: "capture" | "priority" | "booking" | "relationships"): Promise<Todo[]>;
  listForBookingAvailability?: () => Promise<Todo[]>;
  detail(number: number): Promise<Todo>;
  assignedList?: (ids: string[]) => Promise<Todo[]>;
  assignedDetail?: (number: number, includeComments?: boolean) => Promise<Todo>;
  write?: TodoWriter;
  approve?: (
    clientId: string,
    number: number,
    input: TodoApproval,
  ) => Promise<TodoWriteResult>;
};

// Keep the existing GitHub field ID/options; Category wins when both names exist.
function canonicalDefinitions<T extends { name: string }>(definitions: T[]): T[] {
  const canonical = definitions.some(field => field.name === "Category");
  return definitions.filter(field => field.name !== "Area" || !canonical)
    .map(field => field.name === "Area" ? { ...field, name: "Category" } : field);
}

export class TodoReadError extends Error {
  constructor(
    public code:
      "TODO_CONFIGURATION_ERROR" | "TODO_UNAVAILABLE" | "TODO_NOT_FOUND" | "TODO_ACCESS_DENIED",
    message: string,
    public retryAfter = 0,
  ) {
    super(message);
  }
}
function configurationError(message: string): never {
  throw new TodoReadError("TODO_CONFIGURATION_ERROR", message);
}

type Definition = {
  id: number;
  name: string;
  data_type: string;
  options?: { id: number; name: string; color?: string; description?: string | null; priority?: number }[];
};
const definitionSchema = z.object({
  id: z.number(),
  name: z.string(),
  data_type: z.string(),
  options: z.array(z.object({ id: z.number(), name: z.string(), color: z.string().optional(), description: z.string().nullable().optional(), priority: z.number().optional() })).nullish(),
});
const issueSchema = z
  .object({
    id: z.number(),
    node_id: z.string(),
    number: z.number(),
    title: z.string(),
    body: z.string().nullable(),
    description: z.string().describe("Editable task description / event notes; excludes managed metadata.").optional(),
    state: z.enum(["open", "closed"]),
    state_reason: z.string().nullable(),
    labels: z.array(z.union([z.string(), z.object({ name: z.string() })])),
    updated_at: z.string(),
    html_url: z.string(),
    pull_request: z.unknown().optional(),
    type: z.object({ name: z.string() }).nullable().optional(),
  })
  .passthrough();

export function createTodoGitHub(
  options: {
    env?: Record<string, string | undefined>;
    fetch?: (
      input: string | URL | Request,
      init?: RequestInit,
    ) => Promise<Response>;
    now?: () => number;
    journal?: CommandJournal;
  } = {},
): TodoReader {
  const env = options.env ?? process.env,
    fetcher = options.fetch ?? fetch,
    now = options.now ?? Date.now;
  const pending = new Map<string, Promise<unknown>>();
  let setup:
    | Promise<{
        token: string;
        expires: number;
        definitions: Definition[];
        repository: string;
      }>
    | undefined;
  let writeSetup: typeof setup;
  let blockedUntil = 0;
  async function request(
    path: string,
    token: string,
    init: RequestInit = {},
    notFound = false,
  ): Promise<{ data: unknown; next: string | null }> {
    if (now() < blockedUntil)
      throw new TodoReadError(
        "TODO_UNAVAILABLE",
        "GitHub is temporarily unavailable. Retry after the indicated delay.",
        Math.ceil((blockedUntil - now()) / 1000),
      );
    let response: Response;
    try {
      response = await fetcher(`https://api.github.com${path}`, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(15000),
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2026-03-10",
          "Content-Type": "application/json",
        },
      });
    } catch {
      throw new TodoReadError(
        "TODO_UNAVAILABLE",
        "GitHub could not be reached.",
      );
    }
    const retry = response.headers.get("retry-after");
    let retryAt = 0;
    if (retry) {
      retryAt = /^\d+$/.test(retry)
        ? now() + Number(retry) * 1000
        : Date.parse(retry);
    }
    const resetAt =
      response.headers.get("x-ratelimit-remaining") === "0"
        ? Number(response.headers.get("x-ratelimit-reset")) * 1000
        : 0;
    blockedUntil = Math.max(
      blockedUntil,
      Number.isFinite(retryAt) ? retryAt : 0,
      Number.isFinite(resetAt) ? resetAt : 0,
    );
    if (!response.ok) {
      if (response.status === 401) {
        setup = undefined;
        writeSetup = undefined;
      }
      if (response.status === 404 && notFound)
        throw new TodoReadError("TODO_NOT_FOUND", "Task not found.");
      // Explicit permission failures invalidate the read projection. GitHub uses
      // 403 for rate limits too, so retain stale data only for that known case.
      const failure = response.status === 403 ? await response.clone().json().catch(() => ({})) as { message?: string } : {};
      const rateLimited = response.status === 429 || blockedUntil > now() || /rate limit|abuse detection/i.test(failure.message ?? "");
      if ((response.status === 401 || response.status === 403 || response.status === 404) && !rateLimited)
        throw new TodoReadError("TODO_ACCESS_DENIED", "GitHub App access denied.");
      if ([403, 429].includes(response.status) && blockedUntil <= now())
        blockedUntil = now() + 60000;
      throw new TodoReadError(
        "TODO_UNAVAILABLE",
        "GitHub read failed. Check App access and retry.",
        Math.max(0, Math.ceil((blockedUntil - now()) / 1000)),
      );
    }
    const link = response.headers.get("link")?.match(/<([^>]+)>;\s*rel="next"/);
    let next: string | null = null;
    if (link) {
      const url = new URL(link[1]);
      if (
        url.origin !== "https://api.github.com" ||
        url.pathname !== path.split("?")[0]
      )
        configurationError("GitHub returned an unexpected pagination target.");
      next = url.pathname + url.search;
    }
    try {
      return {
        data: response.status === 204 ? null : await response.json(),
        next,
      };
    } catch {
      throw new TodoReadError(
        "TODO_UNAVAILABLE",
        "GitHub returned an invalid response.",
      );
    }
  }
  async function pages(path: string, token: string): Promise<unknown[]> {
    const result: unknown[] = [],
      visited = new Set<string>();
    let next: string | null = path;
    while (next) {
      if (visited.has(next) || visited.size >= 1000)
        throw new TodoReadError(
          "TODO_UNAVAILABLE",
          "GitHub pagination did not finish.",
        );
      visited.add(next);
      const page = await request(next, token);
      if (!Array.isArray(page.data))
        throw new TodoReadError(
          "TODO_UNAVAILABLE",
          "GitHub returned an invalid collection.",
        );
      result.push(...page.data);
      next = page.next;
    }
    return result;
  }
  async function initialize(write = false, manageCategories = false) {
    const repository = env.QUANTSELF_TODO_REPOSITORY;
    const testRepository = env.QUANTSELF_TODO_TEST_REPOSITORY;
    const appId = env.QUANTSELF_GITHUB_APP_ID,
      installationId = env.QUANTSELF_GITHUB_INSTALLATION_ID;
    if (
      !repository ||
      !/^[\w.-]+\/[\w.-]+$/.test(repository) ||
      !testRepository ||
      !/^[\w.-]+\/[\w.-]+$/.test(testRepository) ||
      repository.toLowerCase() === testRepository.toLowerCase() ||
      !/^\d+$/.test(appId ?? "") ||
      !/^\d+$/.test(installationId ?? "") ||
      !env.QUANTSELF_GITHUB_PRIVATE_KEY
    )
      configurationError(
        "Configure the dedicated to-do/test repositories and GitHub App ID, installation ID and private key on the server.",
      );
    const [owner, repo] = repository.split("/");
    if (owner.toLowerCase() !== testRepository.split("/")[0].toLowerCase())
      configurationError(
        "To-do repositories must belong to the same organization.",
      );
    const encode = (value: unknown) =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    const payload = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: Math.floor(now() / 1000) - 60, exp: Math.floor(now() / 1000) + 540, iss: appId })}`;
    let jwt: string;
    try {
      jwt = `${payload}.${sign("RSA-SHA256", Buffer.from(payload), createPrivateKey(env.QUANTSELF_GITHUB_PRIVATE_KEY!)).toString("base64url")}`;
    } catch {
      return configurationError(
        "The configured GitHub App private key is invalid.",
      );
    }
    const [appResponse, installationResponse] = await Promise.all([
      request("/app", jwt), request(`/app/installations/${installationId}`, jwt),
    ]);
    const app = appResponse.data as { id?: number };
    const installation = installationResponse.data as {
      app_id?: number;
      account?: { login: string };
      permissions?: { issue_fields?: string };
      repository_selection?: string;
      suspended_at?: string | null;
    };
    if (
      String(app.id) !== appId ||
      String(installation.app_id) !== appId ||
      installation.account?.login.toLowerCase() !== owner.toLowerCase() ||
      installation.repository_selection !== "selected" ||
      installation.suspended_at
    )
      configurationError(
        "GitHub App identity, organization or selected installation does not match configuration.",
      );
    if (manageCategories && installation.permissions?.issue_fields !== "write")
      throw new CategoryPermissionError("Category changes were not saved. Enable organization Issue Fields: read and write for the GitHub App, then approve the installation's updated permissions. Existing category colors remain readable.");
    const access = (
      await request(`/app/installations/${installationId}/access_tokens`, jwt, {
        method: "POST",
        body: JSON.stringify({
          repositories: [repo],
          permissions: {
            issues: write ? "write" : "read",
            issue_fields: manageCategories ? "write" : "read",
            metadata: "read",
            ...(write ? { organization_projects: "write" } : {}),
          },
        }),
      })
    ).data as { token?: string; expires_at: string };
    if (
      !access.token ||
      !Number.isFinite(Date.parse(access.expires_at)) ||
      Date.parse(access.expires_at) <= now()
    )
      configurationError(
        "GitHub did not return a valid short-lived installation token.",
      );
    const [allowedResponse, rawDefinitions] = await Promise.all([
      request("/installation/repositories?per_page=100", access.token),
      pages(`/orgs/${owner}/issue-fields`, access.token),
    ]);
    const allowed = allowedResponse.data as {
      total_count: number;
      repositories: { full_name: string; private: boolean }[];
    };
    if (
      allowed.total_count !== 1 ||
      allowed.repositories?.length !== 1 ||
      allowed.repositories[0].full_name.toLowerCase() !==
        repository.toLowerCase() ||
      !allowed.repositories[0].private
    )
      configurationError(
        "The installation token must allow only the dedicated private to-do repository.",
      );
    const parsed = z.array(definitionSchema).safeParse(rawDefinitions);
    if (!parsed.success)
      configurationError("GitHub issue field definitions are invalid.");
    const definitions: Definition[] = canonicalDefinitions(parsed.data).map((field) => ({
      ...field,
      options: field.options ?? undefined,
    }));
    if (
      new Set(definitions.map((field) => field.id)).size !== definitions.length
    )
      configurationError(
        "GitHub issue field definitions contain duplicate IDs.",
      );
    for (const [name, spec] of Object.entries(canonicalTodoFields)) {
      const matches = definitions.filter((field) => field.name === name);
      // URL rolls out independently of application code; absence must not block existing tasks.
      if (name === "URL" && matches.length === 0) continue;
      const field = matches[0];
      const optionNames = field?.options?.map((option) => option.name) ?? [];
      if (
        matches.length !== 1 ||
        field.data_type !== spec.type ||
        (name !== "Category" && spec.options?.some((name) => !optionNames.includes(name))) ||
        (name !== "Client" && name !== "Category" &&
          spec.options &&
          optionNames.length !== spec.options.length)
      )
        configurationError(
          `Canonical organization field mismatch: ${name}. Check its name, type and options.`,
        );
    }
    return {
      token: access.token,
      expires: Date.parse(access.expires_at),
      definitions,
      repository,
    };
  }
  async function connection() {
    if (setup) {
      const current = await setup;
      if (current.expires > now() + 60000) return current;
      setup = undefined;
    }
    setup ??= initialize().catch((error) => {
      setup = undefined;
      throw error;
    });
    return setup!;
  }
  function coalesce<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const existing = pending.get(key);
    if (existing) return existing as Promise<T>;
    const promise = operation()
      .catch((error) => {
        if (
          error instanceof TodoReadError &&
          error.code === "TODO_CONFIGURATION_ERROR"
        )
          setup = undefined;
        throw error;
      })
      .finally(() => pending.delete(key));
    pending.set(key, promise);
    return promise;
  }
  function record(
    raw: Awaited<ReturnType<ReturnType<typeof createTaskQueries>["list"]>>[number],
    config: Awaited<ReturnType<typeof connection>>,
  ): Todo | null {
    const parsed = issueSchema.safeParse(raw);
    if (!parsed.success)
      throw new TodoReadError(
        "TODO_UNAVAILABLE",
        "GitHub returned an invalid issue.",
      );
    const issue = parsed.data;
    if (issue.pull_request) return null;
    const fieldValues = raw.fieldValues;
    const fields: Todo["fields"] = {};
    for (const value of fieldValues) {
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new TodoReadError(
          "TODO_UNAVAILABLE",
          "GitHub returned invalid issue field values.",
        );
      const fieldId = (value as { issue_field_id?: unknown }).issue_field_id;
      const field = config.definitions.find((field) => field.id === fieldId);
      if (!field || (!Object.hasOwn(canonicalTodoFields, field.name) && !["URL", "Alert"].includes(field.name))) continue; // Unknown fields remain available in fieldValues.
      const parsedValue = z
        .object({
          issue_field_id: z.number(),
          data_type: z.string(),
          value: z.union([z.string(), z.number(), z.null()]),
          single_select_option: z.object({ name: z.string() }).nullish(),
        })
        .safeParse(value);
      if (
        !parsedValue.success ||
        parsedValue.data.data_type !== field.data_type
      )
        configurationError(`Issue field type mismatch: ${field.name}.`);
      const entry = parsedValue.data;
      if (entry.value === null) {
        fields[field.name] = null;
        continue;
      }
      if (field.data_type === "number" && typeof entry.value !== "number")
        configurationError(
          `Issue field value mismatch: ${field.name}. Expected a number.`,
        );
      if (
        field.data_type === "date" &&
        !localDate.safeParse(entry.value).success
      )
        configurationError(
          `Issue field value mismatch: ${field.name}. Expected a date.`,
        );
      if (field.data_type === "single_select") {
        const option = entry.single_select_option?.name;
        if (
          !option ||
          (field.name !== "Category" && !field.options?.some((expected) => expected.name === option))
        )
          configurationError(`Issue field option mismatch: ${field.name}.`);
        fields[field.name] = option;
      } else fields[field.name] = entry.value;
    }
    const { duplicateOf, relationships } = raw;
    return {
      ...relationships,
      ...(raw.comments ? { comments: raw.comments } : {}),
      id: issue.node_id,
      databaseId: issue.id,
      repository: config.repository,
      number: issue.number,
      url: issue.html_url,
      title: issue.title,
      issueType: issue.type?.name ?? null,
      body: issue.body,
      description: readTaskDescription(issue.body),
      state: issue.state,
      closureReason: issue.state_reason,
      duplicateOf,
      updatedAt: issue.updated_at,
      labels: issue.labels.map((label) =>
        typeof label === "string" ? label : label.name,
      ),
      fields,
      categoryId: config.definitions.find(f => f.name === "Category")?.options?.find(o => o.name === fields.Category)?.id ?? null,
      fieldValues: fieldValues as Todo["fieldValues"],
      ...readTodoSchedule(issue.body),
      timingSummary: taskTimingSummary(readTodoSchedule(issue.body)),
      ...readTodoDeadline(issue.body, fields.Due as string | null | undefined),
      trashed: readTodoTrash(issue.body, { state: issue.state, closureReason: issue.state_reason, duplicateOf }).trashed,
      trashError: readTodoTrash(issue.body).trashError,
    };
  }
  async function queries() {
    const config = await connection();
    const tasks = createTaskQueries(async (query, variables) => {
      const response = (await request("/graphql", config.token, {
        method: "POST", body: JSON.stringify({ query, variables }),
      })).data as { data?: unknown; errors?: unknown[] };
      if (query.includes("query TodoTask(") && response.errors?.length &&
        response.errors.every((error: any) => error.type === "NOT_FOUND" && error.path?.join(".") === "repository.issue"))
        throw new TodoReadError("TODO_NOT_FOUND", "Task not found.");
      if (response.errors?.some((error: any) => error.type === "FORBIDDEN" || error.type === "UNAUTHORIZED" || (error.type === "NOT_FOUND" && error.path?.join(".") === "repository")))
        throw new TodoReadError("TODO_ACCESS_DENIED", "GitHub App access denied.");
      // Partial GraphQL data cannot establish readiness or safe write preconditions.
      const absentAssignment = query.includes("query TodoAssignments(") && response.errors?.every((error: any) =>
        error.type === "NOT_FOUND" && error.path?.[0] === "nodes" && error.path.length === 2);
      if ((response.errors?.length && !absentAssignment) || !response.data)
        throw new TodoReadError("TODO_UNAVAILABLE", "GitHub task query incomplete. Refresh and retry.");
      return response.data;
    }, config.repository);
    return { config, tasks };
  }
  async function queryTasks<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) {
      if (error instanceof TodoReadError) throw error;
      throw new TodoReadError("TODO_UNAVAILABLE", "GitHub returned incomplete task data. Refresh and retry.");
    }
  }
  const readTask = (number: number, projection: "detail" | "assigned-detail" | "capture" = "detail") => coalesce(`${projection}:task:${number}`, () => queryTasks(async () => {
    if (!Number.isSafeInteger(number) || number <= 0)
      throw new TodoReadError("TODO_NOT_FOUND", "Task not found.");
    const { config, tasks } = await queries();
    const raw = await tasks.task(number, projection);
    const todo = raw && record(raw, config);
    if (!todo) throw new TodoReadError("TODO_NOT_FOUND", "Task not found.");
    return todo;
  }));
  const readCollection = (projection: Exclude<TaskProjection, "detail">) => coalesce(projection, () => queryTasks(async () => {
    const { config, tasks } = await queries();
    const records = (await tasks.list(projection)).map(raw => record(raw, config)).filter((todo): todo is Todo => todo !== null);
    return deriveReadiness(records).sort((a, b) =>
      (typeof a.fields.Rank === "number" ? a.fields.Rank : Infinity) -
      (typeof b.fields.Rank === "number" ? b.fields.Rank : Infinity) || a.id.localeCompare(b.id));
  }));
  const reader: TodoReader = {
    list: (purpose) => readCollection(purpose ?? "list"),
    assignedList: (ids) => queryTasks(async () => {
      if (!ids.length) return [];
      const { config, tasks } = await queries();
      return (await tasks.assigned(ids)).map(raw => record(raw, config)).filter((todo): todo is Todo => todo !== null)
        .sort((a, b) => Number(a.fields.Rank ?? Infinity) - Number(b.fields.Rank ?? Infinity) || a.id.localeCompare(b.id));
    }),
    assignedDetail: (number, includeComments = true) => readTask(number, includeComments ? "assigned-detail" : "capture"),
    detail: (number) =>
      coalesce(`detail:${number}`, async () => {
        const [todo, tasks] = await Promise.all([readTask(number), readCollection("checks")]);
        const result = deriveReadiness([
          ...tasks.filter((t) => t.id !== todo.id),
          todo,
        ]).find((t) => t.id === todo.id)!;
        result.prerequisiteStates = (result.blockedBy ?? []).map((ref) => {
          const task = tasks.find((t) => t.id === ref.id);
          return {
            id: ref.id,
            number: ref.number,
            state: task?.state ?? "unavailable",
            closureReason: task?.closureReason ?? null,
          };
        });
        result.approvalRevision = approvalRevision(result, tasks);
        return result;
      }),
  };
  let categorySetup: typeof setup;
  let categoryQueue = Promise.resolve();
  const categoryJournal = options.journal ?? todoCommandJournal;
  async function freshCategories(write = false) {
    if (write && categorySetup && (await categorySetup).expires <= now() + 60000) categorySetup = undefined;
    if (write) categorySetup ??= initialize(false, true).catch(error => { categorySetup = undefined; throw error; });
    const config = write ? await categorySetup! : await connection();
    const raw = await pages(`/orgs/${config.repository.split("/")[0]}/issue-fields`, config.token);
    const definitions = canonicalDefinitions(z.array(definitionSchema).parse(raw));
    const matches = definitions.filter(f => f.name === "Category" && f.data_type === "single_select");
    if (matches.length !== 1) configurationError("The Category field must exist and use single-select options.");
    const field = matches[0];
    const categories = (field.options ?? []).map(option => categorySchema.parse({ ...option, color: option.color ?? "gray" }));
    // Refresh definition metadata, never task data.
    for (const pendingConfig of [setup, writeSetup, categorySetup]) {
      if (pendingConfig) (await pendingConfig).definitions = definitions.map(f => ({ ...f, options: f.options ?? undefined }));
    }
    return { config, field: { id: field.id, options: categories }, snapshot: categorySnapshot({ id: field.id, options: categories }) };
  }
  reader.categories = {
    list: () => coalesce("categories", async () => (await freshCategories()).snapshot),
    write: (client, command) => {
      const run = categoryQueue.then(async () => {
        const key = createHash("sha256").update(`categories:${env.QUANTSELF_TODO_REPOSITORY}:${client}:${command.commandId}`).digest("hex");
        const hash = createHash("sha256").update(JSON.stringify(command)).digest("hex");
        const reservation = await categoryJournal.reserve(key, hash);
        if (reservation.hash !== hash) throw new TodoWriteError("TODO_CONFLICT", "Retry with the original category command.");
        const receipt = reservation.state;
        if (receipt.done.category) return (await freshCategories()).snapshot;
        const { config, field, snapshot } = await freshCategories(true);
        if (receipt.categoryOptions) {
          const desired = receipt.categoryOptions;
          const matches = snapshot.categories.length === desired.length && desired.every(option => snapshot.categories.some(c => (option.id !== undefined ? c.id === option.id : c.name === option.name) && c.name === option.name && c.color === option.color));
          if (matches) { receipt.done.category = true; await categoryJournal.save(key, receipt); return snapshot; }
        }
        const desired = changedCategories(snapshot, command);
        if (command.action === "delete") {
          const category = snapshot.categories.find(c => c.id === command.id)!;
          // Includes closed and trashed issues; moving visible tasks alone is insufficient.
          if ((await reader.list("priority")).some(todo => todo.fields.Category === category.name))
            throw new TodoWriteError("TODO_CONFLICT", "Move all tasks out of this category before deleting it.");
        }
        receipt.categoryOptions = desired;
        await categoryJournal.save(key, receipt);
        await request(`/orgs/${config.repository.split("/")[0]}/issue-fields/${field.id}`, config.token, {
          method: "PATCH", body: JSON.stringify({ options: desired.map((option, index) => ({ ...option, priority: option.priority ?? index + 1 })) }),
        });
        const verified = (await freshCategories(true)).snapshot;
        if (verified.categories.length !== desired.length || !desired.every(option => verified.categories.some(c => ("id" in option ? c.id === option.id : c.name === option.name) && c.name === option.name && c.color === option.color)))
          throw new TodoWriteError("TODO_UNAVAILABLE", "Category save could not be verified. Retry the same command.", 503);
        receipt.done.category = true;
        await categoryJournal.save(key, receipt);
        return verified;
      });
      categoryQueue = run.then(() => {}, () => {});
      return run;
    },
  };
  reader.approve = createTodoApprover(
    reader,
    options.journal ?? todoCommandJournal,
    async (path, method, body) => {
      if (writeSetup && (await writeSetup).expires <= now() + 60000)
        writeSetup = undefined;
      writeSetup ??= initialize(true).catch((error) => {
        writeSetup = undefined;
        throw error;
      });
      const config = await writeSetup;
      return (
        await request(path, config.token, {
          method,
          body: JSON.stringify(body),
        })
      ).data;
    },
  );
  reader.write = createTodoWriter({
    reader: { ...reader, detail: readTask },
    journal: options.journal,
    connect: async () => {
      if (writeSetup && (await writeSetup).expires <= now() + 60000)
        writeSetup = undefined;
      writeSetup ??= initialize(true).catch((error) => {
        writeSetup = undefined;
        throw error;
      });
      const config = await writeSetup;
      const send = async (path: string, method: string, body?: unknown) =>
        (
          await request(path, config.token, {
            method,
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          })
        ).data;
      const graphql = async (
        query: string,
        variables: Record<string, unknown>,
      ) => {
        const result = (await send("/graphql", "POST", {
          query,
          variables,
        })) as { data?: any; errors?: unknown[] };
        if (result.errors?.length || !result.data)
          throw new TodoReadError(
            "TODO_UNAVAILABLE",
            "Project sync unavailable.",
          );
        return result.data;
      };
      return {
        repository: config.repository,
        definitions: config.definitions,
        request: send,
        syncProject: async (id) => {
          const projectNumber = Number(env.QUANTSELF_TODO_PROJECT_NUMBER);
          if (!Number.isSafeInteger(projectNumber) || projectNumber <= 0)
            configurationError("Configure the private Me Project number.");
          const result = await graphql(
            "query($owner:String!,$number:Int!){organization(login:$owner){projectV2(number:$number){id title public}}}",
            { owner: config.repository.split("/")[0], number: projectNumber },
          );
          const project = result.organization?.projectV2;
          if (!project || project.public || project.title !== "Me")
            configurationError(
              "Configured Project must be the private Me Project.",
            );
          // GitHub returns the existing item when content is already a member.
          const added = await graphql(
            "mutation($project:ID!,$content:ID!){addProjectV2ItemById(input:{projectId:$project,contentId:$content}){item{id}}}",
            { project: project.id, content: id },
          );
          const itemId = added.addProjectV2ItemById?.item?.id;
          if (!itemId) throw Error("Missing Project item");
          for (let attempt = 0; attempt < 3; attempt++) {
            const verified = await graphql(
              "query($id:ID!){node(id:$id){... on ProjectV2Item{project{id} content{... on Issue{id}}}}}",
              { id: itemId },
            );
            if (
              verified.node?.project?.id === project.id &&
              verified.node?.content?.id === id
            )
              return;
          }
          throw new TodoReadError(
            "TODO_UNAVAILABLE",
            "Project membership has not reconciled; task remains saved.",
          );
        },
      };
    },
  });
  return reader;
}
export const todoGitHub = createTodoGitHub();
