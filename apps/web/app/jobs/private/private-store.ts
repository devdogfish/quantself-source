import { PrivateDetailsRequestError, privateFieldKey, type FieldMetadata, type PrivateField, type PrivateFieldValue, type PrivateFieldWrite, type PrivateValue } from "./private-api";

type Draft = { field: PrivateField; value: PrivateValue; expectedVersion: number | null };
type Collector = () => PrivateValue | null | undefined;
type Problem = "conflict" | "uncertain" | "invalid";
type Batch = { writes: PrivateFieldWrite[]; problem?: Problem };
export type FieldStatus = { saving: boolean };
type DetailsSnapshot = {
  fields: ReadonlyMap<string, FieldMetadata>;
  statuses: ReadonlyMap<string, FieldStatus>;
  saving: boolean;
  pending: number;
  problem?: Problem;
};

const batchSize = 25;

export function createPrivateDetailsStore(api: { list: (signal?: AbortSignal) => Promise<Array<FieldMetadata | PrivateFieldValue>>; save: (fields: PrivateFieldWrite[]) => Promise<FieldMetadata[]> }) {
  let snapshot: DetailsSnapshot = { fields: new Map(), statuses: new Map(), saving: false, pending: 0 };
  const listeners = new Set<() => void>();
  const collectors = new Map<string, { field: PrivateField; collect: Collector }>();
  // Never publish entered values to React, storage, or error messages.
  const staged = new Map<string, Draft>();
  const savedValues = new Map<string, PrivateValue | null>();
  let active: Batch | undefined;
  let reading: { signal?: AbortSignal; result: Promise<FieldMetadata[]> } | undefined;

  function publish(fields = snapshot.fields) {
    const statuses = new Map<string, FieldStatus>();
    for (const key of staged.keys()) statuses.set(key, { saving: false });
    for (const write of active?.writes ?? []) statuses.set(privateFieldKey(write), { saving: !active?.problem });
    snapshot = { fields, statuses, saving: Boolean(active && !active.problem), pending: statuses.size, problem: active?.problem };
    for (const listener of listeners) listener();
  }

  function applyFields(records: Array<FieldMetadata | PrivateFieldValue>, writes: PrivateFieldWrite[] = []) {
    const next = new Map(snapshot.fields);
    const submitted = new Map(writes.map(write => [privateFieldKey(write), write.value]));
    for (const field of records) {
      const key = privateFieldKey(field);
      if ((next.get(key)?.version ?? 0) > field.version) continue;
      const { value, ...metadata } = field as FieldMetadata & { value?: PrivateValue | null };
      next.set(key, metadata);
      const currentValue = value === undefined ? submitted.get(key) : value;
      if (currentValue !== undefined) savedValues.set(key, currentValue);
    }
    publish(next);
  }

  function refresh(signal?: AbortSignal) {
    if (reading && !reading.signal?.aborted) return reading.result;
    const result = api.list(signal).then((records) => {
      if (!signal?.aborted) applyFields(records);
      return records;
    }).finally(() => { if (reading?.result === result) reading = undefined; });
    reading = { signal, result };
    return result;
  }

  function capture() {
    let valid = true;
    let changed = false;
    for (const [key, { field, collect }] of collectors) {
      const value = collect();
      if (value === null) valid = false;
      else if (value !== undefined) {
        staged.set(key, { field, value, expectedVersion: snapshot.fields.get(key)?.version ?? null });
        changed = true;
      }
    }
    if (changed) publish();
    return { valid, changed };
  }

  function nextWrite({ field, value, expectedVersion }: Draft): PrivateFieldWrite {
    const current = snapshot.fields.get(privateFieldKey(field));
    const { key, label, type, scope, options } = current ?? field;
    return { key, label, type, scope, options, value, expectedVersion };
  }

  function stageActive(rebase = false) {
    const writes = active?.writes ?? [];
    const latest = new Map(staged);
    staged.clear();
    for (const write of writes) staged.set(privateFieldKey(write), { field: write, value: write.value, expectedVersion: write.expectedVersion });
    for (const [key, draft] of latest) staged.set(key, draft);
    if (rebase) for (const write of writes) {
      const key = privateFieldKey(write);
      staged.get(key)!.expectedVersion = snapshot.fields.get(key)?.version ?? null;
    }
    active = undefined;
  }

  function start() {
    if (active || !staged.size) return;
    const entries = [...staged].slice(0, batchSize);
    active = { writes: entries.map(([, draft]) => nextWrite(draft)) };
    for (const [key] of entries) staged.delete(key);
    void send(active);
  }

  async function send(batch: Batch) {
    batch.problem = undefined;
    publish();
    try {
      const confirmed = await api.save(batch.writes);
      const attempted = new Map(batch.writes.map(write => [privateFieldKey(write), write.expectedVersion]));
      for (const record of confirmed) {
        const key = privateFieldKey(record);
        const draft = staged.get(key);
        if (draft && draft.expectedVersion === attempted.get(key)) draft.expectedVersion = record.version;
      }
      active = undefined;
      applyFields(confirmed, batch.writes);
      start();
    } catch (error) {
      const status = error instanceof PrivateDetailsRequestError ? error.status : undefined;
      if (status === 409) await refresh().catch(() => {});
      batch.problem = status === 409 ? "conflict" : status === 400 || status === 422 ? "invalid" : "uncertain";
      publish();
    }
  }

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    getSnapshot: () => snapshot,
    refresh,
    value(field: PrivateField) {
      const key = privateFieldKey(field);
      return staged.get(key)?.value ?? active?.writes.find(write => privateFieldKey(write) === key)?.value ?? savedValues.get(key);
    },
    register(field: PrivateField, collect?: Collector) {
      const key = privateFieldKey(field);
      if (collect) collectors.set(key, { field, collect });
      else collectors.delete(key);
    },
    keepDrafts: () => capture().valid,
    saveChanges() {
      const { changed, valid } = capture();
      if (active?.problem === "invalid" && changed && valid) stageActive();
      start();
    },
    retry() {
      const batch = active;
      if (batch?.problem === "uncertain") {
        void send(batch);
      } else if (batch?.problem === "conflict") {
        if (!capture().valid) return;
        batch.problem = undefined;
        publish();
        void refresh().then(() => { stageActive(true); start(); }, () => { batch.problem = "conflict"; publish(); });
      }
    },
    discard() {
      if (!active?.problem) return;
      active = undefined;
      staged.clear();
      publish();
    },
  };
}
