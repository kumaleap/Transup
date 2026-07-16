export function restoreInvocationCwd(env: NodeJS.ProcessEnv = process.env): string {
  const invocationCwd = env.INIT_CWD;
  if (invocationCwd?.trim()) {
    try {
      process.chdir(invocationCwd);
    } catch {
      // npm can leave a stale INIT_CWD; keep the directory Node actually started in.
    }
  }
  return process.cwd();
}
