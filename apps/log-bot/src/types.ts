export type FlowName = "weight" | "mood" | "sleep" | "spend";

export type FlowStep =
  | { flow: "weight"; step: "weight" }
  | { flow: "mood"; step: "score" }
  | { flow: "sleep"; step: "hours" | "quality" | "notes" }
  | { flow: "spend"; step: "amount" | "category" | "merchant" };

export interface FlowState {
  flow: FlowName;
  step: string;
  data: Record<string, unknown>;
  messageIds: number[];
}
