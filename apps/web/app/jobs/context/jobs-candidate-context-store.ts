import {
  candidateContextApi, CandidateContextRequestError, type CandidateContext, type CandidateContextPatch,
} from "./jobs-candidate-context-api";

type Snapshot = {
  markdown: string;
  loaded: boolean;
  saving: boolean;
  canUndo: boolean;
  canRedo: boolean;
  error?: string;
  conflict?: CandidateContext;
};

const initial: Snapshot = { markdown: "", loaded: false, saving: false, canUndo: false, canRedo: false };

export function createCandidateContextStore(api: typeof candidateContextApi = candidateContextApi) {
  let snapshot = initial;
  let saved: CandidateContext | undefined;
  let pending: CandidateContextPatch | undefined;
  let loading = false;
  let past: string[] = [], future: string[] = [];
  const listeners = new Set<() => void>();

  function publish(next: Partial<Snapshot>) {
    snapshot = { ...snapshot, ...next, canUndo: past.length > 0, canRedo: future.length > 0 };
    listeners.forEach(listener => listener());
  }

  async function load() {
    if (loading || saved) return;
    loading = true;
    publish({ error: undefined });
    try {
      saved = await api.get();
      publish({ markdown: saved.markdown, loaded: true });
    } catch {
      publish({ error: "Couldn’t load candidate context." });
    } finally {
      loading = false;
    }
  }

  async function flush() {
    if (!saved || snapshot.saving || snapshot.conflict) return;
    if (!pending && saved.markdown === snapshot.markdown) return;
    const command = pending ??= { expectedVersion: saved.version, markdown: snapshot.markdown };
    publish({ saving: true, error: undefined });
    try {
      try {
        const result = await api.patch(command);
        if (result.version !== command.expectedVersion + 1 || result.markdown !== command.markdown) throw new Error();
        saved = result;
      } catch (error) {
        if (!(error instanceof CandidateContextRequestError) || error.status !== 409) throw error;
        const current = await api.get().catch(() => { throw new Error("Couldn’t read the current version."); });
        saved = current;
        if (current.version !== command.expectedVersion + 1 || current.markdown !== command.markdown) {
          if (current.markdown !== snapshot.markdown) publish({ conflict: current });
        }
      }
      pending = undefined;
    } catch (error) {
      // A rejected command can be replaced by a corrected edit. Keep an
      // uncertain command intact until its exact version and payload are retried.
      const rejected = error instanceof CandidateContextRequestError && error.status >= 400 && error.status < 500;
      if (rejected) pending = undefined;
      if (!rejected || command.markdown === snapshot.markdown) {
        publish({ error: rejected ? error.message : "Couldn’t confirm the save. Your draft is still here." });
      }
    } finally {
      publish({ saving: false });
    }
    if (!snapshot.error) void flush();
  }

  function setMarkdown(markdown: string) {
    // New intent should not silently retry an uncertain request. Explicit retry
    // keeps the original command and then drains newer intent.
    const waitForRetry = Boolean(pending && snapshot.error);
    publish({ markdown, error: waitForRetry ? snapshot.error : undefined });
    if (!waitForRetry) void flush();
  }

  function edit(markdown: string) {
    if (!saved || snapshot.markdown === markdown) return;
    past = [...past.slice(-99), snapshot.markdown];
    future = [];
    setMarkdown(markdown);
  }

  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => snapshot,
    getServerSnapshot: () => initial,
    load, edit,
    retry: () => saved ? flush() : load(),
    undo() {
      const previous = past.pop();
      if (previous === undefined) return;
      future.push(snapshot.markdown);
      setMarkdown(previous);
    },
    redo() {
      const next = future.pop();
      if (next === undefined) return;
      past.push(snapshot.markdown);
      setMarkdown(next);
    },
    resolve(choice: "draft" | "saved") {
      const conflict = snapshot.conflict;
      if (!conflict) return;
      if (choice === "saved") {
        past = [...past.slice(-99), snapshot.markdown];
        future = [];
      }
      publish({ conflict: undefined, markdown: choice === "saved" ? conflict.markdown : snapshot.markdown });
      void flush();
    },
  };
}
