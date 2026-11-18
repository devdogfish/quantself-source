import {
  afterAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
  setDefaultTimeout,
} from "bun:test";
import { act } from "react";
import { createTestDom } from "@/components/shared/test-dom";
import { chooseOption } from "@/components/shared/test-select";
import type { ApiKeySummary } from "@quantself/auth/api-key-contract";
import type {
  ApiKeyActionState,
  ApiKeyMutationActionState,
  ApiKeyRotationActionState,
} from "./actions";
import type { InventoryProposalActionState } from "./inventory-actions";

setDefaultTimeout(15000);
const dom = createTestDom();
// Initial Chakra style setup can exceed the default timeout during the full suite.

const refresh = mock(() => {});
mock.module("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));
const { ApiKeysCard } = await import("./api-keys-card");
const { InventoryApprovalSetting } =
  await import("./inventory-approval-setting");
const { InventoryProposalActions } =
  await import("./inventory-proposal-actions");

// FormData must read the happy-dom form, rather than Bun's native DOM implementation.
const originalFormData = globalThis.FormData;
globalThis.FormData = window.FormData;
afterAll(() => {
  globalThis.FormData = originalFormData;
});
beforeEach(() => {
  refresh.mockClear();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function button(name: string) {
  const found = [...dom.container.querySelectorAll("button")].find(
    (node) => node.textContent?.replaceAll("Loading...", "").trim() === name,
  );
  if (!found) throw new Error(`Missing button: ${name}`);
  return found;
}
const credential: ApiKeySummary = {
  id: "key-1",
  name: "CLI",
  createdAt: new Date("2026-07-28T10:00:00Z"),
  expiresAt: null,
  lastRequestAt: null,
  maskedKey: "qs_key_masked...",
  preset: "custom",
  permissions: ["todos:read"],
  status: "active",
  replacementCredentialId: null,
  revokedAt: null,
  rotatedFromCredentialId: null,
  rotationOverlapEndsAt: null,
};

async function submit(form: HTMLFormElement) {
  await act(async () => {
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
  });
}

async function settle(resolve: () => void) {
  await act(async () => {
    resolve();
    await new Promise((done) => setTimeout(done, 0));
  });
}

describe("Settings controls", () => {
  test("submits custom grants, reveals secrets only after success, rotates and revokes without refetching", async () => {
    const creation = deferred<ApiKeyActionState>();
    const rotation = deferred<ApiKeyRotationActionState>();
    const revocation = deferred<ApiKeyMutationActionState>();
    const create = mock(
      (_state: ApiKeyActionState, _data: FormData) => creation.promise,
    );
    const rotate = mock(
      (_state: ApiKeyRotationActionState, _data: FormData) => rotation.promise,
    );
    const revoke = mock(
      (_state: ApiKeyMutationActionState, _data: FormData) =>
        revocation.promise,
    );
    await dom.render(
      <ApiKeysCard
        createAction={create}
        rotateAction={rotate}
        revokeAction={revoke}
        initialCredentials={[]}
      />,
    );
    expect(dom.container.textContent).toContain("No API keys created yet.");
    await dom.type(
      dom.container.querySelector<HTMLInputElement>('[name="name"]')!,
      "CLI",
    );
    await dom.click(
      dom.container.querySelector('[name="preset"][value="custom"]')!,
    );
    await dom.click(
      dom.container.querySelector('[name="permissionId"][value="todos:read"]')!,
    );
    await submit(dom.container.querySelector("form")!);
    expect(create.mock.calls[0]![1].get("name")).toBe("CLI");
    expect(create.mock.calls[0]![1].get("preset")).toBe("custom");
    expect(create.mock.calls[0]![1].getAll("permissionId")).toEqual([
      "todos:read",
    ]);
    expect(button("Create credential").disabled).toBe(true);
    expect(dom.container.textContent).not.toContain("One-time API key");
    await settle(() =>
      creation.resolve({
        status: "success",
        message: "Created",
        credential,
        secret: "qs_key_first_secret",
      }),
    );
    expect(dom.container.textContent).toContain("qs_key_first_secret");
    expect(dom.container.textContent).toContain("qs_key_masked...");
    expect(
      dom.container.querySelector<HTMLInputElement>(
        '[name="preset"][value="reader"]',
      )!.checked,
    ).toBe(true);
    const overlap = dom.container.querySelector<HTMLElement>(
      'button[aria-label="Rotate overlap"]',
    )!;
    await chooseOption(overlap, "60 min");
    await submit(overlap.closest("form")!);
    expect(rotate.mock.calls[0]![1].get("credentialId")).toBe("key-1");
    expect(rotate.mock.calls[0]![1].get("overlapMinutes")).toBe("60");
    await settle(() =>
      rotation.resolve({
        status: "success",
        message: "Rotated",
        credential: { ...credential, id: "key-2" },
        revokedCredential: { ...credential, status: "rotating" },
        secret: "qs_key_rotated_secret",
      }),
    );
    expect(dom.container.textContent).toContain("qs_key_rotated_secret");
    expect(dom.container.textContent).not.toContain("qs_key_first_secret");
    await dom.click(button("Revoke"));
    expect(revoke.mock.calls[0]![1].get("credentialId")).toBe("key-2");
    await settle(() =>
      revocation.resolve({
        status: "success",
        message: "Revoked",
        credential: { ...credential, id: "key-2", status: "revoked" },
      }),
    );
    expect(dom.container.textContent).not.toContain("qs_key_rotated_secret");
    expect(dom.container.textContent).toContain("Revoked");
    expect(refresh).not.toHaveBeenCalled();
  });

  test("keeps API-key drafts and focus after a rejected creation", async () => {
    const creation = deferred<ApiKeyActionState>();
    await dom.render(
      <ApiKeysCard
        initialCredentials={[]}
        createAction={() => creation.promise}
        rotateAction={async () => {
          throw new Error("Unexpected rotation");
        }}
        revokeAction={async () => {
          throw new Error("Unexpected revocation");
        }}
      />,
    );
    const name =
      dom.container.querySelector<HTMLInputElement>('[name="name"]')!;
    await dom.type(name, "Keep this draft");
    await submit(name.closest("form")!);
    await settle(() =>
      creation.resolve({
        status: "error",
        message: "Creation failed",
        credential: null,
        secret: null,
      }),
    );
    expect(name.value).toBe("Keep this draft");
    expect(document.activeElement).toBe(name);
    expect(dom.container.textContent).toContain("Creation failed");
    expect(button("Create credential").disabled).toBe(false);
  });

  test("sends inventory approval preferences and proposal identities, retaining errors", async () => {
    const saving = deferred<InventoryProposalActionState>();
    const save = mock(
      (_state: InventoryProposalActionState, _data: FormData) => saving.promise,
    );
    const approve = mock(
      async (
        _state: InventoryProposalActionState,
        _data: FormData,
      ): Promise<InventoryProposalActionState> => ({
        status: "success",
        message: "Approved",
      }),
    );
    const rejecting = deferred<InventoryProposalActionState>();
    const reject = mock(
      (_state: InventoryProposalActionState, _data: FormData) =>
        rejecting.promise,
    );
    await dom.render(
      <>
        <InventoryApprovalSetting action={save} autoApproveFuture={false} />
        <InventoryProposalActions
          approveAction={approve}
          rejectAction={reject}
          itemId="item-1"
          jobId="job-1"
        />
      </>,
    );
    const checkbox = dom.container.querySelector<HTMLInputElement>(
      '[name="autoApproveFuture"]',
    )!;
    await dom.click(checkbox);
    await submit(checkbox.closest("form")!);
    expect(save.mock.calls[0]![1].get("autoApproveFuture")).toBe("on");
    expect(checkbox.checked).toBe(true);
    expect(button("Save").disabled).toBe(true);
    expect(button("Approve proposal").disabled).toBe(false);
    await dom.click(button("Reject proposal"));
    expect(reject.mock.calls[0]![1].get("itemId")).toBe("item-1");
    expect(reject.mock.calls[0]![1].get("jobId")).toBe("job-1");
    expect(button("Approve proposal").disabled).toBe(true);
    await settle(() => {
      rejecting.resolve({ status: "error", message: "Rejection failed" });
      saving.resolve({ status: "success", message: "Saved" });
    });
    expect(dom.container.textContent).toContain("Rejection failed");
    expect(button("Approve proposal").disabled).toBe(false);
    await dom.click(button("Approve proposal"));
    expect(approve.mock.calls[0]![1].get("itemId")).toBe("item-1");
    expect(approve.mock.calls[0]![1].get("jobId")).toBe("job-1");
    expect(dom.container.textContent).toContain("Approved");
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
