import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "fs-native-extensions") {
      throw new Error("native lock addon unavailable on this host");
    }
    return nextResolve(specifier, context);
  },
});

const [operation, rule, settingsDir, workspace, userConfigDir] = process.argv.slice(2);
const settings = await import("../../src/settings.js");

if (operation === "import") {
  // Importing is the behavior under test.
} else if (operation === "persist") {
  if (!rule || !settingsDir || !workspace || !userConfigDir) {
    throw new Error("missing native-addon fallback worker arguments");
  }
  await settings.persistPermissionRule(rule, "allow", "localSettings", settingsDir, {
    workspace,
    userConfigDir,
  });
} else {
  throw new Error("missing native-addon worker operation");
}
