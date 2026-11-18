# Prisma Multi-File Schema Layout

Prisma schema files use Prisma's documented multi-file layout: root `packages/db/prisma/schema.prisma`, models in `packages/db/prisma/models/*.prisma`, and config `schema: "prisma"`. This keeps migrations beside `schema.prisma` and avoids custom nested schema directories that future tools or agents may "correct" differently. Source: https://www.prisma.io/docs/orm/prisma-schema/overview/location#multi-file-prisma-schema
