import { verifyNativeOwnerOnlyWindowsAcl } from "../packages/utils/src/windows-acl-native.ts";

const target = process.env.VEYYON_OWNER_ONLY_ACL_PATH;
if (!target) {
  console.error("VEYYON_OWNER_ONLY_ACL_PATH is missing");
  process.exit(1);
}

try {
  verifyNativeOwnerOnlyWindowsAcl(target);
  process.stdout.write("OK");
  process.exit(0);
} catch (e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(msg);
  process.exit(1);
}
