"use client";
import NextLink from "next/link";
import { useState } from "react";
import { Button, CloseButton, DataList, Dialog, HStack, Link, Portal, Text } from "@chakra-ui/react";
import { ExternalLinkIcon } from "lucide-react";
import { fullDateLabel } from "../todo/task-workspace-context";
import { cancelMeeting, type MeetingItem } from "./meeting-calendar-source";

export function MeetingDetailsDialog({ item, canCancel, onClose }: { item: MeetingItem | null; canCancel: boolean; onClose: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const close = () => { setConfirming(false); onClose(); };
  const meeting = item?.meeting;
  return <Dialog.Root open={!!item} size="sm" onOpenChange={({ open }) => { if (!open) close(); }}>
    {item && meeting && <Portal>
      <Dialog.Backdrop />
      <Dialog.Positioner>
        <Dialog.Content onDoubleClick={event => event.stopPropagation()} onContextMenu={event => event.stopPropagation()}>
          <Dialog.Header><Dialog.Title>Call with {meeting.guestName}</Dialog.Title></Dialog.Header>
          <Dialog.CloseTrigger asChild><CloseButton size="sm" /></Dialog.CloseTrigger>
          <Dialog.Body>
            <DataList.Root orientation="horizontal" size="sm">
              <DataList.Item>
                <DataList.ItemLabel>Time</DataList.ItemLabel>
                <DataList.ItemValue>{fullDateLabel(item.date)}, {item.start}–{item.finish}</DataList.ItemValue>
              </DataList.Item>
              <DataList.Item>
                <DataList.ItemLabel>Guest</DataList.ItemLabel>
                <DataList.ItemValue>{meeting.guestName}</DataList.ItemValue>
              </DataList.Item>
              <DataList.Item>
                <DataList.ItemLabel>Email</DataList.ItemLabel>
                <DataList.ItemValue><Link href={`mailto:${meeting.guestEmail}`} textDecoration="underline">{meeting.guestEmail}</Link></DataList.ItemValue>
              </DataList.Item>
              <DataList.Item>
                <DataList.ItemLabel>Room</DataList.ItemLabel>
                <DataList.ItemValue>{meeting.jitsiUrl
                  ? <Link href={meeting.jitsiUrl} target="_blank" rel="noreferrer" textDecoration="underline" wordBreak="break-all">{meeting.jitsiUrl}<ExternalLinkIcon size={12} /></Link>
                  : <Text color="fg.muted">Room link not configured</Text>}</DataList.ItemValue>
              </DataList.Item>
              {meeting.note && <DataList.Item>
                <DataList.ItemLabel>Note</DataList.ItemLabel>
                <DataList.ItemValue whiteSpace="pre-wrap">{meeting.note}</DataList.ItemValue>
              </DataList.Item>}
            </DataList.Root>
            {confirming && <Text mt="4" textStyle="sm" role="status">{meeting.guestName} will get a cancellation email. This can’t be undone.</Text>}
          </Dialog.Body>
          <Dialog.Footer justifyContent="space-between">
            <Link asChild textStyle="sm" color="fg.muted"><NextLink href="/settings/booking">Booking hours</NextLink></Link>
            <HStack>
              {canCancel && (confirming
                ? <>
                  <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>Keep</Button>
                  <Button size="sm" colorPalette="red" onClick={() => { void cancelMeeting(meeting); close(); }}>Cancel and email guest</Button>
                </>
                : <Button size="sm" variant="outline" onClick={() => setConfirming(true)}>Cancel meeting</Button>)}
              {meeting.jitsiUrl && !confirming && <Button size="sm" asChild><a href={meeting.jitsiUrl} target="_blank" rel="noreferrer">Join</a></Button>}
            </HStack>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog.Positioner>
    </Portal>}
  </Dialog.Root>;
}
