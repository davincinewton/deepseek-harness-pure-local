/**
 * The sandbox gate shared by the `read`, `write`, and `edit` tools: the
 * per-call policy resolution, the PRE-EMPTIVE three-answer prompt for
 * outside-workspace accesses (Deny / Use once / Full access for the session),
 * and the denial-marker mapping. The prompt fires BEFORE anything touches
 * disk: the fence stays the enforcement, this gate is the human decision the
 * two-mode design routes every outside access through. Built ONCE per plugin
 * from `ctx.fs.sandboxMode` (the capability fact — is a confining backend
 * mounted?).
 *
 * @module @deepseek-ai/dsh-tool-fs/sandbox
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import { isWithinWritable, sandboxDenialMarker } from '@deepseek-ai/dsh-sandbox'
import { setSandboxMode, type SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import { FsError } from '@deepseek-ai/dsh-fs'

/** What the human answered on an outside-workspace prompt. */
type GateAnswer = 'allow-once' | 'allow-full-access'

/**
 * The filesystem sandbox gate: per-call policy resolution, the pre-emptive
 * outside-workspace prompt for mutations and reads, and denial-marker
 * mapping. A pure product of `ctx` at plugin apply time.
 */
export class FsSandboxController {
  /** Whether this composition mounts a confining backend (capability fact). */
  readonly confining: boolean
  /** Shared per-session policy resolver, required by a confining backend. */
  private readonly policy: SandboxPolicyService | undefined

  constructor(private readonly ctx: Context) {
    const defaultMode = ctx.fs.sandboxMode
    this.confining = defaultMode !== undefined
    this.policy = defaultMode === undefined ? undefined : ctx.get('sandboxPolicy')
    if (defaultMode !== undefined && this.policy === undefined) {
      throw new Error('tool-fs: the mounted filesystem confines but ctx.sandboxPolicy is missing')
    }
  }

  /**
   * The session's standing policy (session override > deployment default,
   * session cwd root), or undefined for an unconfined backend.
   * @param exec - the tool-execution context whose agent supplies the session.
   * @returns the resolved policy, or undefined when nothing confines.
   */
  standingPolicy(exec: ToolExecution): SandboxExecutionPolicy | undefined {
    return this.policy?.resolve({ ...exec.agent ? { session: exec.agent.session } : {} })
  }

  /**
   * Gate a mutation BEFORE it executes. A contained path passes the standing
   * policy through; an outside path asks the human: 'Use once' stamps full
   * access onto THIS call, 'Full access (session)' records the durable
   * session switch (and also runs this call), and Deny / an unavailable
   * channel throws the model-facing refusal.
   * @param toolName - the mutating tool's name, for the approval audit trail.
   * @param verb - the human-readable action in the prompt reason (`modify`).
   * @param path - the backend-resolved canonical target path.
   * @param policy - the standing policy, or undefined for an unconfined backend.
   * @param exec - the tool-execution context.
   * @returns the policy to stamp onto this mutation.
   */
  async gateMutation(
    toolName: string,
    verb: string,
    path: string,
    policy: SandboxExecutionPolicy | undefined,
    exec: ToolExecution,
  ): Promise<SandboxExecutionPolicy | undefined> {
    if (policy === undefined || (await isWithinWritable(policy, path))) return policy
    const answer: GateAnswer = await this.ask(toolName, verb, path, exec)
    // Both allow answers run THIS call unconfined; the full-access answer
    // additionally recorded the durable session switch inside ask().
    void answer
    return { ...policy, mode: 'danger-full-access' }
  }

  /**
   * Gate a READ before it resolves content. Mode A prompts for reads outside
   * the workspace + allow-set; any allow answer continues the read, Deny or
   * an unavailable channel throws the model-facing refusal.
   * @param toolName - the reading tool's name, for the approval audit trail.
   * @param path - the backend-resolved canonical target path.
   * @param exec - the tool-execution context.
   */
  async gateRead(toolName: string, path: string, exec: ToolExecution): Promise<void> {
    const policy = this.standingPolicy(exec)
    if (policy === undefined || (await isWithinWritable(policy, path))) return
    await this.ask(toolName, 'read', path, exec)
  }

  /** Ask the human about one outside-workspace access; resolve the answer or throw. */
  private async ask(toolName: string, verb: string, path: string, exec: ToolExecution): Promise<GateAnswer> {
    const approval = this.ctx.get('approval')
    if (approval === undefined || exec.agent === undefined) {
      throw new FsError(fsRefusal(verb, path, 'no approval prompt is available'), 'FS_SANDBOX_DENIED')
    }
    const session = exec.agent.session
    const outcome: ApprovalOutcome = await approval.request({
      agent: exec.agent,
      toolName,
      callId: exec.callId,
      reason: `${verb} a file outside the workspace and permitted roots: ${path}`,
      ...exec.signal === undefined ? {} : { signal: exec.signal },
      allowFullAccess: true,
    })
    if (outcome === 'allowed-once') return 'allow-once'
    if (outcome === 'allowed-full-access') {
      setSandboxMode(session, 'danger-full-access')
      return 'allow-full-access'
    }
    // A cancelled ask is a human withdrawal, like a rejection; only a
    // missing/failed channel reads as "no prompt happened".
    throw new FsError(fsRefusal(verb, path,
      outcome === 'unavailable'
        ? 'approval prompts are not available in this session'
        : 'the prompt was refused (rejected or cancelled by the user, or rejected automatically because approval is disabled in this session)'),
    'FS_SANDBOX_DENIED')
  }

  /**
   * Map a thrown provider error for the model: a `FS_SANDBOX_DENIED` (the
   * fence's own refusal — reachable on a race the pre-gate did not see)
   * becomes an `FsError` carrying the shared `[sandbox: …]` denial marker so
   * it reads identically to bash's, WHILE keeping the structured
   * `FS_SANDBOX_DENIED` code — `ToolRuntime` populates `result.error` only
   * for `HarnessError` instances. Any other error passes through unchanged.
   * @param error - the error thrown by the mutation.
   * @param policy - the policy stamped onto the call (names the mode in the marker).
   * @returns the error to throw — the marker `FsError` for a sandbox denial, else the original.
   */
  mapError(error: unknown, policy: SandboxExecutionPolicy | undefined): unknown {
    if (!(error instanceof FsError) || error.code !== 'FS_SANDBOX_DENIED') return error
    // A FS_SANDBOX_DENIED only arises under a confining backend, whose tool
    // path always resolves a policy before mutation.
    const mode = (policy as SandboxExecutionPolicy).mode
    return new FsError(sandboxDenialMarker(mode), 'FS_SANDBOX_DENIED', { cause: error })
  }
}

/** The model-facing refusal for a refused outside-workspace access. */
function fsRefusal(verb: string, path: string, why: string): string {
  return `cannot ${verb} "${path}": it is outside the workspace and permitted roots, and ${why}. Stop and explain; do not attempt the path another way.`
}
