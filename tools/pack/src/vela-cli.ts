import { chmod, cp, mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

export const VELA_CLI_BIN_ENV = "OPEN_DESIGN_VELA_CLI_BIN";

type VelaCliPlatform = "linux" | "mac" | "win";
type VelaCliResolveResult =
  | string
  | null
  | undefined
  | {
      path?: string | null;
      supported?: boolean;
    };
type VelaCliResolverModule = {
  resolveVelaCliBin?: (
    options?: { strict?: boolean },
  ) => VelaCliResolveResult | Promise<VelaCliResolveResult>;
};

function strictResolutionError(message: string, cause?: unknown): Error {
  return new Error(
    `${message}; install @powerformer/vela-cli through pnpm install or set ${VELA_CLI_BIN_ENV}`,
    cause === undefined ? undefined : { cause },
  );
}

function targetBinaryName(platform: VelaCliPlatform): string {
  return platform === "win" ? "vela.exe" : "vela";
}

export async function copyOptionalVelaCliBinary({
  env = process.env,
  importPackage,
  platform,
  requireBundled = false,
  resourceRoot,
}: {
  env?: NodeJS.ProcessEnv;
  importPackage?: (packageName: string) => Promise<VelaCliResolverModule>;
  platform: VelaCliPlatform;
  requireBundled?: boolean;
  resourceRoot: string;
}): Promise<{ source: string; target: string } | null> {
  const source = await resolveOptionalVelaCliBinary({ env, importPackage, requireBundled });
  if (source == null) return null;
  const target = join(resourceRoot, "bin", targetBinaryName(platform));
  await mkdir(dirname(target), { recursive: true });
  await cp(source, target);
  await copyAdjacentSupportTree({ source, target, supportTreeName: "libexec" });
  if (platform !== "win") {
    await chmod(target, 0o755);
  }
  return { source, target };
}

async function copyAdjacentSupportTree({
  source,
  target,
  supportTreeName,
}: {
  source: string;
  target: string;
  supportTreeName: string;
}): Promise<void> {
  const sourceSupportTree = join(dirname(source), supportTreeName);
  const targetSupportTree = join(dirname(target), supportTreeName);

  try {
    const sourceSupportTreeStat = await stat(sourceSupportTree);
    if (!sourceSupportTreeStat.isDirectory()) return;
  } catch (error) {
    if (isNotFoundError(error)) return;
    throw error;
  }

  await cp(sourceSupportTree, targetSupportTree, { recursive: true });
}

function isNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

export async function resolveOptionalVelaCliBinary({
  env = process.env,
  importPackage = async (packageName: string) =>
    import(packageName) as Promise<VelaCliResolverModule>,
  requireBundled = false,
}: {
  env?: NodeJS.ProcessEnv;
  importPackage?: (packageName: string) => Promise<VelaCliResolverModule>;
  requireBundled?: boolean;
} = {}): Promise<string | null> {
  const envSource = env[VELA_CLI_BIN_ENV]?.trim();
  if (envSource) return envSource;

  let resolver: VelaCliResolverModule;
  try {
    resolver = await importPackage("@powerformer/vela-cli");
  } catch (error) {
    if (requireBundled) {
      throw strictResolutionError(
        "unable to resolve bundled Vela CLI: package @powerformer/vela-cli is unavailable",
        error,
      );
    }
    return null;
  }

  if (typeof resolver.resolveVelaCliBin !== "function") {
    if (requireBundled) {
      throw strictResolutionError(
        "unable to resolve bundled Vela CLI: @powerformer/vela-cli must export resolveVelaCliBin",
      );
    }
    return null;
  }

  const resolved = await resolver.resolveVelaCliBin({ strict: requireBundled });
  if (typeof resolved === "string") {
    const normalized = resolved.trim();
    if (normalized.length > 0) return normalized;
  }
  if (resolved && typeof resolved === "object" && typeof resolved.path === "string") {
    const normalized = resolved.path.trim();
    if (normalized.length > 0) return normalized;
  }
  if (requireBundled) {
    throw strictResolutionError(
      "unable to resolve bundled Vela CLI: @powerformer/vela-cli returned no binary path",
    );
  }
  return null;
}
