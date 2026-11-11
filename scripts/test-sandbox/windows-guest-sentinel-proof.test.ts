import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

test.skipIf(process.platform !== "win32")("sandbox admission probe and sentinel denial hold in guest", () => {
  const marker = process.env.VEYYON_TEST_SANDBOX;
  expect(marker).toBe("windows-appcontainer");

  const hostHome = process.env.VEYYON_TEST_HOST_HOME;
  expect(hostHome).toBeDefined();

  const sentinel = process.env.VEYYON_TEST_HOST_SENTINEL;
  expect(sentinel).toBeDefined();

  // Re-verify that in-container guest cannot read host sentinel
  let sentinelErrorCode: string | undefined;
  try {
    fs.readFileSync(sentinel!, "utf8");
  } catch (e: unknown) {
    if (e && typeof e === "object" && "code" in e && typeof e.code === "string") {
      sentinelErrorCode = e.code;
    }
  }
  expect(sentinelErrorCode).toBeDefined();
  expect(["EPERM", "EACCES"]).toContain(sentinelErrorCode!);

  // Re-verify that in-container guest cannot read host .veyyon or shared-auth
  const veyyonDir = path.join(hostHome!, ".veyyon");
  let veyyonErrorCode: string | undefined;
  try {
    fs.readdirSync(veyyonDir);
  } catch (e: unknown) {
    if (e && typeof e === "object" && "code" in e && typeof e.code === "string") {
      veyyonErrorCode = e.code;
    }
  }
  expect(veyyonErrorCode).toBeDefined();
  expect(["EPERM", "EACCES", "ENOENT"]).toContain(veyyonErrorCode!);

  const sharedAuthDir = path.join(veyyonDir, "shared-auth");
  let sharedAuthErrorCode: string | undefined;
  try {
    fs.readdirSync(sharedAuthDir);
  } catch (e: unknown) {
    if (e && typeof e === "object" && "code" in e && typeof e.code === "string") {
      sharedAuthErrorCode = e.code;
    }
  }
  expect(sharedAuthErrorCode).toBeDefined();
  expect(["EPERM", "EACCES", "ENOENT"]).toContain(sharedAuthErrorCode!);
  expect(process.env.GITHUB_TOKEN).toBeUndefined();
  expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
  expect(process.env.OPENAI_API_KEY).toBeUndefined();
  expect(process.env.BITWARDEN_SESSION).toBeUndefined();
});
