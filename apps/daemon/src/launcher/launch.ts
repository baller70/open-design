import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import path from 'node:path';

import { createCommandInvocation } from '@open-design/platform';

import { spawnEnvForAgent } from '../runtimes/env.js';
import { applyAgentLaunchEnv, resolveAgentLaunch, type AgentLaunchResolution } from '../runtimes/launch.js';
import { getAgentDef } from '../runtimes/registry.js';

export type LaunchExecutionMode =
  | 'probe'
  | 'interactive-run'
  | 'fire-and-forget'
  | 'auth-setup-cli'
  | 'bounded-cli';

export interface LaunchDiagnostics {
  source: 'agent' | 'command';
  executionMode: LaunchExecutionMode;
  agentId: string | null;
  configuredOverridePath: string | null;
  pathResolvedPath: string | null;
  selectedPath: string | null;
  launchPath: string | null;
  launchKind: AgentLaunchResolution['launchKind'] | 'explicit';
  childPathPrepend: string[];
  diagnostic: string | null;
}

export interface LaunchDescriptor {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  windowsVerbatimArguments: boolean | undefined;
  executionMode: LaunchExecutionMode;
  diagnostics: LaunchDiagnostics;
}

export interface AgentLaunchDescriptorInput {
  agentId: string;
  args: string[];
  baseEnv?: NodeJS.ProcessEnv;
  configuredEnv?: Record<string, string>;
  extraEnv?: Record<string, string>;
  executionMode: LaunchExecutionMode;
}

export interface CommandLaunchDescriptorInput {
  command: string;
  args: string[];
  baseEnv?: NodeJS.ProcessEnv;
  env?: Record<string, string>;
  executionMode: LaunchExecutionMode;
  knownAgentId?: string;
  configuredEnv?: Record<string, string>;
}

export interface BoundedLaunchResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function explicitChildPathPrepend(command: string): string[] {
  if (!path.isAbsolute(command)) return [];
  return [path.dirname(command)];
}

function explicitDiagnostics(
  input: CommandLaunchDescriptorInput,
  env: NodeJS.ProcessEnv,
): LaunchDescriptor {
  const normalizedEnv = applyAgentLaunchEnv(env, {
    childPathPrepend: explicitChildPathPrepend(input.command),
  });
  const invocation = createCommandInvocation({
    command: input.command,
    args: input.args,
    env: normalizedEnv,
  });
  return {
    command: invocation.command,
    args: invocation.args,
    env: normalizedEnv,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    executionMode: input.executionMode,
    diagnostics: {
      source: 'command',
      executionMode: input.executionMode,
      agentId: null,
      configuredOverridePath: null,
      pathResolvedPath: path.isAbsolute(input.command) ? input.command : null,
      selectedPath: input.command,
      launchPath: input.command,
      launchKind: 'explicit',
      childPathPrepend: explicitChildPathPrepend(input.command),
      diagnostic: null,
    },
  };
}

export function createAgentLaunchDescriptor(
  input: AgentLaunchDescriptorInput,
): LaunchDescriptor {
  const def = getAgentDef(input.agentId);
  if (!def) throw new Error(`agent runtime "${input.agentId}" not registered`);
  const configuredEnv = input.configuredEnv ?? {};
  const baseEnv = input.baseEnv ?? process.env;
  const mergedBaseEnv = input.extraEnv ? { ...baseEnv, ...input.extraEnv } : baseEnv;
  const launch = resolveAgentLaunch(def, configuredEnv);
  if (!launch.launchPath) {
    throw new Error(
      `${def.name} binary is not installed or not on PATH. Install it or configure its explicit binary-path override.`,
    );
  }
  const launchEnv = applyAgentLaunchEnv(
    spawnEnvForAgent(
      def.id,
      {
        ...mergedBaseEnv,
        ...(def.env || {}),
      },
      configuredEnv,
    ),
    launch,
  );
  const invocation = createCommandInvocation({
    command: launch.launchPath,
    args: input.args,
    env: launchEnv,
  });
  return {
    command: invocation.command,
    args: invocation.args,
    env: launchEnv,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    executionMode: input.executionMode,
    diagnostics: {
      source: 'agent',
      executionMode: input.executionMode,
      agentId: def.id,
      configuredOverridePath: launch.configuredOverridePath,
      pathResolvedPath: launch.pathResolvedPath,
      selectedPath: launch.selectedPath,
      launchPath: launch.launchPath,
      launchKind: launch.launchKind,
      childPathPrepend: launch.childPathPrepend,
      diagnostic: launch.diagnostic,
    },
  };
}

export function createCommandLaunchDescriptor(
  input: CommandLaunchDescriptorInput,
): LaunchDescriptor {
  if (input.knownAgentId) {
    const descriptor = createAgentLaunchDescriptor({
      agentId: input.knownAgentId,
      args: input.args,
      executionMode: input.executionMode,
      ...(input.baseEnv ? { baseEnv: input.baseEnv } : {}),
      ...(input.configuredEnv ? { configuredEnv: input.configuredEnv } : {}),
      ...(input.env ? { extraEnv: input.env } : {}),
    });
    return {
      ...descriptor,
      diagnostics: {
        ...descriptor.diagnostics,
        source: 'command',
      },
    };
  }
  const baseEnv = input.baseEnv ?? process.env;
  const env = input.env ? { ...baseEnv, ...input.env } : { ...baseEnv };
  return explicitDiagnostics(input, env);
}

export function spawnLaunchDescriptor(
  descriptor: LaunchDescriptor,
  options: Omit<SpawnOptions, 'env' | 'windowsVerbatimArguments'> = {},
): ChildProcess {
  return spawn(descriptor.command, descriptor.args, {
    ...options,
    env: descriptor.env,
    windowsVerbatimArguments: descriptor.windowsVerbatimArguments,
  });
}

export async function runBoundedLaunchDescriptor(
  descriptor: LaunchDescriptor,
  options: {
    timeoutMs: number;
    cwd?: string;
  },
): Promise<BoundedLaunchResult> {
  return await new Promise<BoundedLaunchResult>((resolve, reject) => {
    const child = spawnLaunchDescriptor(descriptor, {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${descriptor.diagnostics.agentId ?? descriptor.command} timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? -1, stdout, stderr });
    });
  });
}
