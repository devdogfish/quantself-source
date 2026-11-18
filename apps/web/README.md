# QuantSelf Web

Next.js App Router Web Client using React, TypeScript, Chakra UI v3, Lucide
icons, and Bun.

## Development

Run from the repository root:

```bash
bun install
bun run dev
```

The root development command starts the full Docker stack. See the
[root README](../../README.md) for endpoints and deployment.

## UI components

Compose Chakra UI v3 primitives with `components/shared` for page headers,
tables, filters, and dashboard panels. Keep feature-specific components beside
their routes. Use semantic tokens, built-in variants, and Lucide icons.

The root layout mounts the Chakra provider and toaster. The theme, color mode,
and brand palette live in [`components/chakra`](components/chakra). The
[Emotion registry](https://chakra-ui.com/docs/get-started/frameworks/next-app#stream-through-suspense-optional)
inserts server styles before hydration.

Use the shared `FilterSelect` and Chakra `Checkbox`, `RadioGroup`, or
`RadioCard` for choice inputs. Wrap component tests with `ChakraTestWrapper`
from [`test-utils.tsx`](components/chakra/test-utils.tsx).

## Verification

From the repository root:

```bash
bun run test
bun run typecheck
bun run build
bun run --cwd apps/web lint
```

Run focused interaction tests while changing a component, then verify the full
project. Check keyboard navigation, dialog focus, form validation, and responsive
layouts for affected flows.
