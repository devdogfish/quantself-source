import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import type { AccessContext } from "@quantself/auth";
import { OpenAPIHono } from "@hono/zod-openapi";
import { hashPhonePin, verifyPhonePin, validateTwilioSignature } from "./phone-jarvis-security";
import { createPhoneJarvisProvider, type PhoneJarvisConfig } from "./phone-jarvis-provider";
import { registerPhoneJarvisRoutes } from "./phone-jarvis-route";
import type { PhoneJarvisStore, PhoneSession } from "./phone-jarvis-store-types";
const config: PhoneJarvisConfig = {publicUrl:"https://phone.example",accountSid:`AC${"a".repeat(32)}`,authToken:"token",ownerNumber:"+19025550001",twilioNumber:"+19025550002",pinHash:hashPhonePin("123456"),agentId:"phone-agent",elevenLabsApiKey:"secret"};
function sign(url: string, form: URLSearchParams) { return createHmac("sha1", config.authToken).update(url + [...form.keys()].sort().map(k=>k+form.get(k)).join("")).digest("base64"); }
test("PIN salted hash and exact signed URL/form",()=>{
 expect(verifyPhonePin("123456",config.pinHash)).toBe(true); expect(verifyPhonePin("123457",config.pinHash)).toBe(false); expect(verifyPhonePin("123456","123456")).toBe(false);
 const f=new URLSearchParams({Digits:"123456",CallSid:"call"}); const u="https://phone.example/pin?attempt=0";
 expect(validateTwilioSignature(u,f,sign(u,f),config.authToken)).toBe(true);
 expect(validateTwilioSignature(u.replace("0","1"),f,sign(u,f),config.authToken)).toBe(false);
 f.append("Digits","123456"); expect(validateTwilioSignature(u,f,sign(u,f),config.authToken)).toBe(false);
});
test("outbound only fixed Owner number; sync AMD; no recording; authenticated register context",async()=>{
 const requests: {url:string;init:RequestInit}[]=[];
 const provider=createPhoneJarvisProvider(config,(async(url: string,init:RequestInit)=>{requests.push({url,init});return url.includes("twilio.com")?Response.json({sid:`CA${"b".repeat(32)}`}):Response.json("<Response><Connect/></Response>");}) as typeof fetch);
 await provider.createOwnerCall("session"); const form=requests[0]!.init.body as URLSearchParams;
 expect(form.get("To")).toBe(config.ownerNumber); expect(form.get("MachineDetection")).toBe("Enable");expect(form.get("AsyncAmd")).toBe("false");expect(form.get("Record")).toBe("false");
 await provider.registerAuthenticatedCall("session","inbound",{captureId:"capture",context:"private"});
 const body=JSON.parse(requests[1]!.init.body as string);expect(body.agent_id).toBe("phone-agent");expect(body.conversation_initiation_client_data.user_id).toBe("capture");
});
test("PIN gates all context/audio; retries/replays bounded; machine gets silence",async()=>{
 let session:PhoneSession={id:"session",callSid:`CA${"b".repeat(32)}`,direction:"outbound",captureId:"capture",expiresAt:new Date(Date.now()+60000),attempts:0,authenticated:false,connection:"pending"};
 let registrations=0,prepared=0;
 const store:PhoneJarvisStore={createInbound:async()=>session,get:async()=>({...session}),bindCall:async()=>false,consumePinAttempt:async(_id,sid,attempt,correct)=>{if(session.callSid!==sid||session.attempts!==attempt||session.attempts>=3||session.connection!=="pending")return null;session={...session,attempts:attempt+1,authenticated:correct};return session;},claimConnection:async()=>{if(!session.authenticated||session.connection!=="pending")return false;session.connection="connecting";return true;},markConnected:async()=>{session.connection="connected";},close:async()=>{session.connection="closed";}};
 const provider={callback:(id:string,kind:string)=>`${config.publicUrl}/api/v1/phone-jarvis/${id}/${kind}`,createOwnerCall:async()=>session.callSid!,registerAuthenticatedCall:async()=>{registrations++;return "<Response><Connect/></Response>";}};
 const app=new OpenAPIHono<{ Variables: { accessContext: AccessContext | null } }>();registerPhoneJarvisRoutes(app,{config,store,provider,prepareConversation:async()=>{prepared++;return {captureId:"capture",context:"private"};}});
 const post=async(path:string,fields:Record<string,string>,valid=true)=>{const url=config.publicUrl+path;const form=new URLSearchParams({AccountSid:config.accountSid,CallSid:session.callSid!,From:config.twilioNumber,To:config.ownerNumber,...fields});return app.request(url,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded","X-Twilio-Signature":valid?sign(url,form):"invalid"},body:form});};
 expect((await post("/api/v1/phone-jarvis/session/answer",{AnsweredBy:"human"},false)).status).toBe(403);
 expect(await (await post("/api/v1/phone-jarvis/session/answer",{AnsweredBy:"human"})).text()).toContain("Gather");expect(prepared).toBe(0);
 expect(await (await post("/api/v1/phone-jarvis/session/answer",{AnsweredBy:"unknown"})).text()).toContain("Gather");expect(prepared).toBe(0);expect(registrations).toBe(0);
 expect(await (await post("/api/v1/phone-jarvis/session/pin?attempt=0",{Digits:"000000"})).text()).toContain("attempt=1");
 expect(await (await post("/api/v1/phone-jarvis/session/pin?attempt=0",{Digits:"123456"})).text()).toContain("Hangup");expect(registrations).toBe(0);
 expect(await (await post("/api/v1/phone-jarvis/session/pin?attempt=1",{Digits:"123456"})).text()).toContain("Connect");expect(registrations).toBe(1);expect(prepared).toBe(1);
 await post("/api/v1/phone-jarvis/session/pin?attempt=1",{Digits:"123456"});expect(registrations).toBe(1);
 session={...session,connection:"pending",authenticated:false,attempts:0};
 const machine=await (await post("/api/v1/phone-jarvis/session/answer",{AnsweredBy:"machine_start"})).text();expect(machine).toContain("Hangup");expect(machine).not.toContain("Say");
 session={...session,connection:"pending",attempts:2}; await post("/api/v1/phone-jarvis/session/pin?attempt=2",{Digits:"000000"});expect(session.attempts).toBe(3);
 expect(await(await post("/api/v1/phone-jarvis/session/pin?attempt=3",{Digits:"123456"})).text()).toContain("Hangup");expect(registrations).toBe(1);
});
