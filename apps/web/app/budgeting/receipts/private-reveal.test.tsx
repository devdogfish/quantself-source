import { expect, mock, test } from "bun:test";
import { act } from "react";
import { Window } from "happy-dom";

test("reveal is explicit and hiding aborts a delayed reveal without restoring private content",async()=>{
  mock.module("next/navigation",()=>({useParams:()=>({id:"doc-1"}),useRouter:()=>({push(){},replace(){}})}));
  const dom=new Window({url:"http://localhost/budgeting/receipts/doc-1"});
  const keys=["window","document","navigator","HTMLElement","Element","Node","Event","MutationObserver","getComputedStyle","requestAnimationFrame","cancelAnimationFrame","IS_REACT_ACT_ENVIRONMENT","fetch"];
  const before=new Map(keys.map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
  const requests:{path:string;signal:AbortSignal}[]=[];let finish!:(r:Response)=>void;
  const metadata={id:"doc-1",scanStatus:"archived"};
  const request=(path:string,options:any)=>{requests.push({path,signal:options.signal});return path.includes("reveal=yes")?new Promise<Response>(r=>finish=r):Promise.resolve(Response.json(metadata));};
  for(const key of keys){const v=key==='window'?dom:key==='IS_REACT_ACT_ENVIRONMENT'?true:key==='fetch'?request:(dom as any)[key];Object.defineProperty(globalThis,key,{configurable:true,writable:true,value:typeof v==='function'&&['getComputedStyle','requestAnimationFrame','cancelAnimationFrame'].includes(key)?v.bind(dom):v});}
  const host=document.createElement('div');document.body.append(host);
  const {createRoot}=await import('react-dom/client');const root=createRoot(host);
  try{
    const {default:Page}=await import('./[id]/page');
    const { ChakraTestWrapper } = await import("@/components/chakra/test-utils");
    await act(async()=>root.render(<ChakraTestWrapper><Page/></ChakraTestWrapper>));
    expect(requests.map(r=>r.path)).toEqual(['/api/v1/budgeting/receipts/doc-1']);
    expect(host.textContent).toContain('content is hidden');
    await act(async()=>host.querySelector('button')!.click());
    expect(requests[1].path).toContain('reveal=yes');
    await act(async()=>host.querySelector('button')!.click());
    expect(requests[1].signal.aborted).toBe(true);
    await act(async()=>finish(Response.json({...metadata,merchant:'SECRET ADDRESS'})));
    expect(host.textContent).not.toContain('SECRET');expect(host.textContent).toContain('content is hidden');
    expect(requests.some(r=>r.path.includes('/original'))).toBe(false);
  }finally{await act(async()=>root.unmount());dom.happyDOM.abort();for(const [k,v]of before){if(v)Object.defineProperty(globalThis,k,v);else delete(globalThis as any)[k];}mock.restore();}
});
