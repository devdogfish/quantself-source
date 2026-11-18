import { createPhoneJarvisProvider, readPhoneJarvisConfig } from "../src/phone-jarvis-provider";
import { phoneJarvisStore } from "../src/phone-jarvis-store";
import { requestPhoneVerificationCall } from "../src/phone-jarvis-verification";
try {
  if (process.env.QUANTSELF_PHONE_ENABLED !== "1" || process.argv.length !== 3) throw Error("Phone verification unavailable");
  const provider = createPhoneJarvisProvider(readPhoneJarvisConfig());
  const result = await requestPhoneVerificationCall(process.argv[2]!, phoneJarvisStore, id => provider.createOwnerCall(id));
  console.log(result === "requested" ? "Owner verification call requested." : result === "already-requested" ? "Verification invocation already claimed; no redial." : "Verification delivery uncertain; no automatic retry.");
  if (result === "uncertain") process.exitCode = 1;
} catch {
  console.error("Phone verification unavailable; no automatic retry.");
  process.exitCode = 1;
}
