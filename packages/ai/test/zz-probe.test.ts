import { test } from "bun:test";
import * as path from "node:path";
import { createModuleReachCache, moduleGraph } from "@veyyon/utils/module-reach";
import { workspaceModuleReachResolution } from "@veyyon/utils/module-reach-workspace";
test("probe", () => {
  const root = path.resolve(import.meta.dir, "../../..");
  const res = workspaceModuleReachResolution(root);
  const g = moduleGraph(path.join(root, "packages/ai/src/env-api-key.ts"), res, createModuleReachCache());
  const targets = ["packages/utils/src/index.ts", "natives/bridge/bindings/native/index.js"];
  const start = path.join(root, "packages/ai/src/env-api-key.ts");
  const prev = new Map<string,string>(); const q=[start]; prev.set(start,"");
  while(q.length){const f=q.shift()!; for(const n of g.get(f)??[]) if(!prev.has(n)){prev.set(n,f);q.push(n);}}
  for (const t of targets){ let c=path.join(root,t); const ch=[]; if(!prev.has(c)){console.log("PROBE not reached",t);continue;} while(c){ch.push(path.relative(root,c)); c=prev.get(c)!;} console.log("PROBE "+ch.reverse().join(" -> ")); }
  console.log("PROBE total "+g.size);
});
