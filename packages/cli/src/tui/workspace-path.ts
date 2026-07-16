import {homedir} from "node:os";
import {parse, sep} from "node:path";

/** 用 ~ 缩写 home 内路径；相似前缀（如 /Users/kuma-other）保持原样。 */
export function abbreviateHome(path: string, home = homedir()): string {
  const root = parse(home).root;
  let normalizedHome = home;
  while (normalizedHome.length > root.length && normalizedHome.endsWith(sep)) {
    normalizedHome = normalizedHome.slice(0, -sep.length);
  }

  if (path === normalizedHome) return "~";
  const homePrefix = normalizedHome === root ? root : normalizedHome + sep;
  if (!path.startsWith(homePrefix)) return path;
  return `~${sep}${path.slice(homePrefix.length)}`;
}
