import { expect, test } from "bun:test";

test("enabled production app validates callback contracts, health works, Owner proof cannot replace a Twilio signature", async () => {
  const script = `
    globalThis.fetch = async () => { throw Error("Unexpected provider network request"); };
    const { createHmac } = await import("node:crypto");
    const { app } = await import("./apps/api/src/app.ts");
    const health = await app.request("https://phone.example/api/health");
    if (health.status !== 200) throw Error("Health failed");
    for (const path of ["inbound", "session/answer", "session/pin?attempt=0", "session/status"]) {
      const response = await app.request("https://phone.example/api/v1/phone-jarvis/" + path, {method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded","X-Quantself-Owner-Proof":process.env.QUANTSELF_OWNER_INGRESS_TOKEN},body:""});
      if (response.status !== 403) throw Error("Unsigned callback accepted");
    }
    const url = "https://phone.example/api/v1/phone-jarvis/inbound";
    const accountSid = process.env.QUANTSELF_TWILIO_ACCOUNT_SID;
    const signature = createHmac("sha1", process.env.QUANTSELF_TWILIO_AUTH_TOKEN)
      .update(url + "AccountSid" + accountSid).digest("base64");
    const signed = await app.request(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": signature },
      body: new URLSearchParams({ AccountSid: accountSid }).toString(),
    });
    if (signed.status !== 200 || !(await signed.text()).includes("<Hangup/>")) {
      throw Error("Correctly signed callback did not reach safe hangup handling");
    }
    const response = await app.request("https://phone.example/api/openapi.json");
    if (response.status !== 200) throw Error("OpenAPI failed");
    const doc = await response.json();
    for (const path of ["/api/v1/phone-jarvis/inbound", "/api/v1/phone-jarvis/{id}/{operation}"]) {
      if (!doc.paths[path]?.post?.security?.[0]?.twilioSignature) throw Error("Callback contract missing");
    }
    console.log("Enabled startup and provider authentication verified.");
  `;
  const child = Bun.spawn(["bun", "-e", script], { cwd: new URL("../../../", import.meta.url).pathname, env: { ...process.env, DATABASE_URL: "postgresql://unused:unused@127.0.0.1:59999/unused", QUANTSELF_OWNER_INGRESS_TOKEN: "a".repeat(64), QUANTSELF_PHONE_ENABLED: "1", QUANTSELF_PHONE_PUBLIC_URL: "https://phone.example", QUANTSELF_TWILIO_ACCOUNT_SID: `AC${"a".repeat(32)}`, QUANTSELF_TWILIO_AUTH_TOKEN: "synthetic-token", QUANTSELF_PHONE_OWNER_NUMBER: "+19025550001", QUANTSELF_TWILIO_PHONE_NUMBER: "+19025550002", QUANTSELF_PHONE_PIN_HASH: `scrypt:${"a".repeat(32)}:${"b".repeat(64)}`, QUANTSELF_ELEVENLABS_PHONE_AGENT_ID: "synthetic-phone-agent", QUANTSELF_ELEVENLABS_API_KEY: "synthetic-key" }, stdout: "pipe", stderr: "pipe" });
  const output = await new Response(child.stdout).text();
  const error = await new Response(child.stderr).text();
  expect(error).toBe("");
  expect(await child.exited).toBe(0);
  expect(output).toContain("Enabled startup and provider authentication verified.");
});
