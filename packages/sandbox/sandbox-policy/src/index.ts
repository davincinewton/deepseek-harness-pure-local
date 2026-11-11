/**
 * The sandbox POLICY home (`ctx.sandboxPolicy`): the single owner of the
 * deployment's sandbox fallbacks plus per-session resolution: the file-effect
 * {@link SandboxMode}, the `workspace-write` root, and the override kit (the
 * `sandbox/mode` event, its fold, and its write path, from `./session-mode.ts`).
 * Before each agent request, the owner also contributes the resolved policy to
 * the cache-safe runtime-context snapshot. The agent loop logs that snapshot as
 * model history, so replay reconstructs the same mode and root the enforcing
 * consumers resolve without rewriting the stable system prompt.
 *
 * Enforcing filesystem, one-shot bash, and terminal backends read the SAME
 * resolved policy here. The context describes that policy without inventorying
 * capabilities, while each backend retains its own enforcement dialect and each
 * tool owns its operation-specific denial and escalation guidance. The service
 * reads session state once at each operation boundary; executors and providers
 * remain session-free.
 *
 * @module @deepseek-ai/dsh-sandbox-policy
 */

import { homedir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import { canonicalPath, type SandboxExecutionPolicy, type SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { effectiveSandboxMode } from './session-mode.ts'

export { SANDBOX_MODES, effectiveSandboxMode, setSandboxMode } from './session-mode.ts'

/** Resolve filesystem identity before lexical normalization can erase symlink-sensitive components. */
function resolveWorkspaceRoot(path: string): string {
  return resolvePath(canonicalPath(path))
}

/**
 * The D1 task-infrastructure allow-set: directories ordinary tooling writes
 * as a SIDE EFFECT of in-workspace work (package caches, installer stores,
 * tool data dirs). Without them Mode A forces a use-once/full-access prompt
 * (Phase 3) for `npm install`-class commands, so Mode A pre-allows them.
 * Every entry is a documented hole in Mode A; credentials/config locations
 * (`~/.ssh`, `~/.aws`, `~/.config`, ...) are deliberately NEVER included.
 * The table is the default of the `extraWritable` config field — a deployment
 * replaces it wholesale.
 */
function defaultExtraWritable(env: NodeJS.ProcessEnv, home: string): string[] {
  if (process.platform === 'win32') {
    const local = env.LOCALAPPDATA ?? join(home, 'AppData', 'Local')
    return [local, join(home, '.cargo')]
  }
  const entries = [
    env.XDG_CACHE_HOME ?? join(home, '.cache'),
    env.XDG_DATA_HOME ?? join(home, '.local', 'share'),
    join(home, '.npm'),
    join(home, '.cargo'),
  ]
  if (process.platform === 'darwin') entries.push(join(home, 'Library', 'Caches'))
  return entries
}

/** Render the policy without claiming which capabilities are mounted. */
function renderPolicyContext(policy: SandboxExecutionPolicy): string {
  switch (policy.mode) {
    case 'workspace-write':
      return `Current DSH file policy: workspace-write. File operations enforced by the DSH file sandbox may modify the session workspace ${JSON.stringify(policy.workspaceRoot)}, the platform temp areas, and the configured task-infrastructure roots without asking; anything outside them prompts the user (allow once, or full access for the session). Confined commands are kernel-confined to the same write set.`
    case 'danger-full-access':
      return 'Current DSH file policy: danger-full-access. The DSH file sandbox does not restrict file modifications by available operations.'
    /* v8 ignore next 4 -- SandboxMode is a typed same-process closed union; this branch is only the static exhaustiveness guard. */
    default: {
      const mode: never = policy.mode
      throw new Error(`unreachable sandbox mode: ${String(mode)}`)
    }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    sandboxPolicy: SandboxPolicyService
  }
}

/**
 * Plugin config: the deployment's sandbox default. All optional — `Config`
 * supplies the defaults (`mode: 'workspace-write'` — Mode A, the confinement
 * the two-mode design starts every session in). The runner choice is NOT here
 * (it is the `ctx.sandbox` provider's config), nor is any per-family knob:
 * this is the one shared policy home.
 */
export interface Config {
  /** File-sandbox mode a session starts from (default: `workspace-write`). */
  mode?: SandboxMode
  /**
   * Fallback root for agentless calls and sessions without a cwd (default:
   * `process.cwd()`). Normal agent calls use their session cwd instead.
   */
  workspaceRoot?: string
  /**
   * Extra writable roots in `workspace-write` beyond the workspace and the
   * platform temp areas (the D1 task-infrastructure allow-set: package
   * caches and tool data directories). Set to replace the built-in default
   * table wholesale; `~` expands to the home directory. Credentials and
   * shell-config locations must never be listed.
   */
  extraWritable?: string[]
}

/** Inputs that select the sandbox policy for one capability call. */
export interface SandboxPolicyRequest {
  /** Calling session; its immutable cwd becomes the workspace boundary. */
  session?: Session
  /** Explicit approved mode override, which outranks session policy. */
  mode?: SandboxMode
}

/**
 * The sandbox-policy service (`ctx.sandboxPolicy`). Owns the deployment
 * default mode, fallback workspace root, and current request-time policy
 * section. Tool layers call {@link resolve} for each execution so a session's
 * mode log and immutable cwd travel together to every enforcing capability.
 */
export class SandboxPolicyService extends Service {
  // Inline schema call: the config catalog walks `static Config` statically.
  static Config: z<Config> = z.object({
    mode: z.union(['workspace-write', 'danger-full-access'] as const).default('workspace-write'),
    // No schema default: process.cwd() is resolved in the constructor so the
    // stored root is always absolute regardless of how it was supplied.
    workspaceRoot: z.string(),
    extraWritable: z.array(z.string()).default(undefined as unknown as string[]),
  })

  /** The deployment default mode — the fallback beneath a session override. */
  readonly defaultMode: SandboxMode
  /** The absolute `workspace-write` fallback root for calls without a session cwd. */
  readonly workspaceRoot: string
  /** The resolved Mode A extra-writable allow-set (see {@link Config.extraWritable}). */
  readonly extraWritable: readonly string[]
  constructor(ctx: Context, config: Config) {
    super(ctx, 'sandboxPolicy')
    // schemastery (static Config) already filled `mode`; the cast records that
    // runtime fact. `workspaceRoot` has NO schema default, so its fallback to
    // the process cwd is real branching, resolved absolute either way.
    this.defaultMode = config.mode as SandboxMode
    this.workspaceRoot = resolveWorkspaceRoot(config.workspaceRoot ?? process.cwd())
    const home = homedir()
    const configured = config.extraWritable as string[] | undefined
    this.extraWritable = (configured ?? defaultExtraWritable(process.env, home))
      .map(root => resolveWorkspaceRoot(root.startsWith('~') ? join(home, root.slice(1)) : root))

    ctx.inject(['systemPrompt'], (scope: Context) => {
      scope.systemPrompt.context({
        name: 'sandbox:policy',
        order: 110,
        text: (context) => {
          const session = context.agent?.session
          return session === undefined
            ? ''
            : renderPolicyContext(this.resolve({ session }))
        },
      })
    })
  }

  /**
   * Resolve the complete policy for one capability call. An approved explicit
   * mode outranks the session's last `sandbox/mode` event, which outranks the
   * deployment default. A session cwd is its workspace-write boundary; the
   * configured root is the fallback for agentless calls and sessions without a
   * cwd.
   * @param request - optional session and approved mode override.
   * @returns the fully resolved per-call mode and absolute workspace root.
   */
  resolve(request: SandboxPolicyRequest = {}): SandboxExecutionPolicy {
    const { session } = request
    return {
      mode: request.mode ?? (session === undefined ? undefined : this.overrideOf(session)) ?? this.defaultMode,
      workspaceRoot: resolveWorkspaceRoot(session?.header.cwd ?? this.workspaceRoot),
      ...(this.extraWritable.length > 0 ? { extraWritable: this.extraWritable } : {}),
      ...session === undefined ? {} : { sessionId: session.id },
    }
  }

  /**
   * Read the session override without applying the deployment default.
   * @param session - session whose log supplies the override.
   * @returns the last logged mode, or `undefined` without one.
   */
  overrideOf(session: Session): SandboxMode | undefined {
    return effectiveSandboxMode(session.events)
  }
}

export default SandboxPolicyService
