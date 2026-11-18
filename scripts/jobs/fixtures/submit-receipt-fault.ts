const { JOBS_RUNNER_BASE_URL, JOBS_RUNNER_CDP_URL, QS_JOBS_FIXTURE_DROP_RECEIPT } = process.env;
const api = new URL(JOBS_RUNNER_BASE_URL ?? '');
const cdp = new URL(JOBS_RUNNER_CDP_URL ?? '');
for (const url of [api, cdp]) {
  if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:' || !url.port) {
    throw new Error('Use loopback Jobs and Chrome fixture servers.');
  }
}

const liveFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin !== api.origin && url.origin !== cdp.origin) {
    throw new Error('Fixture requests must use the loopback API or Chrome debugger.');
  }
  const response = await liveFetch(input, init);
  if (QS_JOBS_FIXTURE_DROP_RECEIPT === '1' && url.origin === api.origin && url.pathname.endsWith('/complete') && response.ok) {
    await response.body?.cancel();
    throw new TypeError('Fixture dropped a committed receipt response.');
  }
  return response;
}, liveFetch);
