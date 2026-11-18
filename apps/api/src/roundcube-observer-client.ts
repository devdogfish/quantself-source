import {
  exchangeObserverFrame, observerClientGid, observerClientUid, observerRequestBytes, observerSocketPath,
  readObserverBytes,
} from "./roundcube-observer-wire";

// This entry point forwards a single bounded frame as the dedicated socket peer.
if (process.geteuid?.() !== observerClientUid || process.getegid?.() !== observerClientGid) process.exit(1);

try {
  const request = await readObserverBytes(Bun.stdin.stream(), observerRequestBytes);
  const response = await exchangeObserverFrame(observerSocketPath, request);
  if (!response) process.exit(1);
  await Bun.write(Bun.stdout, response);
} catch {
  process.exitCode = 1;
}
