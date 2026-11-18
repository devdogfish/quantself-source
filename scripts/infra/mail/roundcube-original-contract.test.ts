import { expect, test } from "bun:test";

type FetchedMessage = {
  uid: number;
  parsedMessageId: string | null;
};

type ViewEvidence = {
  server: string;
  account: string;
  folder: string;
  uidValidity: number;
  message: FetchedMessage | null;
};

const original = {
  server: "imap.example.test",
  account: "applications@example.test",
  folder: "INBOX",
  uidValidity: 100,
  uid: 42,
  parsedMessageId: "application-reply@example.test",
};

const originalMessage: FetchedMessage = {
  uid: original.uid,
  parsedMessageId: original.parsedMessageId,
};

const matchingView: ViewEvidence = {
  server: original.server,
  account: original.account,
  folder: original.folder,
  uidValidity: original.uidValidity,
  message: originalMessage,
};

const unrelatedMessage = {
  uid: original.uid,
  parsedMessageId: "unrelated@example.test",
};

// Models which synthetic message a folder/UID-only link would select in this session.
function followFolderUid(view: ViewEvidence): FetchedMessage | null {
  return view.folder === original.folder && view.message?.uid === original.uid
    ? view.message
    : null;
}

// Proof model. The input stands in for fresh, parsed evidence at the point of view.
// The fixture performs no IMAP, RFC parsing, Roundcube request, or session enforcement.
function authorizeOriginalView(view: ViewEvidence): FetchedMessage | null {
  if (
    view.server !== original.server ||
    view.account !== original.account ||
    view.folder !== original.folder ||
    view.uidValidity !== original.uidValidity ||
    view.message?.uid !== original.uid ||
    view.message.parsedMessageId !== original.parsedMessageId
  ) {
    return null;
  }

  return view.message;
}

test("allows the original when all current evidence matches", () => {
  expect(authorizeOriginalView(matchingView)).toEqual(originalMessage);
});

test("a bare folder/UID opens an unrelated message under another account", () => {
  const otherAccount = {
    ...matchingView,
    account: "other@example.test",
    message: unrelatedMessage,
  };

  expect(followFolderUid(otherAccount)).toEqual(unrelatedMessage);
  expect(authorizeOriginalView(otherAccount)).toBeNull();
});

test("a bare folder/UID opens an unrelated message after UIDVALIDITY changes", () => {
  const reusedUid = {
    ...matchingView,
    uidValidity: 200,
    message: unrelatedMessage,
  };

  expect(followFolderUid(reusedUid)).toEqual(unrelatedMessage);
  expect(authorizeOriginalView(reusedUid)).toBeNull();
});

const rejectedEvidence: [reason: string, change: Partial<ViewEvidence>][] = [
  ["a different server", { server: "other-imap.example.test" }],
  ["a different account", { account: "other@example.test" }],
  ["a different folder", { folder: "Archive" }],
  ["a different UIDVALIDITY even with the same Message-ID", { uidValidity: 200 }],
  ["a different fetched UID", { message: { ...originalMessage, uid: 43 } }],
  ["a missing message", { message: null }],
  ["a missing parsed Message-ID", { message: { ...originalMessage, parsedMessageId: null } }],
  ["a different parsed Message-ID", { message: unrelatedMessage }],
  [
    "a Message-ID containing the expected ID as a substring",
    { message: { ...originalMessage, parsedMessageId: `other-${original.parsedMessageId}` } },
  ],
];

test.each(rejectedEvidence)("rejects %s", (_reason, change) => {
  expect(authorizeOriginalView({ ...matchingView, ...change })).toBeNull();
});
