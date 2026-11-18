import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client";

let reader: PrismaClient | undefined;

export function getUmamiReader() {
  const connectionString = process.env.QUANTSELF_UMAMI_READ_DATABASE_URL;
  if (!connectionString) throw Error("The Umami read database is not configured.");
  reader ??= new PrismaClient({
    adapter: new PrismaPg({ connectionString, max: 3, statement_timeout: 10_000 }),
  });
  return reader;
}
