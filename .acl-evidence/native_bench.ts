import { verifyNativeOwnerOnlyWindowsAcl } from "../packages/utils/src/windows-acl-native.ts";

const target = process.env.VEYYON_OWNER_ONLY_ACL_PATH;
if (!target) {
  console.error("Missing target");
  process.exit(1);
}

// 20 sequential calls
const seqDurations: number[] = [];
for (let i = 0; i < 20; i++) {
  const t0 = performance.now();
  verifyNativeOwnerOnlyWindowsAcl(target);
  const t1 = performance.now();
  seqDurations.push(t1 - t0);
}

// 20 concurrent calls (simulated with Promise.all)
const tStart = performance.now();
const concDurations = await Promise.all(
  Array.from({ length: 20 }, async () => {
    const t0 = performance.now();
    verifyNativeOwnerOnlyWindowsAcl(target);
    const t1 = performance.now();
    return t1 - t0;
  })
);

console.log(JSON.stringify({
  seq_p50_ms: seqDurations.sort((a, b) => a - b)[10],
  seq_mean_ms: seqDurations.reduce((a, b) => a + b, 0) / 20,
  conc_p50_ms: concDurations.sort((a, b) => a - b)[10],
  conc_mean_ms: concDurations.reduce((a, b) => a + b, 0) / 20,
}));
