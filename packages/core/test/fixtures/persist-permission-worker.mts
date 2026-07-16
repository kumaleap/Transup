import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { persistPermissionRule } from "../../src/settings.js";

const [readyPath, gatePath, rule, settingsDir, workspace, userConfigDir] = process.argv.slice(2);
if (!readyPath || !gatePath || !rule || !settingsDir || !workspace || !userConfigDir) {
  throw new Error("missing worker arguments");
}

await writeFile(readyPath, "ready", "utf-8");
const deadline = Date.now() + 10_000;
while (!existsSync(gatePath)) {
  if (Date.now() >= deadline) throw new Error("timed out waiting for permission worker gate");
  await delay(5);
}

await persistPermissionRule(rule, "allow", "localSettings", settingsDir, {
  workspace,
  userConfigDir,
});
