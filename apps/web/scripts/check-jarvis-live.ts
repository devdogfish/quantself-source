/** Opt-in spoken-input acceptance. Task writes require a second opt-in and a verified isolated repository. */
import { createHash } from "node:crypto";
import { getPublicOrigin } from "@quantself/auth/public-origin";

if (process.env.QUANTSELF_JARVIS_LIVE !== "1")
  throw Error("Set QUANTSELF_JARVIS_LIVE=1 to run the synthetic live check.");
const origin = new URL(getPublicOrigin() ?? "");
if (origin.protocol !== "https:")
  throw Error("Use the deployed HTTPS application origin.");
const fixture = process.env.QUANTSELF_JARVIS_SPOKEN_PCM;
if (!fixture)
  throw Error(
    "Supply a 16 kHz mono signed-16-bit little-endian PCM spoken task-read fixture.",
  );
const pcm = new Uint8Array(await Bun.file(fixture).arrayBuffer());
if (!pcm.length || pcm.length > 16000 * 2 * 20 || pcm.length % 2)
  throw Error("Fixture must contain 1–20 seconds of PCM speech.");
const captureId = crypto.randomUUID();
const writes = process.env.QUANTSELF_JARVIS_WRITE_LIVE === "1";
async function api(path: string, body?: unknown) {
  const response = await fetch(new URL(path, origin), {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Origin: origin.origin,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok)
    throw Error(
      `Application request failed (${response.status}); capture ${captureId}`,
    );
  return response;
}
if (writes) {
  const repository = process.env.QUANTSELF_TODO_TEST_REPOSITORY;
  const issue = process.env.QUANTSELF_JARVIS_TEST_ISSUE_NUMBER;
  if (
    !repository?.endsWith("/todos-integration-test") ||
    !/^[1-9]\d*$/.test(issue ?? "")
  )
    throw Error(
      "Write acceptance requires the isolated todos-integration-test repository and a known fixture issue number.",
    );
  const fixture = (await (await api(`/api/v1/todos/${issue}`)).json()) as {
    todo: { repository: string };
  };
  if (fixture.todo.repository !== repository)
    throw Error(
      "Application is not configured for the isolated repository; refusing voice access.",
    );
}
const { signedUrl } = (await (
  await api(`/api/v1/todo-jarvis/${captureId}/access`, {})
).json()) as { signedUrl: string };
let conversationId = "";
let recognized = false;
let toolResult = false;
let audioBytes = 0;
let resultAudioBytes = 0;
let playbackThrough = 0;
let lastActivity = Date.now();
let audioRate = 16000;
const socket = new WebSocket(signedUrl);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
try {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(Error("Voice connection timeout")),
      20000,
    );
    socket.onopen = () => {
      clearTimeout(timer);
      socket.send(
        JSON.stringify({
          type: "conversation_initiation_client_data",
          user_id: captureId,
        }),
      );
      resolve();
    };
    socket.onerror = () => {
      clearTimeout(timer);
      reject(Error("Voice connection failed"));
    };
    socket.onmessage = (event) => {
      const data = JSON.parse(String(event.data));
      lastActivity = Date.now();
      if (data.type === "conversation_initiation_metadata") {
        const metadata = data.conversation_initiation_metadata_event;
        conversationId = metadata.conversation_id;
        const match = /^pcm_(\d+)$/.exec(metadata.agent_output_audio_format);
        if (!match || metadata.user_input_audio_format !== "pcm_16000") {
          socket.close();
          return;
        }
        audioRate = Number(match[1]);
      }
      if (data.type === "ping") {
        socket.send(
          JSON.stringify({ type: "pong", event_id: data.ping_event.event_id }),
        );
      }
      if (data.type === "user_transcript")
        recognized = Boolean(
          data.user_transcription_event.user_transcript?.trim(),
        );
      if (
        data.type === "agent_tool_response" &&
        data.agent_tool_response.tool_name ===
          (writes ? "apply_task_command" : "read_tasks") &&
        !data.agent_tool_response.is_error
      )
        toolResult = true;
      if (data.type === "audio") {
        const length = Buffer.from(
          data.audio_event.audio_base_64,
          "base64",
        ).length;
        audioBytes += length;
        if (toolResult) resultAudioBytes += length;
        playbackThrough =
          Math.max(Date.now(), playbackThrough) +
          (length / (audioRate * 2)) * 1000;
      }
      if (data.type === "client_tool_call")
        socket.send(
          JSON.stringify({
            type: "client_tool_result",
            tool_call_id: data.client_tool_call.tool_call_id,
            result: "Synthetic probe has no UI navigation",
            is_error: false,
          }),
        );
    };
  });
  const deadline = Date.now() + 120000;
  while (
    !conversationId &&
    Date.now() < deadline &&
    socket.readyState === WebSocket.OPEN
  )
    await sleep(100);
  if (!conversationId) throw Error("Conversation metadata unavailable");
  // Let the greeting drain before feeding synthetic spoken input.
  while (
    (Date.now() < playbackThrough + 1500 || Date.now() - lastActivity < 1500) &&
    Date.now() < deadline
  )
    await sleep(100);
  for (let offset = 0; offset < pcm.length; offset += 3200) {
    socket.send(
      JSON.stringify({
        user_audio_chunk: Buffer.from(
          pcm.slice(offset, offset + 3200),
        ).toString("base64"),
      }),
    );
    await sleep(100);
  }
  while (Date.now() < deadline && socket.readyState === WebSocket.OPEN) {
    // Pings must not mask audio drain. The modeled playback queue includes every PCM byte.
    if (
      recognized &&
      toolResult &&
      resultAudioBytes > 0 &&
      Date.now() > playbackThrough + 5000
    )
      break;
    socket.send(
      JSON.stringify({
        user_audio_chunk: Buffer.alloc(3200).toString("base64"),
      }),
    );
    await sleep(100);
  }
  if (
    !recognized ||
    !toolResult ||
    !resultAudioBytes ||
    Date.now() <= playbackThrough
  )
    throw Error(`Spoken task/tool/playback check failed; capture ${captureId}`);
} finally {
  socket.close(1000, "Synthetic playback drained");
}
let archived = false;
for (let attempt = 0; attempt < 24; attempt++) {
  await sleep(5000);
  try {
    const result = (await (
      await api(`/api/v1/todo-jarvis/${captureId}/reconcile`, {
        conversationId,
      })
    ).json()) as { status: string };
    if (result.status === "archived") {
      archived = true;
      break;
    }
  } catch {
    /* Final provider transcript/audio can lag disconnect. */
  }
}
if (!archived)
  throw Error(
    `Recording still pending; retry capture ${captureId} with conversation ${conversationId}`,
  );
const archive = (await (
  await api(`/api/v1/todo-captures/${captureId}`)
).json()) as {
  capture: { transcript: string };
  audio: { sha256: string; size: number };
  links: { number: number | null; status: string }[];
};
const bytes = new Uint8Array(
  await (await api(`/api/v1/todo-captures/${captureId}/audio`)).arrayBuffer(),
);
if (
  !archive.capture.transcript ||
  bytes.length !== archive.audio.size ||
  createHash("sha256").update(bytes).digest("hex") !== archive.audio.sha256
)
  throw Error("Archive verification failed");
if (writes) {
  const receipts = (await (
    await api(`/api/v1/todo-jarvis/${captureId}/commands`)
  ).json()) as {
    commands: { number: number | null; outcomes: Record<string, string> }[];
  };
  const numbers = [
    ...new Set(
      receipts.commands
        .map((c) => c.number)
        .filter((n): n is number => n !== null),
    ),
  ];
  if (
    numbers.length < 2 ||
    receipts.commands.some((c) =>
      Object.values(c.outcomes).some((v) => v !== "saved"),
    ) ||
    numbers.some(
      (n) =>
        !archive.links.some((l) => l.number === n && l.status === "linked"),
    )
  )
    throw Error(
      `Conversational saves incomplete; review per-operation receipts for capture ${captureId}`,
    );
  for (const number of numbers) {
    const { todo } = (await (await api(`/api/v1/todos/${number}`)).json()) as {
      todo: {
        repository: string;
        labels: string[];
        comments: { body: string }[];
      };
    };
    if (
      todo.repository !== process.env.QUANTSELF_TODO_TEST_REPOSITORY ||
      todo.labels.some((l) => l.startsWith("agent:")) ||
      !todo.comments.some((c) => c.body.includes(`Capture ID: ${captureId}`))
    )
      throw Error(`Issue provenance/isolation failed for capture ${captureId}`);
  }
}
console.log(
  `PASS spoken input, authenticated ${writes ? "capture-to-multiple-issues command" : "read_tasks"} result, drained synthetic playback, verified original recording. Capture ${captureId} retained for Owner review.`,
);
