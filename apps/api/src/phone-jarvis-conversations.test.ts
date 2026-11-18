import { expect, test } from "bun:test";
import { createPhoneConversations, type PhoneConversationRepository } from "./phone-jarvis-conversations";
import type { CaptureStore } from "./todos-captures";
import type { PhoneSession } from "./phone-jarvis-store-types";
import type { PhoneJarvisConfig } from "./phone-jarvis-provider";
import type { JarvisProvider } from "./todos-jarvis";
import type { TodoReader } from "./todos-github";
import { createAudioStorage } from "./todos-audio";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const id="31111111-1111-4111-8111-111111111111";
const config={agentId:"phone-agent",elevenLabsApiKey:"key"} as PhoneJarvisConfig;
function fixture() {
 const rows=new Map<string,{input:any;result:any}>();
 const store:CaptureStore={reserve:async(k,input)=>{const prior=rows.get(k);if(prior&&JSON.stringify(prior.input)!==JSON.stringify(input))throw Error("Conflict");const value=prior??{input,result:null};rows.set(k,value);return value;},get:async k=>rows.get(k)??null,save:async(k,result)=>{rows.get(k)!.result=result;},list:async prefix=>[...rows].filter(([key])=>key.startsWith(prefix)).map(([,row])=>row)};
 const session:PhoneSession={id:"phone-session",captureId:id,authenticated:true,callSid:"call",direction:"inbound",attempts:1,connection:"connecting",expiresAt:new Date(Date.now()+60000)};
 let verified=true, archived=0, reads=0,audioReads=0;
 const repository:PhoneConversationRepository={ownerId:async()=>"actual-owner",authenticated:async()=>verified,recent:async()=>[{captureId:id,capturedAt:"2026-10-29T12:00:00Z",conversationId:"conversation",summary:"Earlier discussion"}],pending:async()=>[{...session,conversationId:"conversation"}],bind:async()=>true,archived:async()=>{archived++;}};
 const provider:JarvisProvider={agentId:()=>config.agentId,temporaryAccess:async()=>{throw Error("unused");},finalConversation:async()=>{reads++;return {agentId:config.agentId,userId:id,conversationId:"conversation",done:true,capturedAt:"2026-10-30T12:00:00Z",summary:"Planned tomorrow together",conversation:[{role:"user",text:"Plan tomorrow"}]};},audio:async()=>{audioReads++;return {bytes:new Uint8Array([1,2,3]),mime:"audio/mpeg"};}};
 return {rows,store,session,repository,provider,setVerified:(value:boolean)=>{verified=value;},counts:()=>({archived,reads,audioReads})};
}
test("prepare requires durable PIN then reserves actual Owner and bounded history",async()=>{
 const f=fixture();const service=createPhoneConversations({config,reader:{} as TodoReader,...f});
 await expect(service.prepareConversation({...f.session,authenticated:false})).rejects.toThrow();expect(f.rows.size).toBe(0);
 f.setVerified(false);await expect(service.prepareConversation(f.session)).rejects.toThrow();f.setVerified(true);
 const result=await service.prepareConversation(f.session);expect(result.context).toContain("Earlier discussion");expect(f.rows.get(`jarvis:${id}`)?.input.owner).toBe("actual-owner");expect(f.rows.get(`phone-jarvis:${id}`)?.input).toEqual({sessionId:"phone-session",agentId:"phone-agent"});
 f.rows.set(`deleted:${id}`,{input:{id},result:null});await expect(service.prepareConversation(f.session)).rejects.toThrow();
});
test("archive verifies agent/user before retaining original audio; replay verifies media",async()=>{
 const f=fixture();const root=await mkdtemp(join(tmpdir(),"phone-archive-"));
 try { const service=createPhoneConversations({config,reader:{} as TodoReader,...f,audio:createAudioStorage(()=>root)});
 await service.tickArchive();expect(f.counts()).toEqual({archived:1,reads:1,audioReads:1});expect(f.rows.get(`capture:${id}`)?.input.transcript).toContain("Plan tomorrow");
 await service.tickArchive();expect(f.counts()).toEqual({archived:2,reads:2,audioReads:1});
 f.rows.set(`deleted:${id}`,{input:{id},result:null});await service.tickArchive();expect(f.counts().reads).toBe(2);
 } finally {await rm(root,{recursive:true,force:true});}
});
test("mismatched provider identity never creates transcript/audio",async()=>{
 const f=fixture();const original=f.provider.finalConversation;f.provider.finalConversation=async id=>({...await original(id),agentId:"browser-agent"});
 await createPhoneConversations({config,reader:{} as TodoReader,...f}).tickArchive();expect(f.counts().audioReads).toBe(0);expect(f.rows.has(`capture:${id}`)).toBe(false);
});
test("PIN preparation uses cached summaries with zero provider requests even when history lacks summaries",async()=>{
 const f=fixture();await f.store.reserve(`capture:${id}`,{transcript:"PRIVATE RAW PREFIX"});
 f.repository.recent=async()=>Array.from({length:8},(_,index)=>({captureId:id,capturedAt:"2026-10-29T12:00:00Z",conversationId:"conversation",...(index===0?{summary:"Cached earlier discussion"}:{})}));
 // A provider outage must not delay authentication or trigger any network read.
 let providerReads=0;
 f.provider.finalConversation=async()=>{providerReads++;throw Error("Provider must not run during PIN preparation");};
 let requests=0;
 const result=await createPhoneConversations({config,reader:{} as TodoReader,...f,request:(async()=>{requests++;throw Error("Unexpected request");}) as unknown as typeof fetch}).prepareConversation(f.session);
 expect(f.counts()).toEqual({archived:0,reads:0,audioReads:0});expect(requests).toBe(0);expect(providerReads).toBe(0);
 expect(result.context).toContain("Cached earlier discussion");expect(result.context).not.toContain("PRIVATE RAW PREFIX");expect(f.rows.get(`capture:${id}`)?.result).toBeNull();
});
test("deleted sessions retired; missing provider conversations rotate without audio fetch",async()=>{
 const f=fixture();let retired=0,deferred=0;
 f.repository.discardDeleted=async()=>{retired++;};f.repository.defer=async()=>{deferred++;};
 f.rows.set(`deleted:${id}`,{input:{id},result:null});
 const service=createPhoneConversations({config,reader:{} as TodoReader,...f});await service.tickArchive();expect(retired).toBe(1);expect(deferred).toBe(1);expect(f.counts().reads).toBe(0);
 f.rows.delete(`deleted:${id}`);f.repository.pending=async()=>[{...f.session,conversationId:null}];
 let requests=0;
 await createPhoneConversations({config,reader:{} as TodoReader,...f,request:(async(_url: string | URL | Request, _init?: RequestInit)=>{requests++;return Response.json({conversations:[],has_more:false});}) as typeof fetch}).tickArchive();
 expect(requests).toBe(1);expect(deferred).toBe(2);expect(f.counts().audioReads).toBe(0);
});
test("phone context includes actual Halifax clock across midnight and DST",async()=>{
 const f=fixture();const make=async(instant:string)=>JSON.parse((await createPhoneConversations({config,reader:{} as TodoReader,...f,now:()=>new Date(instant)}).prepareConversation(f.session)).context);
 expect((await make("2026-10-27T01:55:00Z")).clock).toEqual({timeZone:"America/Halifax",today:"2026-10-26",localTime:"22:55",utcOffset:"-03:00"});
 expect((await make("2026-12-27T03:55:00Z")).clock).toEqual({timeZone:"America/Halifax",today:"2026-12-26",localTime:"23:55",utcOffset:"-04:00"});
 expect((await make("2026-11-01T04:59:00Z")).clock).toMatchObject({localTime:"01:59",utcOffset:"-03:00"});
 expect((await make("2026-11-01T05:00:00Z")).clock).toMatchObject({localTime:"01:00",utcOffset:"-04:00"});
});

test("missing historical summaries hydrate only in bounded background work",async()=>{
 const f=fixture();await f.store.reserve(`capture:${id}`,{transcript:"PRIVATE RAW PREFIX"});
 f.repository.pending=async()=>[];
 f.repository.recent=async()=>Array.from({length:8},()=>({captureId:id,capturedAt:"2026-10-29T12:00:00Z",conversationId:"conversation"}));
 const service=createPhoneConversations({config,reader:{} as TodoReader,...f});
 await service.prepareConversation(f.session);expect(f.counts().reads).toBe(0);
 await service.tickArchive();expect(f.counts().reads).toBe(2);expect(f.counts().audioReads).toBe(0);
 expect(f.rows.get(`capture:${id}`)?.result.summary).toBe("Planned tomorrow together");
});
