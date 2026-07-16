import fsNativeExtensions from "fs-native-extensions";
import { open, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { persistPermissionRule } from "../../src/settings.js";

const [blockedPath, lockPath, rule, settingsDir, workspace, userConfigDir] = process.argv.slice(2);
if (!blockedPath || !lockPath || !rule || !settingsDir || !workspace || !userConfigDir) {
  throw new Error("missing lock recovery worker arguments");
}

const handle = await open(lockPath, "a+", 0o600);
if (fsNativeExtensions.tryLock(handle.fd)) {
  fsNativeExtensions.unlock(handle.fd);
  await handle.close();
  throw new Error("expected the settings lock to be held");
}
await writeFile(blockedPath, "blocked", "utf-8");
const deadline = Date.now() + 10_000;
while (!fsNativeExtensions.tryLock(handle.fd)) {
  if (Date.now() >= deadline) throw new Error("timed out waiting for crashed settings lock");
  await delay(5);
}
fsNativeExtensions.unlock(handle.fd);
await handle.close();

await persistPermissionRule(rule, "allow", "localSettings", settingsDir, {
  workspace,
  userConfigDir,
});
