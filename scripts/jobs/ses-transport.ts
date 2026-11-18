import { SESv2Client, SESv2ServiceException, SendEmailCommand, type SendEmailCommandInput, type SendEmailCommandOutput } from '@aws-sdk/client-sesv2';
import { fromIni } from '@aws-sdk/credential-provider-ini';
import { applicationAddressPattern } from './application-address';
import type { EmailPacket } from './email-application';

export type SesMailConfig = { region: string; profile: string };
export type SesDelivery = { kind: 'accepted'; messageId: string } | { kind: 'not_sent' } | { kind: 'uncertain' };

type SesSender = {
  send(command: SendEmailCommand, options: { abortSignal: AbortSignal }): Promise<Pick<SendEmailCommandOutput, 'MessageId'>>;
};

// Only SES SendEmail refusals with the documented status can release the reservation.
const refusals = new Map([
  ['AccountSuspendedException', 400],
  ['BadRequestException', 400],
  ['LimitExceededException', 400],
  ['MailFromDomainNotVerifiedException', 400],
  ['MessageRejected', 400],
  ['NotFoundException', 404],
  ['SendingPausedException', 400],
  ['TooManyRequestsException', 429],
]);

export async function deliverSes(packet: EmailPacket, config: SesMailConfig, sender?: SesSender,
  canSend: () => boolean = () => true, beforeSend?: () => Promise<void>): Promise<SesDelivery> {
  if (!applicationAddressPattern.test(packet.from)) return { kind: 'not_sent' };
  return sendSes({
    ...baseMessage(packet),
    Content: { Simple: {
      ...plainText(packet),
      Attachments: [{
        FileName: packet.attachment.filename,
        ContentType: packet.attachment.contentType,
        ContentDisposition: 'ATTACHMENT',
        ContentTransferEncoding: 'BASE64',
        RawContent: packet.attachment.bytes,
      }],
    } },
  }, config, sender, canSend, beforeSend);
}

type PlainMessage = Pick<EmailPacket, 'from' | 'to' | 'subject' | 'body'>;

export type ThreadedReply = PlainMessage & { inReplyTo: string };

type SendGate = { canSend: () => boolean; reserve: () => Promise<void> };

const email = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+$/;
const messageId = /^<[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+>$/;

// The caller binds this packet to a verified incoming message and its Jobs
// record. It must durably reserve the dispatch before calling the provider.
export function deliverSesReply(packet: ThreadedReply, config: SesMailConfig, gate: SendGate,
  sender?: SesSender): Promise<SesDelivery> {
  if (!applicationAddressPattern.test(packet.from) || !email.test(packet.to) || packet.to.length > 254
      || !messageId.test(packet.inReplyTo) || packet.inReplyTo.length > 255
      || !packet.subject.trim() || packet.subject.length > 200 || /[\r\n\0]/.test(packet.subject)
      || !packet.body.trim() || packet.body.length > 16_000) return Promise.resolve({ kind: 'not_sent' });
  // SES only tracks opens and clicks in HTML. Replies are text-only, so
  // they do not need the additional IAM permission for tracking overrides.
  return sendSes({
    ...baseMessage(packet),
    ConfigurationOverrides: undefined,
    Content: { Simple: {
      ...plainText(packet),
      Headers: [
        { Name: 'In-Reply-To', Value: packet.inReplyTo },
        { Name: 'References', Value: packet.inReplyTo },
      ],
    } },
  }, config, sender, gate.canSend, gate.reserve);
}

function plainText(packet: PlainMessage) {
  return {
    Subject: { Charset: 'UTF-8', Data: packet.subject },
    Body: { Text: { Charset: 'UTF-8', Data: packet.body } },
  };
}

function baseMessage(packet: PlainMessage): Pick<SendEmailCommandInput,
  'FromEmailAddress' | 'FeedbackForwardingEmailAddress' | 'Destination' | 'ConfigurationOverrides'> {
  return {
    FromEmailAddress: packet.from,
    FeedbackForwardingEmailAddress: packet.from,
    Destination: { ToAddresses: [packet.to] },
    ConfigurationOverrides: { Tracking: { OpenTrackingEnabled: 'DISABLED', ClickTrackingEnabled: 'DISABLED' } },
  };
}

async function sendSes(input: SendEmailCommandInput, config: SesMailConfig, sender: SesSender | undefined,
  canSend: () => boolean, beforeSend?: () => Promise<void>): Promise<SesDelivery> {
  let client: SESv2Client | undefined;
  if (!sender) {
    try {
      const credentials = await fromIni({ profile: config.profile })();
      client = new SESv2Client({
        credentials, region: config.region, maxAttempts: 1, ignoreConfiguredEndpointUrls: true,
      });
      sender = client;
    } catch {
      return { kind: 'not_sent' };
    }
  }
  try {
    const command = new SendEmailCommand(input);
    if (beforeSend) {
      try { await beforeSend(); }
      catch { return { kind: 'not_sent' }; }
    }
    if (!canSend()) return { kind: 'not_sent' };
    const response = await sender.send(command, { abortSignal: AbortSignal.timeout(30_000) });
    if (response.MessageId?.trim()) return { kind: 'accepted', messageId: response.MessageId };
    return { kind: 'uncertain' };
  } catch (error) {
    if (error instanceof SESv2ServiceException && error.$metadata.httpStatusCode !== undefined &&
        refusals.get(error.name) === error.$metadata.httpStatusCode) return { kind: 'not_sent' };
    return { kind: 'uncertain' };
  } finally {
    client?.destroy();
  }
}
