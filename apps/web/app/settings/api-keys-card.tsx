"use client";

import {
  Badge,
  Box,
  Button,
  Checkbox,
  Field,
  Flex,
  Grid,
  Input,
  RadioCard,
  Spinner,
  Stack,
  Text,
  chakra,
} from "@chakra-ui/react";
import { FilterSelect } from "@/components/shared/filter-select";
import { KeyRoundIcon } from "lucide-react";
import { useRef, useState, useTransition } from "react";
import {
  API_KEY_PERMISSION_GROUPS,
  type ApiKeyPreset,
  type ApiKeySummary,
} from "@quantself/auth/api-key-contract";
import { SettingsRow } from "./settings-row";
import type {
  ApiKeyActionState,
  ApiKeyMutationActionState,
  ApiKeyRotationActionState,
} from "./actions";

type CreateApiKeyAction = (
  state: ApiKeyActionState,
  formData: FormData,
) => Promise<ApiKeyActionState>;

type RevokeApiKeyAction = (
  state: ApiKeyMutationActionState,
  formData: FormData,
) => Promise<ApiKeyMutationActionState>;

type RotateApiKeyAction = (
  state: ApiKeyRotationActionState,
  formData: FormData,
) => Promise<ApiKeyRotationActionState>;

const INITIAL_CREATE_STATE: ApiKeyActionState = {
  credential: null,
  message: "",
  secret: null,
  status: "idle",
};

const INITIAL_MUTATION_STATE: ApiKeyMutationActionState = {
  credential: null,
  message: "",
  status: "idle",
};

const INITIAL_ROTATION_STATE: ApiKeyRotationActionState = {
  credential: null,
  message: "",
  revokedCredential: null,
  secret: null,
  status: "idle",
};

const PRESET_OPTIONS: Array<{
  description: string;
  label: string;
  value: ApiKeyPreset;
}> = [
  {
    description:
      "Read Health, Inventory, and Notes. To-Do requires custom grants.",
    label: "Reader",
    value: "reader",
  },
  {
    description:
      "Read and write Health, Inventory, and Notes. To-Do requires custom grants.",
    label: "Editor",
    value: "editor",
  },
  {
    description:
      "Read, write, and delete Health, Inventory, and Notes. To-Do requires custom grants.",
    label: "Maintainer",
    value: "maintainer",
  },
  {
    description: "Pick exact permissions for a specialized Client.",
    label: "Custom permissions",
    value: "custom",
  },
] as const;

const ROTATION_OVERLAP_OPTIONS = [
  { label: "5 min", value: "5" },
  { label: "15 min", value: "15" },
  { label: "60 min", value: "60" },
] as const;

const ACTION_LABELS = {
  approve: "Approve execution",
  book: "Book and cancel meetings",
  delete: "Delete",
  execute: "Execute approved submissions",
  "import-tailored": "Import draft applications",
  read: "Read",
  revise: "Revise summaries",
  write: "Write",
} as const;

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
});

export function ApiKeysCard({
  createAction,
  initialCredentials,
  revokeAction,
  rotateAction,
}: {
  createAction: CreateApiKeyAction;
  initialCredentials: ApiKeySummary[];
  revokeAction: RevokeApiKeyAction;
  rotateAction: RotateApiKeyAction;
}) {
  const formRef = useRef<HTMLFormElement | null>(null);
  const [credentials, setCredentials] = useState(initialCredentials);
  const [feedback, setFeedback] = useState<{
    message: string;
    status: "idle" | "success" | "error";
  }>({
    message: "",
    status: "idle",
  });
  const [preset, setPreset] = useState<ApiKeyPreset>("reader");
  const [secret, setSecret] = useState<string | null>(null);
  const [selectedPermissions, setSelectedPermissions] = useState<string[]>([]);
  const [pending, startTransition] = useTransition();

  function togglePermission(permissionId: string, checked: boolean) {
    setSelectedPermissions((current) => {
      if (!checked) {
        return current.filter((value) => value !== permissionId);
      }

      if (current.includes(permissionId)) {
        return current;
      }

      return [...current, permissionId];
    });
  }

  function submitCreateCredential(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);

    startTransition(async () => {
      const nextState = await createAction(INITIAL_CREATE_STATE, formData);
      setFeedback({
        message: nextState.message,
        status: nextState.status,
      });
      setSecret(nextState.status === "success" ? nextState.secret : null);

      if (nextState.status !== "success" || !nextState.credential) {
        return;
      }

      upsertCredential(nextState.credential);
      formRef.current?.reset();
      setPreset("reader");
      setSelectedPermissions([]);
    });
  }

  function submitRotateCredential(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);

    startTransition(async () => {
      const nextState = await rotateAction(INITIAL_ROTATION_STATE, formData);
      setFeedback({
        message: nextState.message,
        status: nextState.status,
      });
      setSecret(nextState.status === "success" ? nextState.secret : null);

      if (
        nextState.status !== "success" ||
        !nextState.credential ||
        !nextState.revokedCredential
      ) {
        return;
      }

      const nextCredential = nextState.credential;
      const nextRevokedCredential = nextState.revokedCredential;

      setCredentials((current) =>
        sortApiKeys([
          nextCredential,
          nextRevokedCredential,
          ...current.filter(
            (credential) =>
              credential.id !== nextCredential.id &&
              credential.id !== nextRevokedCredential.id,
          ),
        ]),
      );
    });
  }

  function revokeCredential(credentialId: string) {
    const formData = new FormData();
    formData.set("credentialId", credentialId);

    startTransition(async () => {
      const nextState = await revokeAction(INITIAL_MUTATION_STATE, formData);
      setFeedback({
        message: nextState.message,
        status: nextState.status,
      });
      setSecret(null);

      if (nextState.status !== "success" || !nextState.credential) {
        return;
      }

      upsertCredential(nextState.credential);
    });
  }

  function upsertCredential(credential: ApiKeySummary) {
    setCredentials((current) =>
      sortApiKeys([
        credential,
        ...current.filter((item) => item.id !== credential.id),
      ]),
    );
  }

  return (
    <SettingsRow
      title="API keys"
      help="Create one API key per agent, worker, device, or CLI install. The full secret appears only once after creation or rotation."
    >
      <Stack gap="5">
        <chakra.form
          display="grid"
          gap="4"
          onSubmit={submitCreateCredential}
          ref={formRef}
        >
          <Field.Root required>
            <Field.Label
              fontWeight="medium"
              fontSize="sm"
              htmlFor="api-key-name"
            >
              Create credential
            </Field.Label>
            <Input
              id="api-key-name"
              name="name"
              placeholder="CLI install"
              required
            />
          </Field.Root>

          <Field.Root maxW={{ md: "56" }}>
            <Field.Label
              fontWeight="medium"
              fontSize="sm"
              htmlFor="api-key-expiry"
            >
              Optional expiry (hours)
            </Field.Label>
            <Input
              id="api-key-expiry"
              min="1"
              name="expiresInHours"
              placeholder="24"
              step="1"
              type="number"
            />
            <Field.HelperText>Leave empty for no expiry.</Field.HelperText>
          </Field.Root>

          <chakra.fieldset display="grid" gap="2">
            <chakra.legend fontWeight="medium" fontSize="sm">
              Permission preset
            </chakra.legend>
            <RadioCard.Root
              aria-label="Permission preset"
              name="preset"
              size="sm"
              value={preset}
              onValueChange={(e) => e.value && setPreset(e.value as ApiKeyPreset)}
            >
              <Grid gap="2">
                {PRESET_OPTIONS.map((option) => (
                  <RadioCard.Item key={option.value} value={option.value}>
                    <RadioCard.ItemHiddenInput />
                    <RadioCard.ItemControl>
                      <RadioCard.ItemContent>
                        <RadioCard.ItemText>{option.label}</RadioCard.ItemText>
                        <RadioCard.ItemDescription>
                          {option.description}
                        </RadioCard.ItemDescription>
                      </RadioCard.ItemContent>
                      <RadioCard.ItemIndicator />
                    </RadioCard.ItemControl>
                  </RadioCard.Item>
                ))}
              </Grid>
            </RadioCard.Root>
          </chakra.fieldset>

          <chakra.fieldset display="grid" gap="3">
            <chakra.legend fontWeight="medium" fontSize="sm">
              Custom permissions
            </chakra.legend>
            <Grid
              gap="3"
              gridTemplateColumns={{
                base: "1fr",
                md: "repeat(2, minmax(0, 1fr))",
              }}
            >
              {API_KEY_PERMISSION_GROUPS.filter(group => group.domain !== "personal-assistant").map((group) => (
                <Box
                  rounded="md"
                  borderWidth="1px"
                  borderColor="border"
                  bg="bg"
                  p="3"
                  key={group.domain}
                >
                  <Text fontWeight="medium" fontSize="sm">
                    {group.label}
                  </Text>
                  <Text mt="1" color="fg.muted" fontSize="xs">
                    {group.description}
                  </Text>
                  <Grid mt="3" gap="2">
                    {group.actions.filter(action => action !== "schedule-interview").map((actionName) => {
                      const permissionId = `${group.domain}:${actionName}`;

                      return (
                        <Checkbox.Root
                          checked={selectedPermissions.includes(permissionId)}
                          disabled={preset !== "custom"}
                          name="permissionId"
                          onCheckedChange={(event) =>
                            togglePermission(permissionId, event.checked === true)
                          }
                          value={permissionId}
                          fontSize="sm"
                          key={permissionId}
                        >
                          <Checkbox.HiddenInput />
                          <Checkbox.Control />
                          <Checkbox.Label>{ACTION_LABELS[actionName]}</Checkbox.Label>
                        </Checkbox.Root>
                      );
                    })}
                  </Grid>
                </Box>
              ))}
            </Grid>
          </chakra.fieldset>

          <Flex flexWrap="wrap" alignItems="center" gap="2">
            <Button disabled={pending} type="submit">
              {pending ? <Spinner size="sm" /> : null}
              <KeyRoundIcon size={16} />
              Create credential
            </Button>
          </Flex>

          {secret ? (
            <Box
              rounded="md"
              borderWidth="1px"
              borderColor="border"
              bg="bg"
              p="3"
            >
              <Text fontWeight="medium" fontSize="sm">
                One-time API key
              </Text>
              <Text mt="1" color="fg.muted" fontSize="sm">
                Copy this now. Later views show only masked identity and safe
                metadata. Send it in the X-API-Key header.
              </Text>
              <chakra.code
                mt="3"
                display="block"
                overflowX="auto"
                rounded="md"
                bg="bg.subtle"
                px="3"
                py="2"
                fontFamily="mono"
                fontSize="sm"
              >
                {secret}
              </chakra.code>
            </Box>
          ) : null}

          <Text
            aria-live="polite"
            color={feedback.status === "error" ? "fg.error" : "fg.muted"}
            minH="5"
            fontSize="sm"
          >
            {feedback.message}
          </Text>
        </chakra.form>

        <Grid gap="3">
          {credentials.length > 0 ? (
            credentials.map((credential) => (
              <Box
                rounded="md"
                borderWidth="1px"
                borderColor="border"
                bg="bg"
                p="3"
                key={credential.id}
              >
                <Flex
                  flexWrap="wrap"
                  alignItems="start"
                  justifyContent="space-between"
                  gap="2"
                >
                  <Box minW="0">
                    <Text fontWeight="medium" fontSize="sm">
                      {credential.name}
                    </Text>
                    <Text color="fg.muted" fontSize="xs">
                      {credential.maskedKey}
                    </Text>
                  </Box>
                  <Flex flexWrap="wrap" gap="2">
                    <Badge variant="subtle">
                      {credential.preset === "custom"
                        ? "Custom"
                        : credential.preset[0]!.toUpperCase() +
                          credential.preset.slice(1)}
                    </Badge>
                    <Badge
                      colorPalette={
                        credential.status === "revoked" ? "red" : undefined
                      }
                      variant={statusVariant(credential.status)}
                    >
                      {credential.status}
                    </Badge>
                  </Flex>
                </Flex>

                <Grid
                  mt="3"
                  gap="2"
                  fontSize="xs"
                  color="fg.muted"
                  gridTemplateColumns={{
                    base: "1fr",
                    md: "repeat(4, minmax(0, 1fr))",
                  }}
                >
                  <Text>
                    Created {dateFormatter.format(credential.createdAt)}
                  </Text>
                  <Text>
                    {credential.lastRequestAt
                      ? `Last used ${dateFormatter.format(
                          credential.lastRequestAt,
                        )}`
                      : "Last used never"}
                  </Text>
                  <Text>
                    {credential.expiresAt
                      ? `Expires ${dateFormatter.format(credential.expiresAt)}`
                      : "No expiry"}
                  </Text>
                  <Text>{lifecycleLabel(credential)}</Text>
                </Grid>

                <Flex mt="3" flexWrap="wrap" gap="2">
                  {credential.permissions.map((permission) => (
                    <Badge key={permission} variant="outline">
                      {permission}
                    </Badge>
                  ))}
                </Flex>

                <Flex
                  mt="3"
                  flexWrap="wrap"
                  alignItems="center"
                  gap="2"
                >
                  {credential.status === "active" ? (
                    <chakra.form
                      display="flex"
                      flexWrap="wrap"
                      alignItems="center"
                      gap="2"
                      onSubmit={submitRotateCredential}
                    >
                      <chakra.input
                        name="credentialId"
                        type="hidden"
                        value={credential.id}
                      />
                      <chakra.label
                        fontWeight="medium"
                        fontSize="xs"
                        htmlFor={`overlap-${credential.id}`}
                      >
                        Rotate overlap
                      </chakra.label>
                      <FilterSelect
                        defaultValue="15"
                        highlightActive={false}
                        items={ROTATION_OVERLAP_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
                        label="Rotate overlap"
                        name="overlapMinutes"
                        size="sm"
                        w="auto"
                      />
                      <Button
                        disabled={pending}
                        size="xs"
                        type="submit"
                        variant="outline"
                      >
                        {pending ? <Spinner size="sm" /> : null}
                        Rotate
                      </Button>
                    </chakra.form>
                  ) : null}
                  {credential.status !== "revoked" ? (
                    <Button
                      type="button"
                      disabled={pending}
                      onClick={() => revokeCredential(credential.id)}
                      size="xs"
                      colorPalette="red"
                      variant="subtle"
                    >
                      {pending ? <Spinner size="sm" /> : null}
                      Revoke
                    </Button>
                  ) : null}
                </Flex>
              </Box>
            ))
          ) : (
            <Box
              rounded="md"
              borderWidth="1px"
              borderStyle="dashed"
              borderColor="border"
              bg="bg"
              p="3"
            >
              <Text color="fg.muted" fontSize="sm">
                No API keys created yet.
              </Text>
            </Box>
          )}
        </Grid>
      </Stack>
    </SettingsRow>
  );
}

function lifecycleLabel(credential: ApiKeySummary) {
  if (credential.status === "rotating" && credential.rotationOverlapEndsAt) {
    return `Overlap ends ${dateFormatter.format(credential.rotationOverlapEndsAt)}`;
  }

  if (credential.status === "revoked" && credential.revokedAt) {
    return `Revoked ${dateFormatter.format(credential.revokedAt)}`;
  }

  if (credential.rotatedFromCredentialId) {
    return `Replacement for ${credential.rotatedFromCredentialId}`;
  }

  return "No rotation pending";
}

function sortApiKeys(credentials: ApiKeySummary[]) {
  return [...credentials].sort((left, right) => {
    const createdAtDelta = right.createdAt.getTime() - left.createdAt.getTime();

    return createdAtDelta !== 0
      ? createdAtDelta
      : left.name.localeCompare(right.name);
  });
}

function statusVariant(status: ApiKeySummary["status"]) {
  switch (status) {
    case "active":
      return "solid";
    case "rotating":
      return "outline";
    case "disabled":
    case "expired":
    case "revoked":
      return "subtle";
  }
}
