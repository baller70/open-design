// Thin wrapper over `codex mcp add|remove|get` so the Settings panel can
// offer a one-click "Install to Codex" toggle instead of asking the user
// to paste TOML into ~/.codex/config.toml. We shell out to the bundled
// Codex CLI rather than rewriting config.toml ourselves so we inherit
// Codex's own merge / dedupe / validation rules.
//
// CodexRunner is injected so tests can stub the launcher without poking the
// global child_process module; production uses the bounded CLI launch contract.

import { createCommandLaunchDescriptor, runBoundedLaunchDescriptor } from './launcher/launch.js';

export interface CodexRunnerResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CodexRunner {
  run(args: string[], opts?: { env?: Record<string, string> }): Promise<CodexRunnerResult>;
}

export async function runCodexCli(
  args: string[],
  opts?: { env?: Record<string, string> },
): Promise<CodexRunnerResult> {
  const codexConfiguredEnv =
    typeof opts?.env?.CODEX_BIN === 'string' && opts.env.CODEX_BIN.trim().length > 0
      ? { CODEX_BIN: opts.env.CODEX_BIN }
      : {};
  const descriptor = createCommandLaunchDescriptor({
    command: 'codex',
    args,
    baseEnv: process.env,
    executionMode: 'bounded-cli',
    knownAgentId: 'codex',
    ...(opts?.env ? { env: opts.env } : {}),
    ...(Object.keys(codexConfiguredEnv).length > 0
      ? { configuredEnv: codexConfiguredEnv }
      : {}),
  });
  return await runBoundedLaunchDescriptor(descriptor, { timeoutMs: 30_000 });
}

const defaultCodexRunner: CodexRunner = { run: runCodexCli };

let _runner: CodexRunner | null = null;

// Tests inject a stub runner; production callers use the default. Pass
// null to restore the default (called from afterEach in test suites).
export function setCodexRunner(runner: CodexRunner | null): void {
  _runner = runner;
}

function activeRunner(): CodexRunner {
  return _runner ?? defaultCodexRunner;
}

export interface CodexInstallStatus {
  // True when the `codex` CLI was found and is runnable. False = the
  // user does not have Codex CLI on PATH (the UI should show the
  // one-click button as disabled with an explanatory tooltip).
  available: boolean;
  // True when an MCP server with `name` is already registered in
  // ~/.codex/config.toml. Drives the toggle's "install" vs "uninstall"
  // label.
  installed: boolean;
}

export async function probeCodexInstall(name: string): Promise<CodexInstallStatus> {
  try {
    const result = await activeRunner().run(['mcp', 'get', name]);
    return { available: true, installed: result.exitCode === 0 };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') {
      return { available: false, installed: false };
    }
    throw err;
  }
}

export interface CodexInstallSpec {
  // MCP server name as it will appear in ~/.codex/config.toml. We
  // hard-code "open-design" at the route layer but keep the parameter
  // explicit so the helper can later be reused for other server names.
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

export async function installCodexMcp(spec: CodexInstallSpec): Promise<void> {
  const argv: string[] = ['mcp', 'add', spec.name];
  for (const [key, value] of Object.entries(spec.env)) {
    argv.push('--env', `${key}=${value}`);
  }
  argv.push('--', spec.command, ...spec.args);
  const result = await activeRunner().run(argv);
  if (result.exitCode !== 0) {
    throw new Error(`codex mcp add failed: ${failureDetail(result)}`);
  }
}

export async function uninstallCodexMcp(name: string): Promise<void> {
  const result = await activeRunner().run(['mcp', 'remove', name]);
  if (result.exitCode !== 0) {
    throw new Error(`codex mcp remove failed: ${failureDetail(result)}`);
  }
}

function failureDetail(result: CodexRunnerResult): string {
  return result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
}
