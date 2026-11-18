"use client";

import { Button, Dialog, HStack, Link, Portal, Stack, Text, Textarea } from "@chakra-ui/react";
import { useState } from "react";
import type { LiveTodo } from "./todo-live";
import type { HandBackDecision, OwnerReply } from "./todo-decision-queue";

export type DecisionControls = {
  available: boolean;
  busy(todo: LiveTodo): boolean;
  decide(todo: LiveTodo, action: HandBackDecision): void;
  returnToAgent(todo: LiveTodo): void;
  resume(todo: LiveTodo): void;
};

export function HandBackSummary({ todo }: { todo: LiveTodo }) {
  const handBack = todo.delegation?.handBack;
  if (!handBack) return null;
  return <Stack gap="1" minW="0">
    <Text textStyle="sm" color="fg.muted" whiteSpace="pre-wrap" overflowWrap="anywhere">
      {handBack.kind === "review" ? handBack.summary : handBack.question}
    </Text>
    {handBack.kind === "review" && handBack.links.length > 0 && <HStack gap="2" flexWrap="wrap">
      {handBack.links.map(({ label, url }, index) => <Link key={`${url}:${index}`} href={url} target="_blank" rel="noreferrer" variant="underline" textStyle="xs" onClick={event => event.stopPropagation()}>{label}</Link>)}
    </HStack>}
  </Stack>;
}

export function HandBackButtons({ todo, controls, size = "xs" }: { todo: LiveTodo; controls?: DecisionControls; size?: "xs" | "sm" }) {
  if (!controls?.available || controls.busy(todo)) return null;
  const delegation = todo.delegation;
  if (delegation?.pendingDecision) return <Button size={size} variant="outline" onClick={event => { event.stopPropagation(); controls.resume(todo); }}>Resume {delegation.pendingDecision.kind === "accept" ? "Accept" : "Undo"}</Button>;
  if (delegation?.state !== "waiting_on_owner" || todo.state !== "open") return null;
  return <HStack gap="1.5">
    <Button size={size} onClick={event => { event.stopPropagation(); controls.decide(todo, { decision: "accept" }); }}>Accept and close</Button>
    <Button size={size} variant="outline" onClick={event => { event.stopPropagation(); controls.returnToAgent(todo); }}>Return</Button>
  </HStack>;
}

export function ReturnHandBackDialog({ todo, close, send }: { todo: LiveTodo; close(): void; send(reply: OwnerReply): void }) {
  const [note, setNote] = useState("");
  const handBack = todo.delegation?.handBack;
  const choices = handBack?.kind === "question" ? handBack.choices : undefined;
  return <Dialog.Root open placement="center" size="sm" onOpenChange={({ open }) => { if (!open) close(); }}>
    <Portal><Dialog.Backdrop /><Dialog.Positioner><Dialog.Content>
      <Dialog.Header><Dialog.Title>Return to {todo.delegation?.delegate?.name}</Dialog.Title></Dialog.Header>
      <form onSubmit={event => { event.preventDefault(); if (note.trim()) send({ kind: "note", note: note.trim() }); }}>
        <Dialog.Body><Stack gap="3">
          <HandBackSummary todo={todo} />
          {choices?.map((choice, index) => <Button key={`${choice}:${index}`} type="button" variant="outline" onClick={() => send({ kind: "choice", choice })}>{choice}</Button>)}
          <Textarea aria-label="Return note" placeholder="Add a note" value={note} maxLength={2000} onChange={event => setNote(event.currentTarget.value)} />
        </Stack></Dialog.Body>
        <Dialog.Footer><Button type="button" variant="ghost" onClick={close}>Cancel</Button><Button type="submit" disabled={!note.trim()}>Return with note</Button></Dialog.Footer>
      </form>
    </Dialog.Content></Dialog.Positioner></Portal>
  </Dialog.Root>;
}
