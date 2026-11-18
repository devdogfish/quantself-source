import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, stat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
async function fixture(overrides:Record<string,string>={}) {
 const root=await mkdtemp(join(tmpdir(),"phone-verification-"));const bin=join(root,"bin");await mkdir(bin);
 await writeFile(join(bin,"git"),`#!/usr/bin/env bash
if [[ "$1" == ls-remote ]]; then echo "$TEST_MAIN refs/heads/main"; else echo "$TEST_HEAD"; fi
`,{mode:0o700});
 await writeFile(join(bin,"docker"),`#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == compose ]]; then
 shift 5
 case "$1" in
 ps) echo api-container ;;
 config) printf '{"services":{"api":{"environment":{"QUANTSELF_PHONE_ENABLED":"%s"}}}}' "$TEST_COMPOSE_ENABLED" ;;
 exec) [[ "$*" == 'exec -T api bun apps/api/scripts/verify-phone-call.ts 1234' ]]; touch "$TEST_ROOT/dial-requested"; echo 'Owner verification call requested.' ;;
 *) exit 91 ;;
 esac
elif [[ "$1" == inspect ]]; then
 if [[ "$3" == *State.Running* ]]; then echo true; else echo "$TEST_IMAGE"; fi
elif [[ "$1" == exec ]]; then test "$TEST_PROCESS_ENABLED" = 1
else exit 92
fi
`,{mode:0o700});
 const revision="a".repeat(40);const child=Bun.spawn(["bash",join(import.meta.dir,"verify-phone-production.sh"),root,revision,"1234"],{env:{...process.env,PATH:`${bin}:${process.env.PATH}`,TEST_ROOT:root,TEST_MAIN:revision,TEST_HEAD:revision,TEST_IMAGE:revision,TEST_COMPOSE_ENABLED:"1",TEST_PROCESS_ENABLED:"1",...overrides},stdout:"pipe",stderr:"pipe"});
 return {root,exit:await child.exited,stdout:await new Response(child.stdout).text(),cleanup:()=>rm(root,{recursive:true,force:true})};
}
test("verified main and enabled running image invokes one fixed script without destinations",async()=>{const f=await fixture();try{expect(f.exit).toBe(0);expect(f.stdout).toBe("Owner verification call requested.\n");expect(await stat(join(f.root,"dial-requested")).catch(()=>null)).not.toBeNull();}finally{await f.cleanup();}});
test("stale main/checkout/image or disabled phone blocks operator call",async()=>{for(const override of [{TEST_MAIN:"b".repeat(40)},{TEST_HEAD:"b".repeat(40)},{TEST_IMAGE:"b".repeat(40)},{TEST_COMPOSE_ENABLED:""},{TEST_PROCESS_ENABLED:""}]){const f=await fixture(override);try{expect(f.exit).not.toBe(0);expect(await stat(join(f.root,"dial-requested")).catch(()=>null)).toBeNull();}finally{await f.cleanup();}}});
test("Actions workflow requires main and stable run id with no destination input",async()=>{const workflow=await readFile(join(import.meta.dir,"fixtures/production-workflows/verify-phone-call.yml"),"utf8");expect(workflow).toContain('run: test "$WORKFLOW_REF" = refs/heads/main');expect(workflow).toContain("VERIFY_INVOCATION: ${{ github.run_id }}");expect(workflow).not.toContain("github.run_attempt");expect(workflow).not.toContain("inputs:");expect(workflow).toContain("group: production-deploy");});
