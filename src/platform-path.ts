import { homedir } from "node:os";
import { posix, resolve, win32 } from "node:path";

const WINDOWS_ABSOLUTE_RE = /^(?:[a-zA-Z]:[\\/]|\\\\)/;

function isWindowsStyle(path: string): boolean {
  return WINDOWS_ABSOLUTE_RE.test(path);
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return homedir() + path.slice(1);
  return path;
}

/** Resolve a path using its own syntax, even when tests run on another OS. */
export function resolvePortablePath(path: string): string {
  const expanded = expandHome(path);
  if (isWindowsStyle(expanded)) return win32.resolve(expanded);
  if (expanded.startsWith("/")) return posix.resolve(expanded);
  return resolve(expanded);
}

export function hasParentTraversal(path: string): boolean {
  return path.split(/[\\/]+/).includes("..");
}

/** Resolve an untrusted child and return it only when it stays under root. */
export function resolveInside(root: string, child: string): string | null {
  if (hasParentTraversal(child)) return null;
  const absoluteRoot = resolve(root);
  const target = resolve(absoluteRoot, child);
  const pathApi = process.platform === "win32" ? win32 : posix;
  const rel = pathApi.relative(absoluteRoot, target);
  if (rel === "" || (!pathApi.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${pathApi.sep}`))) {
    return target;
  }
  return null;
}

/** Match a policy path/root/glob consistently on Windows, Linux and macOS. */
export function matchesPortablePath(value: string, rawPattern: string): boolean {
  if (rawPattern === "*") return true;
  const pattern = rawPattern === "~/" || rawPattern === "~\\" ? homedir() : expandHome(rawPattern);
  const windows = isWindowsStyle(value) || isWindowsStyle(pattern);
  const normalize = (input: string): string => {
    const normalized = resolvePortablePath(input)
      .replace(/\\/g, "/")
      .replace(/\/{2,}/g, "/")
      .replace(/\/$/, "");
    return windows ? normalized.toLowerCase() : normalized;
  };
  const normalizedValue = normalize(value);
  const normalizedPattern = normalize(pattern);

  if (rawPattern.endsWith("/**") || rawPattern.endsWith("\\**")) {
    const root = normalizedPattern.slice(0, -3).replace(/\/$/, "");
    return normalizedValue === root || normalizedValue.startsWith(root + "/");
  }
  if (rawPattern.includes("*")) {
    const escaped = normalizedPattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`^${escaped}$`, windows ? "i" : "").test(normalizedValue);
  }
  return normalizedValue === normalizedPattern || normalizedValue.startsWith(normalizedPattern + "/");
}
