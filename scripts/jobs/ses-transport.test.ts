import { expect, spyOn, test } from 'bun:test';
import { MessageRejected, SESv2Client, SESv2ServiceException, SendEmailCommand } from '@aws-sdk/client-sesv2';
import * as credentialProviders from '@aws-sdk/credential-provider-ini';
import type { EmailPacket } from './email-application';
import { deliverSes, deliverSesReply } from './ses-transport';

const config = { region: 'us-east-1', profile: 'jobs-ses' };
const packet: EmailPacket = {
  messageKey: 'approval-key',
  applicationId: 'application',
  revision: 2,
  from: 'luigi.k7mq@luigigirke.com',
  to: 'recruiter@example.net',
  subject: 'Candidature – Chloé',
  body: 'Veuillez trouver mon résumé ci-joint.\nMerci.',
  attachment: {
    filename: 'Resume.pdf',
    contentType: 'application/pdf',
    sha256: 'approved-pdf-sha',
    bytes: Uint8Array.of(37, 80, 68, 70, 45, 255),
  },
};

test('SES uses the approved address for feedback and sends the exact UTF-8 email and PDF with tracking disabled', async () => {
  const requests: SendEmailCommand[] = [];
  const result = await deliverSes(packet, config, {
    async send(command: SendEmailCommand, options: { abortSignal: AbortSignal }) {
      expect(options.abortSignal.aborted).toBe(false);
      requests.push(command);
      return { MessageId: 'ses-id' };
    },
  });
  expect(result).toEqual({ kind: 'accepted', messageId: 'ses-id' });
  expect(requests).toHaveLength(1);
  expect(requests[0]).toBeInstanceOf(SendEmailCommand);
  expect(requests[0].input).toEqual({
    FromEmailAddress: 'luigi.k7mq@luigigirke.com',
    FeedbackForwardingEmailAddress: 'luigi.k7mq@luigigirke.com',
    Destination: { ToAddresses: ['recruiter@example.net'] },
    Content: {
      Simple: {
        Subject: { Charset: 'UTF-8', Data: 'Candidature – Chloé' },
        Body: { Text: { Charset: 'UTF-8', Data: 'Veuillez trouver mon résumé ci-joint.\nMerci.' } },
        Attachments: [{
          FileName: 'Resume.pdf', ContentType: 'application/pdf', ContentDisposition: 'ATTACHMENT',
          ContentTransferEncoding: 'BASE64', RawContent: Uint8Array.of(37, 80, 68, 70, 45, 255),
        }],
      },
    },
    ConfigurationOverrides: { Tracking: { OpenTrackingEnabled: 'DISABLED', ClickTrackingEnabled: 'DISABLED' } },
  });
});

test('a sender outside the Application Address format never reaches SES', async () => {
  const requests: SendEmailCommand[] = [];
  const result = await deliverSes({ ...packet, from: 'other@example.com' }, config, {
    async send(command) {
      requests.push(command);
      return { MessageId: 'unexpected-id' };
    },
  });
  expect(result).toEqual({ kind: 'not_sent' });
  expect(requests).toHaveLength(0);
});

test('an expired authorization stops at the SES call boundary', async () => {
  let calls = 0;
  const result = await deliverSes(packet, config, {
    async send() {
      calls++;
      return { MessageId: 'unexpected-id' };
    },
  }, () => false);
  expect(result).toEqual({ kind: 'not_sent' });
  expect(calls).toBe(0);
});

test('SES waits for the async send gate, then checks the deadline before invoking the provider', async () => {
  const steps: string[] = [];
  const gate = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  let authorized = true;
  const result = deliverSes(packet, config, {
    async send() {
      steps.push('provider');
      return { MessageId: 'unexpected-id' };
    },
  }, () => {
    steps.push('deadline');
    return authorized;
  }, async () => {
    steps.push('gate');
    entered.resolve();
    await gate.promise;
  });
  await Promise.race([entered.promise, result]);
  expect(steps).toEqual(['gate']);
  authorized = false;
  gate.resolve();
  expect(await result).toEqual({ kind: 'not_sent' });
  expect(steps).toEqual(['gate', 'deadline']);
});

test('a rejected send gate is definitive no-send evidence', async () => {
  let calls = 0;
  const result = await deliverSes(packet, config, {
    async send() {
      calls++;
      return { MessageId: 'unexpected-id' };
    },
  }, undefined, async () => { throw new Error('gate rejected'); });
  expect(result).toEqual({ kind: 'not_sent' });
  expect(calls).toBe(0);
});

test.each([true, false])('SDK credential resolution precedes the send gate (credentials available: %j)', async available => {
  const steps: string[] = [];
  const provider = spyOn(credentialProviders, 'fromIni').mockReturnValue(async () => {
    steps.push('credentials');
    if (!available) throw new Error('fixture missing credentials');
    return { accessKeyId: 'fixture-key', secretAccessKey: 'fixture-secret' };
  });
  const send = spyOn(SESv2Client.prototype, 'send').mockImplementation(async () => {
    steps.push('provider');
    return { MessageId: 'ses-id' };
  });
  try {
    const result = await deliverSes(packet, config, undefined, undefined, async () => { steps.push('gate'); });
    expect(steps).toEqual(available ? ['credentials', 'gate', 'provider'] : ['credentials']);
    expect(result).toEqual(available ? { kind: 'accepted', messageId: 'ses-id' } : { kind: 'not_sent' });
  } finally {
    provider.mockRestore();
    send.mockRestore();
  }
});

test('a documented SES refusal is known not to have sent the message', async () => {
  const result = await deliverSes(packet, config, {
    async send() {
      throw new MessageRejected({ message: 'invalid content', $metadata: { httpStatusCode: 400 } });
    },
  });
  expect(result).toEqual({ kind: 'not_sent' });
});

test.each([
  ['network failure', new Error('socket hang up')],
  ['timeout', new DOMException('request timed out', 'TimeoutError')],
  ['SES 5xx', new SESv2ServiceException({ name: 'InternalServerError', $fault: 'server', $metadata: { httpStatusCode: 500 } })],
  ['undocumented 4xx', new SESv2ServiceException({ name: 'UnexpectedException', $fault: 'client', $metadata: { httpStatusCode: 400 } })],
  ['refusal name without SES provenance', Object.assign(new Error('invalid content'), {
    name: 'MessageRejected', $metadata: { httpStatusCode: 400 },
  })],
])('%s leaves the send uncertain after one attempt', async (_name, error) => {
  let attempts = 0;
  const result = await deliverSes(packet, config, {
    async send() {
      attempts += 1;
      throw error;
    },
  });
  expect(result).toEqual({ kind: 'uncertain' });
  expect(attempts).toBe(1);
});

test.each([undefined, '', '  '])('a response without a usable MessageId (%j) leaves the send uncertain', async (MessageId) => {
  expect(await deliverSes(packet, config, { async send() { return { MessageId }; } })).toEqual({ kind: 'uncertain' });
});

test('a threaded reply reserves before SES and sends only to the bound recipient', async () => {
  const trace: string[] = [];
  const reply = { from: packet.from, to: packet.to, subject: 'Re: Job application', body: 'Thanks.',
    inReplyTo: '<reply-42@employer.example>' };
  const result = await deliverSesReply(reply, config, {
    canSend: () => true,
    async reserve() { trace.push('reserved'); },
  }, {
    async send(command) {
      trace.push('dispatched');
      expect(command.input.Destination).toEqual({ ToAddresses: [packet.to] });
      expect(command.input.ConfigurationOverrides).toBeUndefined();
      expect(command.input.Content?.Simple).toEqual({
        Subject: { Charset: 'UTF-8', Data: reply.subject },
        Body: { Text: { Charset: 'UTF-8', Data: reply.body } },
        Headers: [
          { Name: 'In-Reply-To', Value: reply.inReplyTo },
          { Name: 'References', Value: reply.inReplyTo },
        ],
      });
      return { MessageId: 'threaded-receipt' };
    },
  });
  expect(trace).toEqual(['reserved', 'dispatched']);
  expect(result).toEqual({ kind: 'accepted', messageId: 'threaded-receipt' });
});

test('a malformed reply reference or an unavailable reservation cannot dispatch a reply', async () => {
  const base = { from: packet.from, to: packet.to, subject: 'Re: Job application', body: 'Thanks.',
    inReplyTo: '<reply@employer.example>' };
  let sent = 0;
  const sender = { async send() { sent++; return { MessageId: 'unwanted' }; } };
  const gate = { canSend: () => true, async reserve() { throw Error('journal busy'); } };
  expect(await deliverSesReply(base, config, gate, sender)).toEqual({ kind: 'not_sent' });
  expect(await deliverSesReply({ ...base, inReplyTo: '<reply@employer.example>\r\nBcc:evil@example>' }, config,
    { ...gate, async reserve() { throw Error('must not reserve'); } }, sender)).toEqual({ kind: 'not_sent' });
  expect(sent).toBe(0);
});
