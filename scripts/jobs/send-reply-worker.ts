/** Private single-packet SES worker. The Jobs mailbox service supplies a reserved reply. */
import { readFileSync } from 'node:fs';
import { deliverSesReply, type ThreadedReply } from './ses-transport';

const seenFields = ['body', 'from', 'inReplyTo', 'subject', 'to'];

async function reply() {
  const [credentials] = process.argv.slice(2);
  if (!credentials || !credentials.startsWith('/run/credentials/') || !credentials.endsWith('/qs196-jobs-ses')) {
    return { kind: 'not_sent' };
  }
  // This profile file is decrypted by systemd and visible only to the service.
  process.env.AWS_SHARED_CREDENTIALS_FILE = credentials;
  process.env.AWS_CONFIG_FILE = '/dev/null';
  const raw = readFileSync(0, 'utf8');
  if (Buffer.byteLength(raw) > 100_000) return { kind: 'not_sent' };
  const packet: unknown = JSON.parse(raw);
  if (!packet || typeof packet !== 'object'
      || JSON.stringify(Object.keys(packet).sort()) !== JSON.stringify(seenFields)
      || Object.values(packet).some(value => typeof value !== 'string')) return { kind: 'not_sent' };
  // The parent persists the reservation before launching this executable;
  // only the service account may run it.
  return deliverSesReply(packet as ThreadedReply, { region: 'ca-central-1', profile: 'sam-jobs-replies' }, {
    reserve: async () => {},
    canSend: () => true,
  });
}

try {
  process.stdout.write(JSON.stringify(await reply()) + '\n');
} catch {
  process.stdout.write('{"kind":"uncertain"}\n');
}
