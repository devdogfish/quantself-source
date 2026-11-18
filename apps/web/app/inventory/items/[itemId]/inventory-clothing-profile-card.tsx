"use client";

import {
  Badge,
  Button,
  Card,
  Field,
  Flex,
  Grid,
  Input,
  Spinner,
  Stack,
  Text,
  Textarea,
  chakra,
} from "@chakra-ui/react";
import { itemButton } from "./inventory-item-button-styles";
import { useActionState } from "react";
import { InventoryItemSelectField } from "./inventory-item-select-field";

import type { InventoryActionState } from "../../action-state";
import type { InventoryClothingProfile } from "@/lib/quantself-api-client";

type ClothingProfileAction = (
  state: InventoryActionState,
  formData: FormData,
) => Promise<InventoryActionState>;

const initialState: InventoryActionState = {
  message: "",
  status: "idle",
};

export function InventoryClothingProfileCard({
  clothingProfile,
  itemId,
  updateAction,
}: {
  clothingProfile: NonNullable<InventoryClothingProfile>;
  itemId: string;
  updateAction: ClothingProfileAction;
}) {
  const [state, formAction, pending] = useActionState(
    updateAction,
    initialState,
  );
  const attributes = clothingProfile.attributes;

  return (
    <Card.Root
      size="sm"
      borderRadius="0.875rem"
      overflow="hidden"
      gap="4"
      py="4"
    >
      <Card.Header px="4" py="0">
        <Card.Title as="h2" fontSize="md" fontWeight="medium" lineHeight="snug">
          Clothing profile
        </Card.Title>
      </Card.Header>
      <Card.Body px="4" py="0" flex="initial" display="grid" gap="4">
        <Flex alignItems="center" justifyContent="space-between" gap="3">
          <Text color="fg.muted" fontSize="sm">
            Optional decision facts and explicit clean or dirty correction.
          </Text>
          <Badge
            borderRadius="full"
            size="sm"
            flexShrink={0}
            w="fit-content"
            variant="subtle"
            colorPalette={clothingProfile.isDirty ? "red" : "gray"}
          >
            {clothingProfile.isDirty ? "Dirty" : "Clean"}
          </Badge>
        </Flex>

        <chakra.form action={formAction} display="grid" gap="4">
          <input name="itemId" type="hidden" value={itemId} />

          <Stack gap="4">
            <Grid
              gap="4"
              css={{
                "@media (width >= 40rem)": {
                  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                },
              }}
            >
              <InventoryItemSelectField
                defaultValue={clothingProfile.isDirty ? "true" : "false"}
                label="Wear state"
                name="isDirty"
                options={[
                  { label: "Clean", value: "false" },
                  { label: "Dirty", value: "true" },
                ]}
                id="clothing-isDirty"
              />
              <Field.Root gap="2">
                <Field.Label htmlFor="clothing-kind">Kind</Field.Label>
                <Input
                  size="sm"
                  borderRadius="md"
                  defaultValue={attributes.kind ?? ""}
                  id="clothing-kind"
                  name="clothingKind"
                  placeholder="shirt"
                />
              </Field.Root>
              <Field.Root gap="2">
                <Field.Label htmlFor="clothing-colors">Colors</Field.Label>
                <Input
                  size="sm"
                  borderRadius="md"
                  defaultValue={attributes.colors?.join(", ") ?? ""}
                  id="clothing-colors"
                  name="clothingColors"
                  placeholder="blue, white"
                />
              </Field.Root>
              <Field.Root gap="2">
                <Field.Label htmlFor="clothing-layer">Layer</Field.Label>
                <Input
                  size="sm"
                  borderRadius="md"
                  defaultValue={attributes.layer ?? ""}
                  id="clothing-layer"
                  name="clothingLayer"
                  placeholder="base"
                />
              </Field.Root>
              <Field.Root gap="2">
                <Field.Label htmlFor="clothing-warmth">Warmth</Field.Label>
                <Input
                  size="sm"
                  borderRadius="md"
                  defaultValue={attributes.warmth ?? ""}
                  id="clothing-warmth"
                  name="clothingWarmth"
                  placeholder="medium"
                />
              </Field.Root>
              <Field.Root gap="2">
                <Field.Label htmlFor="clothing-formality">
                  Formality
                </Field.Label>
                <Input
                  size="sm"
                  borderRadius="md"
                  defaultValue={attributes.formality ?? ""}
                  id="clothing-formality"
                  name="clothingFormality"
                  placeholder="smart-casual"
                />
              </Field.Root>
              <Field.Root gap="2">
                <Field.Label htmlFor="clothing-weather">Weather</Field.Label>
                <Input
                  size="sm"
                  borderRadius="md"
                  defaultValue={attributes.weather?.join(", ") ?? ""}
                  id="clothing-weather"
                  name="clothingWeather"
                  placeholder="mild, cool"
                />
              </Field.Root>
              <Field.Root gap="2">
                <Field.Label htmlFor="clothing-occasions">
                  Occasions
                </Field.Label>
                <Input
                  size="sm"
                  borderRadius="md"
                  defaultValue={attributes.occasionTags?.join(", ") ?? ""}
                  id="clothing-occasions"
                  name="clothingOccasionTags"
                  placeholder="office, travel"
                />
              </Field.Root>
              <Field.Root
                gap="2"
                css={{
                  "@media (width >= 40rem)": { gridColumn: "span 2 / span 2" },
                }}
              >
                <Field.Label htmlFor="clothing-material">Material</Field.Label>
                <Input
                  size="sm"
                  borderRadius="md"
                  defaultValue={attributes.material ?? ""}
                  id="clothing-material"
                  name="clothingMaterial"
                  placeholder="cotton"
                />
              </Field.Root>
              <Field.Root
                gap="2"
                css={{
                  "@media (width >= 40rem)": { gridColumn: "span 2 / span 2" },
                }}
              >
                <Field.Label htmlFor="clothing-fit-notes">
                  Fit notes
                </Field.Label>
                <Textarea
                  size="sm"
                  borderRadius="md"
                  defaultValue={attributes.fitNotes ?? ""}
                  id="clothing-fit-notes"
                  name="clothingFitNotes"
                  rows={3}
                />
              </Field.Root>
              <Field.Root
                gap="2"
                css={{
                  "@media (width >= 40rem)": { gridColumn: "span 2 / span 2" },
                }}
              >
                <Field.Label htmlFor="clothing-decision-notes">
                  Decision notes
                </Field.Label>
                <Textarea
                  size="sm"
                  borderRadius="md"
                  defaultValue={attributes.decisionNotes ?? ""}
                  id="clothing-decision-notes"
                  name="clothingDecisionNotes"
                  rows={3}
                />
              </Field.Root>
            </Grid>
          </Stack>

          {state.status !== "idle" ? (
            <Text
              aria-live="polite"
              fontSize="sm"
              color={state.status === "error" ? "fg.error" : undefined}
            >
              {state.message}
            </Text>
          ) : null}

          <Flex justifyContent="end">
            <Button
              {...itemButton}
              aria-busy={pending}
              disabled={pending}
              type="submit"
            >
              {pending && <Spinner size="xs" />}
              Save clothing profile
            </Button>
          </Flex>
        </chakra.form>
      </Card.Body>
    </Card.Root>
  );
}
