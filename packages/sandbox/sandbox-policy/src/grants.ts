/**
 * Sticky session grants: the durable record of a human's "allow for session"
 * decision. A grant authorizes, under one sandbox mode, the calls the rules
 * would otherwise ask about — and, for filesystem targets, one root path and
 * everything below it. It lasts for the rest of THIS session; it is never
 * inherited by a subagent and never a deployment setting.
 *
 * The session log is the store (the `sandbox/mode` precedent): the grant event
 * is log-only, durable, replayable, and never model-visible. A later
 * `sandbox/mode` switch drops every grant recorded before it, so tightening
 * the session revokes what was granted under a wider posture
 * ({@link effectiveGrants}). Enforcing tools fold the grants on every call;
 * the policy service itself never consults them.
 *
 * @module dsh-sandbox-policy/grants
 */

import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * A human authorized unconfined use of one sandbox mode for the rest of
     * the session — log-only (like `approval/*`; NOT a surface event, carries
     * no `surfaceOp`): durable and replayable, never in the model transcript.
     * An absent `root` covers bash calls (which carry no path); a `root`
     * covers filesystem targets at or below that path. Bash and filesystem
     * grants never cover each other. The NEXT `sandbox/mode` switch drops
     * every earlier grant ({@link effectiveGrants}).
     */
    'sandbox/grant': {
      /** The mode the grant was made under (the session's mode at grant time). */
      mode: SandboxMode
      /** Root path a filesystem grant covers (the gate's match key); absent for bash. */
      root?: string
    }
  }
}

/**
 * One effective grant: a mode the human allowed for the session, plus the
 * filesystem root it covers (`undefined` for bash).
 */
export interface SandboxGrant {
  /** The granted mode. */
  mode: SandboxMode
  /** Root path the grant covers (the gate's match key); absent when it covers bash. */
  root?: string
}

/**
 * The session's effective grants: `sandbox/grant` events in log order, reset by
 * each later `sandbox/mode` switch. The pure fold — resume reconstructs grants
 * by replaying the log, with no catch-up state.
 * @param events - session events in log order (other event types are skipped).
 * @returns the grants still in effect, in grant order.
 */
export function effectiveGrants(events: readonly SessionEvent[]): readonly SandboxGrant[] {
  const grants: SandboxGrant[] = []
  for (const event of events) {
    if (event.type === 'sandbox/mode') {
      grants.length = 0
      continue
    }
    if (event.type !== 'sandbox/grant') continue
    grants.push({
      mode: event.data.mode,
      ...event.data.root !== undefined ? { root: event.data.root } : {},
    })
  }
  return grants
}

/**
 * THE write path for one session grant: appends exactly one `sandbox/grant`
 * event. Takes effect on the next call that folds grants (the consumers fold
 * on every read).
 * @param session - the session the grant belongs to.
 * @param grant - the mode and optional filesystem root the human allowed.
 */
export function grantSandbox(session: Session, grant: SandboxGrant): void {
  session.append('sandbox/grant', {
    mode: grant.mode,
    ...grant.root !== undefined ? { root: grant.root } : {},
  })
}

/**
 * Whether an effective grant covers one call: the grant's mode must match the
 * call's mode, and its scope must match the call's path. A rootless grant
 * covers only bash (a call without a path); a root grant covers only a
 * filesystem path equal to or below that root. The two families are
 * deliberately disjoint — allowing bash does not allow file mutations.
 * @param grants - the session's effective grants ({@link effectiveGrants}).
 * @param mode - the mode the call runs under.
 * @param path - the call's canonical target path, absent for bash.
 * @returns true when a grant covers the call.
 */
export function grantCovers(grants: readonly SandboxGrant[], mode: SandboxMode, path?: string): boolean {
  return grants.some((grant) => {
    if (grant.mode !== mode) return false
    if (grant.root === undefined) return path === undefined
    if (path === undefined) return false
    return path === grant.root || path.startsWith(`${grant.root}/`)
  })
}
