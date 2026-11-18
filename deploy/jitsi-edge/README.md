# Public meeting links

The Vercel project `girke-meet` serves `meet.girke.dev` and forwards room pages and assets to Gate's existing Jitsi Funnel. Deploy from this directory. Spaceship remains authoritative for DNS.

Vercel's external rewrite did not pass the XMPP WebSocket upgrade in testing. Gate's Jitsi config prefers HTTP signaling (BOSH) through the Vercel origin for branded rooms. Browsers that use WebSocket can reach the existing Funnel directly:

```js
websocket: (['meet.girke.dev', 'girke-meet.vercel.app'].includes(window.location.hostname)
    ? 'wss://jitsi-funnel.example.invalid:8443'
    : window.location.origin.replace(/^http/, 'ws')) + '/' + subdir + 'xmpp-websocket',
preferBosh: ['meet.girke.dev', 'girke-meet.vercel.app'].includes(window.location.hostname),
```

Replace the example hostname with the existing Funnel hostname from the private deployment configuration, then apply this to the Jitsi Meet config on Gate, which nginx also embeds in room pages. Leave the Funnel and media port forward in place so both hostnames reach the same rooms.

Before setting `QUANTSELF_MEETINGS_JITSI_ORIGIN=https://meet.girke.dev` in the active booking worker, verify the branded room from a connection outside the home network, including host sign-in, guest join and audio and video across three browsers. Verify an existing Funnel room URL as well. Roll back the worker setting to the original Funnel origin if the branded path fails.
