import { z } from "@hono/zod-openapi";

// Each connection is independently paginated. Never infer completeness from length.
const pageInfo = "pageInfo { hasNextPage endCursor }";
const reference = "id databaseId number title url repository { nameWithOwner }";
const fieldDefinition = [
  "Date",
  "Number",
  "SingleSelect",
  "MultiSelect",
  "Text",
]
  .map((kind) => `... on IssueField${kind} { fullDatabaseId name dataType }`)
  .join(" ");
const fieldValue = ["Date", "Number", "SingleSelect", "MultiSelect", "Text"]
  .map(
    (kind) =>
      `... on IssueField${kind}Value { id ${kind === "Number" ? "numberValue: value" : "value"} ${kind === "SingleSelect" ? "name optionId" : ""} field { ${fieldDefinition} } }`,
  )
  .join(" ");
const connections = {
  blockedBy: reference,
  subIssues: reference,
  labels: "name",
  issueFieldValues: `__typename ${fieldValue}`,
  comments: "databaseId body url updatedAt",
};
type ConnectionName = keyof typeof connections;
export type TaskProjection =
  "list" | "detail" | "checks" | "capture" | "priority" | "booking" | "relationships" | "assigned" | "assigned-detail";
type Query = (
  query: string,
  variables: Record<string, unknown>,
) => Promise<any>;
const connectionSchema = z.object({
  nodes: z.array(z.record(z.string(), z.any())),
  pageInfo: z.object({
    hasNextPage: z.boolean(),
    endCursor: z.string().nullable(),
  }),
});
const refSchema = z.object({
  id: z.string(),
  databaseId: z.number(),
  number: z.number(),
  title: z.string(),
  url: z.string(),
  repository: z.object({ nameWithOwner: z.string() }),
});
const issueSchema = refSchema
  .extend({
    body: z.string().nullable(),
    state: z.enum(["OPEN", "CLOSED"]),
    stateReason: z.string().nullable(),
    updatedAt: z.string(),
    issueType: z.object({ name: z.string() }).nullable(),
    duplicateOf: refSchema.nullable(),
  })
  .passthrough();

function selected(projection: TaskProjection): ConnectionName[] {
  if (projection === "capture") return [];
  if (projection === "assigned") return ["labels", "issueFieldValues"];
  if (projection === "assigned-detail") return ["labels", "issueFieldValues", "comments"];
  if (projection === "priority" || projection === "booking") return ["issueFieldValues"];
  if (projection === "relationships") return ["blockedBy", "subIssues"];
  return projection === "checks"
    ? ["blockedBy"]
    : projection === "detail"
      ? ["blockedBy", "subIssues", "labels", "issueFieldValues", "comments"]
      : ["blockedBy", "subIssues", "labels", "issueFieldValues"];
}
function selection(projection: TaskProjection) {
  return `${reference} body state stateReason updatedAt issueType { name }
    duplicateOf { ${reference} }
    ${selected(projection).includes("subIssues") ? `parent { ${reference} }` : ""}
    ${selected(projection)
      .map(
        (name) =>
          `${name}(first:100) { nodes { ${connections[name]} } ${pageInfo} }`,
      )
      .join("\n")}`;
}

// Transport-only adapter: no task cache; all results belong to this operation.
export function createTaskQueries(query: Query, repository: string) {
  const [owner, name] = repository.split("/");
  async function complete(raw: any[], projection: TaskProjection) {
    const issues = raw.map((value) => issueSchema.parse(value));
    const pending: {
      issue: any;
      name: ConnectionName;
      cursor: string;
      seen: Set<string>;
    }[] = [];
    for (const issue of issues) {
      for (const name of selected(projection)) {
        const connection = connectionSchema.parse(issue[name]);
        issue[name] = connection;
        if (connection.pageInfo.hasNextPage) {
          if (!connection.pageInfo.endCursor)
            throw Error("Missing GitHub cursor");
          pending.push({
            issue,
            name,
            cursor: connection.pageInfo.endCursor,
            seen: new Set(),
          });
        }
      }
    }
    // Alias batches bound query complexity while fetching unrelated pages together.
    while (pending.length) {
      const batch = pending.splice(0, 25);
      const variables: Record<string, unknown> = {};
      const declarations: string[] = [],
        fields: string[] = [];
      batch.forEach((entry, index) => {
        if (entry.seen.has(entry.cursor) || entry.seen.size >= 1000)
          throw Error("GitHub pagination did not finish");
        entry.seen.add(entry.cursor);
        declarations.push(`$id${index}:ID!`, `$cursor${index}:String!`);
        variables[`id${index}`] = entry.issue.id;
        variables[`cursor${index}`] = entry.cursor;
        fields.push(
          `p${index}:node(id:$id${index}) { ... on Issue { ${entry.name}(first:100,after:$cursor${index}) { nodes { ${connections[entry.name]} } ${pageInfo} } } }`,
        );
      });
      const result = await query(
        `query TodoConnectionPages(${declarations.join(",")}) { ${fields.join("\n")} }`,
        variables,
      );
      batch.forEach((entry, index) => {
        const next = connectionSchema.parse(result[`p${index}`]?.[entry.name]);
        entry.issue[entry.name].nodes.push(...next.nodes);
        if (next.pageInfo.hasNextPage) {
          if (!next.pageInfo.endCursor) throw Error("Missing GitHub cursor");
          entry.cursor = next.pageInfo.endCursor;
          pending.push(entry);
        }
      });
    }
    return issues.map((issue) => normalize(issue, projection));
  }
  return {
    async task(number: number, projection: "detail" | "assigned-detail" | "capture" = "detail") {
      const result = await query(
        `query TodoTask($owner:String!,$name:String!,$number:Int!) { repository(owner:$owner,name:$name) { issue(number:$number) { ${selection(projection)} } } }`,
        { owner, name, number },
      );
      if (!result.repository) throw Error("GitHub repository unavailable");
      if (result.repository.issue === null) return null;
      return (await complete([result.repository.issue], projection))[0];
    },
    async assigned(ids: string[]) {
      const issues: any[] = [];
      const repositoryName = repository.toLowerCase();
      const batchSize = 25;
      const concurrency = 4;
      for (let start = 0; start < ids.length; start += batchSize * concurrency) {
        const requests: Array<ReturnType<Query>> = [];
        for (let offset = start; offset < Math.min(ids.length, start + batchSize * concurrency); offset += batchSize) {
          requests.push(query(
            `query TodoAssignments($ids:[ID!]!) { nodes(ids:$ids) { ... on Issue { ${selection("assigned")} } } }`,
            { ids: ids.slice(offset, offset + batchSize) },
          ));
        }
        for (const result of await Promise.all(requests)) {
          if (!Array.isArray(result.nodes)) throw Error("Missing GitHub assignment results");
          issues.push(...result.nodes.filter((node: any) => node?.repository?.nameWithOwner?.toLowerCase() === repositoryName));
        }
      }
      return complete(issues, "assigned");
    },
    async list(projection: TaskProjection = "list") {
      const issues: any[] = [],
        seen = new Set<string>();
      let cursor: string | null = null;
      do {
        const result = await query(
          `query TodoCollection($owner:String!,$name:String!,$cursor:String) { repository(owner:$owner,name:$name) { issues(first:50,after:$cursor,orderBy:{field:CREATED_AT,direction:ASC}) { nodes { ${selection(projection)} } ${pageInfo} } } }`,
          { owner, name, cursor },
        );
        const page = connectionSchema.parse(result.repository?.issues);
        issues.push(...page.nodes);
        if (!page.pageInfo.hasNextPage) break;
        cursor = page.pageInfo.endCursor;
        if (!cursor || seen.has(cursor) || seen.size >= 1000)
          throw Error("GitHub pagination did not finish");
        seen.add(cursor);
      } while (true);
      return complete(issues, projection);
    },
  };
}

function normalize(issue: any, projection: TaskProjection) {
  const ref = (value: unknown) => {
    const r = refSchema.parse(value);
    return {
      id: r.id,
      databaseId: r.databaseId,
      number: r.number,
      title: r.title,
      url: r.url,
      repository: r.repository.nameWithOwner,
    };
  };
  const fieldValues = (issue.issueFieldValues?.nodes ?? []).map(
    (value: any) => {
      const field = value.field;
      const fieldId = Number(field?.fullDatabaseId);
      if (
        !field ||
        !Number.isSafeInteger(fieldId) ||
        fieldId <= 0 ||
        typeof field.dataType !== "string"
      )
        throw Error("Invalid GitHub issue field");
      const dataType = field.dataType.toLowerCase();
      return {
        issue_field_id: fieldId,
        data_type: dataType,
        value: dataType === "number" ? value.numberValue : value.value,
        ...(dataType === "single_select"
          ? { single_select_option: { name: value.name } }
          : {}),
      };
    },
  );
  return {
    id: issue.databaseId,
    node_id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state.toLowerCase(),
    state_reason: issue.stateReason?.toLowerCase() ?? null,
    updated_at: issue.updatedAt,
    html_url: issue.url,
    type: issue.issueType,
    labels: (issue.labels?.nodes ?? []).map((label: any) =>
      z.object({ name: z.string() }).parse(label),
    ),
    fieldValues,
    duplicateOf: issue.duplicateOf
      ? (() => {
          const { databaseId, title, ...target } = ref(issue.duplicateOf);
          return target;
        })()
      : null,
    relationships: {
      blockedBy: (issue.blockedBy?.nodes ?? []).map(ref),
      relationshipError: null,
      ...(selected(projection).includes("subIssues")
        ? {
            children: issue.subIssues.nodes.map(ref),
            parent: issue.parent === null ? null : ref(issue.parent),
          }
        : {}),
    },
    ...(projection === "detail" || projection === "assigned-detail"
      ? {
          comments: issue.comments.nodes.map((comment: any) => {
            const c = z
              .object({
                databaseId: z.number(),
                body: z.string(),
                url: z.string(),
                updatedAt: z.string(),
              })
              .parse(comment);
            return {
              id: c.databaseId,
              body: c.body,
              url: c.url,
              updatedAt: c.updatedAt,
            };
          }),
        }
      : {}),
  };
}
