"use client";

// Thin composition for the reference crawl-table look: bordered column wrapper, header row, link rows, empty state.
import Link from "next/link";
import { Children, createContext, useContext, useId, type ComponentProps } from "react";
import { Box, Flex, Grid, chakra } from "@chakra-ui/react";
import { asRoute } from "./dashboard-types";

// Bordered rounded column: put DataToolbar, DataGrid and TablePagination inside.
export function DataPanel({ children }: { children: React.ReactNode }) {
  return <Flex direction="column" borderWidth="1px" rounded="l2" overflow="hidden">{children}</Flex>;
}

const HeaderIds = createContext<string[]>([]);

// Header row + rows scroll sideways inside the panel; `columns` is a CSS grid-template-columns value shared by all rows.
export function DataGrid({ columns, minW = "980px", headers, empty = "No results.", children, label }: {
  label?: string; columns: string; minW?: string; headers: { label: string; align?: "right" }[]; empty?: string; children: React.ReactNode[] | React.ReactNode;
}) {
  const rows = Children.toArray(children);
  const id = useId();
  const headerIds = headers.map((_, index) => `${id}-column-${index}`);
  return (
    <Box overflowX="auto">
      <Box as="table" role="table" aria-label={label} minW={minW} width="full" display="block">
        <Box as="thead" role="rowgroup" display="block">
          <Grid as="tr" role="row" templateColumns={columns} gap="4" px="4" py="2" borderBottomWidth="1px" textStyle="xs" fontWeight="medium" color="fg.muted">
            {headers.map((h, index) => <chakra.th role="columnheader" scope="col" id={headerIds[index]} key={h.label} textAlign={h.align ?? "left"}>{h.label}</chakra.th>)}
          </Grid>
        </Box>
        <Box as="tbody" role="rowgroup" display="block">
          <HeaderIds.Provider value={headerIds}>
            {rows.length === 0 ? <Box as="tr" role="row"><chakra.td role="cell" colSpan={headers.length} p="4" textStyle="sm" color="fg.muted">{empty}</chakra.td></Box> : rows}
          </HeaderIds.Provider>
        </Box>
      </Box>
    </Box>
  );
}

// A native link in the first cell stretches over the row, preserving table and link navigation.
export function DataGridRow({ columns, href, prefetch, children, linkProps }: {
  columns: string; href?: string; prefetch?: ComponentProps<typeof Link>["prefetch"]; children: React.ReactNode;
  linkProps?: Pick<ComponentProps<typeof Link>, "aria-label" | "onClick" | "onFocus" | "onBlur">;
}) {
  const headerIds = useContext(HeaderIds);
  return (
    <Grid as="tr" role="row" position="relative" templateColumns={columns} gap="4" px="4" py="2.5" alignItems="center" textStyle="sm"
      borderBottomWidth="1px" borderColor="border.muted" _hover={{ bg: "bg.subtle" }} fontVariantNumeric="tabular-nums">
      {Children.toArray(children).map((cell, index) => (
        <chakra.td role="cell" headers={headerIds[index]} key={index} minW="0" display="grid">
          {index === 0 && href ? <Box asChild _after={{ content: '""', position: "absolute", inset: "0" }}
            _focusVisible={{ outline: "none", _after: { outline: "2px solid", outlineColor: "colorPalette.focusRing", outlineOffset: "-2px" } }}>
            <Link href={asRoute(href)} prefetch={prefetch} {...linkProps}>{cell}</Link>
          </Box> : cell}
        </chakra.td>
      ))}
    </Grid>
  );
}
