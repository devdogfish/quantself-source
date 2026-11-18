import { expect, test } from "bun:test";
import {
  prepareJarvisHabitConfiguration,
  jarvisHabitInstructions,
} from "./jarvis-habits";
const agent = {
  platform_settings: { auth: { enable_auth: true } },
  conversation_config: {
    agent: { prompt: { prompt: "Existing instructions", tool_ids: ["tasks"] } },
  },
};
const tools = [
  {
    id: "tasks",
    tool_config: {
      name: "read_tasks",
      type: "webhook",
      api_schema: {
        method: "GET",
        url: "https://api.example.test/api/v1/todos",
        request_headers: { "X-API-Key": { secret_id: "scoped" } },
      },
    },
  },
];
test("habit webhooks share scoped API boundary; preserve prompt, no delete, stable repeatable preparation", () => {
  const result = prepareJarvisHabitConfiguration(agent, tools);
  expect(result.desired.map((t) => t.toolConfig.name)).toEqual([
    "read_habit_day",
    "log_habit_occurrence",
    "log_habit_urge",
    "read_habit_context",
    "read_habit_system",
    "change_habit_system",
  ]);
  for (const { toolConfig: t } of result.desired) {
    expect(t.type).toBe("webhook");
    expect(t.api_schema.url).toStartWith(
      "https://api.example.test/api/v1/habits/",
    );
    expect(t.api_schema.request_headers).toEqual(
      tools[0]!.tool_config.api_schema.request_headers,
    );
    expect(t.api_schema.method).not.toBe("DELETE");
    if (t.api_schema.query_params_schema) {
      expect(Object.keys(t.api_schema.query_params_schema).sort()).toEqual([
        "properties", "required",
      ]);
    }
  }
  expect(
    result.expectedAgent.conversation_config.agent.prompt.prompt,
  ).toContain("Existing instructions");
  expect(prepareJarvisHabitConfiguration(result.expectedAgent, tools)).toEqual(
    result,
  );
  expect(
    result.desired[3]!.toolConfig.api_schema.query_params_schema!.properties
      .days!.constant_value,
  ).toBe("14");
  expect(jarvisHabitInstructions).toContain("clarify");
  expect(jarvisHabitInstructions).toContain("same commandId");
  expect(jarvisHabitInstructions).toContain("21:00");
});
test("reject public agents, insecure origins, ambiguous templates, foreign habit credentials", () => {
  expect(() =>
    prepareJarvisHabitConfiguration({ ...agent, platform_settings: {} }, tools),
  ).toThrow();
  expect(() =>
    prepareJarvisHabitConfiguration(agent, [...tools, ...tools]),
  ).toThrow();
  const insecure = structuredClone(tools);
  insecure[0]!.tool_config.api_schema.url = "http://localhost/api/v1/todos";
  expect(() => prepareJarvisHabitConfiguration(agent, insecure)).toThrow();
  const foreign = {
    id: "foreign",
    tool_config: {
      name: "read_habit_day",
      type: "webhook",
      api_schema: { url: "https://other.example/api/v1/habits/day" },
    },
  };
  expect(() =>
    prepareJarvisHabitConfiguration(agent, [...tools, foreign]),
  ).toThrow();
});

test("provider parameters have exactly one value source", () => {
  function verify(schema: Record<string, any>) {
    for (const value of Object.values(schema.properties ?? {}) as Record<string, any>[]) {
      const sources = [value.description, value.dynamic_variable, value.is_system_provided,
        value.constant_value, value.is_omitted].filter(v => v !== "" && v != null && v !== false);
      expect(sources).toHaveLength(1);
      if (value.properties) verify(value);
    }
  }
  for (const { toolConfig } of prepareJarvisHabitConfiguration(agent, tools).desired) {
    verify(toolConfig.api_schema.query_params_schema ?? {});
    verify(toolConfig.api_schema.request_body_schema ?? {});
  }
});

test("managed habit prompt uses tool results to determine session access", () => {
  const { expectedAgent } = prepareJarvisHabitConfiguration(agent, tools);
  const prompt = expectedAgent.conversation_config.agent.prompt.prompt;
  expect(prompt).toContain("attempt the appropriate Habit read tool before assessing access");
  expect(prompt).toContain("Never infer missing Habit permissions from task-only screen context");
  expect(prompt).toContain("Report missing access only if a Habit tool returns 403");
  expect(prompt).not.toContain("Existing task keys do not have habit access");
});
