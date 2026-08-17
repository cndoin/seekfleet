// profiles.ts - profile management helpers.
// Wraps dsh's `plugin --profile <name> <pnpm args>` and `--dump-config`.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve as resolvePath } from "node:path";
import { DshClient } from "./dsh-client.js";

const execFileP = promisify(execFile);

export async function dumpProfileConfig(
  client: DshClient,
  args: { profile: string; patches?: string[]; defaultOnly?: boolean },
): Promise<{ yaml: string; stderr: string }> {
  const cliArgs: string[] = [];
  if (args.defaultOnly) cliArgs.push("--dump-default-config");
  else cliArgs.push("--dump-config");
  cliArgs.push("--profile", args.profile);
  if (!args.defaultOnly) for (const p of args.patches ?? []) cliArgs.push("--patch", p);
  try {
    const { stdout, stderr } = await execFileP(process.execPath, [client.resolved.binJs, ...cliArgs], {
      env: { ...process.env, DSH_HOME: client.resolved.dshHome },
      maxBuffer: 32 * 1024 * 1024,
    });
    return { yaml: stdout, stderr };
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return { yaml: err.stdout ?? "", stderr: err.stderr ?? err.message ?? "" };
  }
}

export async function profilePluginAction(
  client: DshClient,
  args: { profile: string; action: "add" | "remove" | "why"; pkg: string; cwd?: string },
): Promise<{ stdout: string; stderr: string; code: number }> {
  return await new Promise((resolveP) => {
    execFile(
      process.execPath,
      [client.resolved.binJs, "plugin", "--profile", args.profile, args.action, args.pkg],
      {
        env: { ...process.env, DSH_HOME: client.resolved.dshHome },
        cwd: args.cwd ? resolvePath(args.cwd) : process.cwd(),
      },
      (err, stdout, stderr) => {
        const e = err as { code?: number } | null;
        resolveP({ stdout, stderr, code: e?.code ?? (err ? 1 : 0) });
      },
    );
  });
}
