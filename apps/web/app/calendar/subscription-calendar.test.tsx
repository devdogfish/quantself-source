import { expect, test } from "bun:test";
import { act } from "react";
import { Window } from "happy-dom";
import { ChakraTestWrapper } from "@/components/chakra/test-utils";
import { useSubscriptionCalendar, SubscriptionCalendarChips, SubscriptionCalendarStatus } from "./subscription-calendar";

test("one range request renders all payment chips; denied permission makes no request", async () => {
  const dom = new Window({url:"http://localhost/calendar"});
  const names = ["window","document","navigator","HTMLElement","Element","Node","Event","MutationObserver","getComputedStyle","requestAnimationFrame","cancelAnimationFrame","IS_REACT_ACT_ENVIRONMENT","fetch"];
  const before = new Map(names.map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]));
  let reads = 0; let resolve!: (value: Response)=>void;
  for(const name of names) {
    const value = name === "window" ? dom : name === "IS_REACT_ACT_ENVIRONMENT" ? true : name === "fetch" ? (path:string)=>{ reads++;expect(path).toContain("from=2026-11-01&through=2026-12-31");return new Promise<Response>(r=>resolve=r); } : (dom as any)[name];
    Object.defineProperty(globalThis,name,{configurable:true,writable:true,value:typeof value === "function" && ["getComputedStyle","requestAnimationFrame","cancelAnimationFrame"].includes(name)?value.bind(dom):value});
  }
  const host=document.createElement("div");document.body.append(host);
  const {createRoot}=await import("react-dom/client");const root=createRoot(host);
  function Fixture({enabled}:{enabled:boolean}) { const data=useSubscriptionCalendar("2026-11-01","2026-12-31",enabled);return <ChakraTestWrapper><SubscriptionCalendarStatus value={data}/><SubscriptionCalendarChips payments={data.days.get("2026-11-12")}/></ChakraTestWrapper>; }
  try {
    await act(async()=>root.render(<Fixture enabled={false}/>));expect(reads).toBe(0);
    await act(async()=>root.render(<Fixture enabled/>));expect(reads).toBe(1);expect(host.textContent).toContain("Loading subscription payments");
    await act(async()=>resolve(Response.json({payments:[{id:"prime",key:"prime:2026-11-12",label:"Prime",date:"2026-11-12",cents:1139,kind:"bill",frequency:"once",subscriptionId:"prime",paid:false},{id:"other",key:"other:2026-11-12",label:"Other",date:"2026-11-12",cents:500,kind:"bill",frequency:"once",subscriptionId:"other",paid:true}]})));
    expect(host.querySelectorAll("a").length).toBe(2);expect(host.querySelector("a")?.getAttribute("href")).toBe("/budgeting/subscriptions?subscription=prime");
    expect(host.textContent).toContain("Expected payment");expect(host.textContent).toContain("Paid");expect(reads).toBe(1);
  } finally {await act(async()=>root.unmount());dom.happyDOM.abort();for(const [name,value] of before) {if(value)Object.defineProperty(globalThis,name,value);else delete (globalThis as any)[name];}}
});
