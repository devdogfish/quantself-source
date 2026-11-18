import { deliverSesReply } from '../ses-transport';

const input = await Bun.stdin.json() as {
  packet: Parameters<typeof deliverSesReply>[0];
  approved: Parameters<typeof deliverSesReply>[0];
  messageId: string;
};
const started = performance.now();
let calls = 0;
const result = await deliverSesReply(input.packet, { region: 'ca-central-1', profile: 'unused-fixture' }, {
  reserve: async () => {}, // The real mailbox service has already committed the reservation.
  canSend: () => true,
}, {
  async send(command) {
    calls++;
    const { from, to, subject, inReplyTo, body } = input.approved;
    const expected = {
      FromEmailAddress: from, FeedbackForwardingEmailAddress: from, Destination: { ToAddresses: [to] },
      Content: { Simple: {
        Subject: { Charset: 'UTF-8', Data: subject }, Body: { Text: { Charset: 'UTF-8', Data: body } },
        Headers: [{ Name: 'In-Reply-To', Value: inReplyTo }, { Name: 'References', Value: inReplyTo }],
      } },
    };
    if (JSON.stringify(command.input) !== JSON.stringify(expected)) throw new Error('Unexpected threaded reply command');
    return { MessageId: input.messageId };
  },
});
console.log(JSON.stringify({ result, calls, elapsedMs: Math.round(performance.now() - started) }));
