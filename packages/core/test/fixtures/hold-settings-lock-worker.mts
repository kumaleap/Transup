import fsNativeExtensions from "fs-native-extensions";
import { open, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

const [lockPath, readyPath] = process.argv.slice(2);
if (!lockPath || !readyPath) throw new Error("missing lock holder arguments");

const handle = await open(lockPath, "a+", 0o600);
await fsNativeExtensions.waitForLock(handle.fd);
await writeFile(readyPath, "ready", "utf-8");

while (true) await delay(1_000);
