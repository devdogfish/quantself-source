import { expect, test } from "bun:test";
import { requestPhoneVerificationCall } from "./phone-jarvis-verification";
import type { PhoneScheduleStore } from "./phone-jarvis-scheduler";
function fixture() {
 const slots=new Set<string>();const events:string[]=[];let dials=0;
 const store:PhoneScheduleStore={status:async()=>null,claim:async(slot)=>{events.push("claim");if(slots.has(slot))return null;slots.add(slot);return {id:"session"};},bindCall:async()=>{events.push("bind");return true;},uncertain:async()=>{events.push("uncertain");}};
 const dial=async()=>{events.push("dial");dials++;return "call";};
 return {store,dial,events,slots,dials:()=>dials};
}
test("manual invocation claims unique separate slot before one Owner dial; concurrent rerun suppressed",async()=>{
 const f=fixture();const results=await Promise.all([requestPhoneVerificationCall("1234",f.store,f.dial),requestPhoneVerificationCall("1234",f.store,f.dial)]);
 expect(results.sort()).toEqual(["already-requested","requested"]);expect(f.dials()).toBe(1);expect(f.events.indexOf("claim")).toBeLessThan(f.events.indexOf("dial"));expect([...f.slots]).toEqual(["manual-verification:1234"]);
 expect(await requestPhoneVerificationCall("1234",f.store,f.dial)).toBe("already-requested");expect(f.dials()).toBe(1);
});
test("lost provider response is durable uncertain and rerun cannot redial",async()=>{
 const f=fixture();let attempts=0;const dial=async()=>{attempts++;throw Error("private provider error");};
 expect(await requestPhoneVerificationCall("1234",f.store,dial)).toBe("uncertain");expect(f.events).toEqual(["claim","uncertain"]);
 expect(await requestPhoneVerificationCall("1234",f.store,dial)).toBe("already-requested");expect(attempts).toBe(1);
});
test("invalid invocation rejected before claim; bind failure never redials",async()=>{
 const f=fixture();for(const value of ["","0","../owner","123;bad","1".repeat(21)])await expect(requestPhoneVerificationCall(value,f.store,f.dial)).rejects.toThrow();expect(f.events).toEqual([]);
 f.store.bindCall=async()=>false;expect(await requestPhoneVerificationCall("1234",f.store,f.dial)).toBe("uncertain");expect(await requestPhoneVerificationCall("1234",f.store,f.dial)).toBe("already-requested");expect(f.dials()).toBe(1);
});
