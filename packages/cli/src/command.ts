export type CommandDefinition = {
  name: string;
  method: string;
  path: string;
  summary: string;
  description?: string;
  permissions?: readonly string[];
  parameters: readonly {
    name: string;
    in: "path" | "query" | "header";
    required: boolean;
    description?: string;
    schema?: unknown;
  }[];
  body?: {
    required: boolean;
    schema?: unknown;
  };
};
