"use client";

import { chakra } from "@chakra-ui/react";
import type { Receipt } from "../budgeting-client";
import { documentMoney } from "./document-format";

export function InvoiceSummary({ invoice }: { invoice: Receipt }) {
  return <chakra.article aria-label="Invoice summary" mx="auto" display="grid" width="full" maxW="2xl" gap="5" rounded="lg" borderWidth="1px" bg="bg.panel" p={{ base: "5", sm: "7" }}>
    <chakra.header display="flex" flexWrap="wrap" justifyContent="space-between" gap="3" borderBottomWidth="1px" pb="4">
      <chakra.div>
        <chakra.p fontSize="sm" fontWeight="medium" color="fg.muted">Invoice</chakra.p>
        <chakra.h2 fontSize="xl" fontWeight="semibold">{invoice.merchant || invoice.title || "Untitled invoice"}</chakra.h2>
      </chakra.div>
      {invoice.invoiceNumber && <chakra.p wordBreak="break-all" fontSize="sm" color="fg.muted">#{invoice.invoiceNumber}</chakra.p>}
    </chakra.header>
    <chakra.dl display="grid" gridTemplateColumns="repeat(2, minmax(0, 1fr))" gap="3" fontSize="sm">
      <chakra.div><chakra.dt color="fg.muted">Issued</chakra.dt><chakra.dd>{invoice.date || "—"}</chakra.dd></chakra.div>
      <chakra.div><chakra.dt color="fg.muted">Due</chakra.dt><chakra.dd>{invoice.dueDate || "—"}</chakra.dd></chakra.div>
    </chakra.dl>
    {invoice.lines.length > 0 && <chakra.table width="full" fontSize="sm">
      <chakra.caption srOnly={true}>Extracted invoice lines</chakra.caption>
      <chakra.tbody>{invoice.lines.map((line, index) => <chakra.tr key={index} borderBottomWidth="1px" _last={{ borderWidth: 0 }}>
        <chakra.td whiteSpace="pre-wrap" overflowWrap="break-word" py="2" pr="3">{line.text}</chakra.td>
        <chakra.td whiteSpace="nowrap" textAlign="right" fontVariantNumeric="tabular-nums">{line.amount}</chakra.td>
      </chakra.tr>)}</chakra.tbody>
    </chakra.table>}
    <chakra.footer display="flex" flexWrap="wrap" alignItems="center" justifyContent="space-between" gap="3" borderTopWidth="1px" pt="4">
      <chakra.div><chakra.p fontSize="sm" color="fg.muted">Document total</chakra.p>
        <chakra.p fontSize="xl" fontWeight="semibold" fontVariantNumeric="tabular-nums">{invoice.totalCents === null ? "—" : documentMoney(invoice.totalCents, invoice.currency)}</chakra.p></chakra.div>
      {invoice.amazonAsin && <chakra.a color="colorPalette.fg" textDecoration="underline" href={`https://www.amazon.ca/dp/${invoice.amazonAsin}`} target="_blank" rel="noreferrer">View Amazon product</chakra.a>}
    </chakra.footer>
  </chakra.article>;
}
