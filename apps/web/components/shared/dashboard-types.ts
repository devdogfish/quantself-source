// Generic data shapes and number formatting shared by the dashboard building blocks.
import type { Route } from "next";export type Part = { name: string; value: number; color: string; to?: string; hint?: string };
// One x position of a trend: a label plus a numeric value per series key.
export type Point = { label: string; values: Record<string, number> };
export type TrendSeries = { key: string; label: string; color: string };

const INT = new Intl.NumberFormat("en-US");
export const formatInt = (n: number) => INT.format(Math.round(n));
export const cssVar = (token: string) => `var(--chakra-colors-${token.replace(/\./g, "-")})`;
// Hrefs here are plain strings from callers; typed routes only know static ones.
export const asRoute = (href: string) => href as Route;
