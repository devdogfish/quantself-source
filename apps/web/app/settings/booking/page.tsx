import NextLink from "next/link";
import { Button } from "@chakra-ui/react";
import { PageBody, PageHeader } from "@/components/shared/page-layout";
import { BookingSettings } from "./booking-settings";

export const metadata = { title: "Booking hours · Quantself" };

export default function BookingSettingsPage() {
  return <>
    <PageHeader title="Booking hours" actions={<Button size="sm" variant="outline" asChild><NextLink href="/calendar">Calendar</NextLink></Button>} />
    <PageBody pt="0"><BookingSettings /></PageBody>
  </>;
}
