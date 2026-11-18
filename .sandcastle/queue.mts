export type QueueIssue = { number: number; title: string; state: string; body: string;
  labels: { name: string }[] };

export function blockers(issue: QueueIssue): number[] | null {
  const section = issue.body.match(/^## Blocked by[^\S\n]*\r?\n([\s\S]*?)(?=^##\s|(?![\s\S]))/im)?.[1];
  if (section === undefined) return null;
  return [...section.matchAll(/#(\d+)/g)].map(match => Number(match[1]));
}

export function selectReady(issues: QueueIssue[], states: ReadonlyMap<number, string>): QueueIssue[] {
  return issues.filter(issue => {
    if (issue.state !== "OPEN") return false;
    const labels = new Set(issue.labels.map(label => label.name));
    if (!labels.has("Sandcastle") || !labels.has("ready-afk")) return false;
    const dependencies = blockers(issue);
    return dependencies !== null && dependencies.every(id => states.get(id) === "CLOSED");
  });
}
