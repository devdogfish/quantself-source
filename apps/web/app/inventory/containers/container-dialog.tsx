"use client";

import { CloseButton, Dialog, Portal } from "@chakra-ui/react";
import type { ReactNode } from "react";

export function ContainerDialog({
  children,
  open,
  onOpenChange,
  onClosed,
  finalFocusEl,
  initialFocusEl,
  alert = false,
}: {
  children: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onClosed?: () => void;
  finalFocusEl?: () => HTMLElement | null;
  initialFocusEl?: () => HTMLElement | null;
  alert?: boolean;
}) {
  return (
    <Dialog.Root
      open={open}
      onOpenChange={({ open: nextOpen }) => onOpenChange(nextOpen)}
      onExitComplete={onClosed}
      finalFocusEl={finalFocusEl}
      initialFocusEl={initialFocusEl}
      role={alert ? "alertdialog" : "dialog"}
      placement="center"
      scrollBehavior="inside"
      lazyMount
      unmountOnExit
    >
      <Portal>
        <Dialog.Backdrop bg="black/10" backdropFilter="blur(4px)" />
        <Dialog.Positioner px="4">
          <Dialog.Content
            maxW={alert ? "20rem" : "24rem"}
            maxH="calc(100svh - 2rem)"
            gap="4"
            p="4"
            bg="bg"
            fontSize="sm"
            borderRadius="l3"
            boxShadow="0 0 0 1px rgb(0 0 0 / 0.1)"
          >
            {children}
            {!alert && (
              <Dialog.CloseTrigger asChild>
                <CloseButton aria-label="Close" top="2" right="2" size="xs" />
              </Dialog.CloseTrigger>
            )}
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

export function ContainerDialogHeader({ children }: { children: ReactNode }) {
  return (
    <Dialog.Header flexDirection="column" gap="2" p="0" pr="6">
      {children}
    </Dialog.Header>
  );
}

export function ContainerDialogFooter({ children }: { children: ReactNode }) {
  return (
    <Dialog.Footer
      mx="-4"
      mb="-4"
      p="4"
      gap="2"
      bg="bg.subtle"
      borderTopWidth="1px"
      borderBottomRadius="inherit"
      flexDirection="column-reverse"
      css={{
        "@media (min-width: 40rem)": {
          flexDirection: "row",
          justifyContent: "end",
        },
      }}
    >
      {children}
    </Dialog.Footer>
  );
}

export const containerDialogInput = {
  size: "sm",
  h: "8",
  minH: "8",
  px: "2.5",
  fontSize: { base: "md", md: "sm" },
  borderRadius: "l2",
} as const;
