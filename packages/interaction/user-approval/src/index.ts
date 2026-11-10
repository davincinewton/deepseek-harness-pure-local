/**
 * Service Definition for the approval capability seam, covering requests, cancellation, audit, and per-session policy. Missing
 * answerers fail closed; grants apply only to the requested action.
 * @module @deepseek-ai/dsh-user-approval
 */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { assertNever, createUserMessage, type CallId } from '@deepseek-ai/dsh-llm'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import type { Scoped } from '@deepseek-ai/dsh-scope'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-system-prompt'

declare module '@deepseek-ai/cordis' {
  interface Context {
    approval: ApprovalService
  }

  interface Events {
    /**
     * Ask composed answerers for one decision. Return an outcome to claim the
     * request or call `next()`; failure yields the fail-closed default.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @param req - the pending decision (agent, tool identity, reason, signal).
     * @mode waterfall
     */
    'approval/request'(this: Scoped<ApprovalService>, req: ApprovalRequest, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome>
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * An approval question was put to the answerer chain — log-only audit
     * (like `hook/*`; NOT a surface event, carries no `surfaceOp`). `id` pairs
     * it with the `approval/decided` that always follows; `toolName` is the
     * tool the question is about, `callId` the exact tool call when the asker
     * had one, `reason` the asker's human-readable explanation (e.g. a hook's
     * permission-decision reason).
     */
    'approval/asked': {
      id: ApprovalRequestId
      toolName: string
      callId?: CallId
      reason?: string
    }
    /**
     * The outcome of a prior `approval/asked` (same `id`) — log-only audit.
     * Exactly one per ask, appended when the outcome is known: a decision, a
     * cancellation, or the fail-closed `'unavailable'`.
     */
    'approval/decided': {
      id: ApprovalRequestId
      outcome: ApprovalOutcome
    }
    /**
     * The session's approval policy was switched — log-only, durable,
     * replayable, never in the model transcript (the model learns the policy
     * from the runtime-context snapshot and live switch notices). The LAST
     * such event is the session's override ({@link effectiveApprovalPolicy}).
     * `source: 'delegation'` marks an override seeded into a child; an absent
     * source is a runtime switch.
     */
    'approval/policy': {
      policy: ApprovalPolicy
      /** Marks an override seeded into a child at delegation. */
      source?: 'delegation'
    }
  }
}

import { ApprovalRequestId } from './types.ts'
import type { ApprovalOutcome } from './types.ts'

export { ApprovalRequestId } from './types.ts'
export type { ApprovalOutcome } from './types.ts'

/** Every {@link ApprovalOutcome}, for runtime normalization of answerer returns. */
const OUTCOMES: readonly ApprovalOutcome[] = ['allowed-once', 'allowed-for-session', 'rejected', 'cancelled', 'unavailable']

/**
 * A session's approval policy — what happens to an {@link ApprovalService}
 * ask BEFORE any interactive answerer sees it:
 *
 * - `'ask'` (the default) — delegate to the composed answerers; with none
 *   composed the chain falls through to the fail-closed `'unavailable'`.
 * - `'never'` — never prompt anyone: every ask resolves `'rejected'`
 *   deterministically. The strict headless stance (CI, unattended runs) and
 *   the policy whose outcome is knowable without asking.
 * - `'auto'` — the rule-gated stance: asks never reach a human. The owning
 *   tools already resolved everything the rules allow (read-only and
 *   allow-listed calls run free), so a surviving ask is outside the heuristic
 *   and resolves `'rejected'` deterministically. A deployment can forbid the
 *   policy with {@link Config.disableAutoMode}.
 */
export type ApprovalPolicy = 'ask' | 'never' | 'auto'

/** Every {@link ApprovalPolicy}, for option advertisement and runtime validation of untrusted policy strings. */
export const APPROVAL_POLICIES: readonly ApprovalPolicy[] = ['ask', 'never', 'auto']

/** Model-facing statement for the deterministic `'never'` policy. */
const NEVER_SENTENCE = 'Approval prompts are disabled in this session: actions that require approval are rejected automatically — do not request sandbox escalation (do not set `sandbox_permissions`).'
/** Model-facing statement for the rule-gated `'auto'` policy. */
const AUTO_SENTENCE = 'Approval policy: auto. Actions that require approval are decided by the permission rules without prompting: read-only and allow-listed operations proceed, everything else is rejected. Do not attempt to escalate — no prompt will happen.'
/** Model-facing statement for a disabled `'auto'` policy: the same automatic refusal, stated as a deployment restriction. */
const AUTO_DISABLED_SENTENCE = 'Approval policy: auto is disabled in this deployment; every action that requires approval is rejected automatically — do not request sandbox escalation (do not set `sandbox_permissions`).'
/** Model-facing statement for an interactive policy that may still fail closed. */
const ASK_SENTENCE = 'Approval policy: ask. Operations that require approval may ask through the configured answerers; without an available answerer, the request fails closed.'

/**
 * The session's approval-policy override: the last `approval/policy` event in
 * the log, or undefined when the session never switched (callers apply the
 * plugin's configured default). The pure fold — resume needs no catch-up
 * machinery because replaying the log IS the state.
 * @param events - session events in log order (other event types are skipped).
 * @returns the policy of the last switch event, or undefined without one.
 */
export function effectiveApprovalPolicy(events: readonly SessionEvent[]): ApprovalPolicy | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as SessionEvent
    if (event.type === 'approval/policy') return event.data.policy
  }
  return undefined
}

/**
 * Whether the log currently sits inside an open turn (a `turn/start` not yet
 * closed by a `turn/end`) — the {@link ApprovalService.request} precondition.
 * The audit pair must be turn-enclosed: the turn is the durable log's
 * commit/replay boundary, so a bare event appended between turns is
 * indistinguishable from a crash tail and silently dropped on reload.
 */
function hasOpenTurn(events: readonly SessionEvent[]): boolean {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const type = (events[index] as SessionEvent).type
    if (type === 'turn/start') return true
    if (type === 'turn/end') return false
  }
  return false
}

/**
 * Append the sole durable representation of a session policy override. Invalid
 * values throw before the log changes; consumers fold the new value on each read.
 * @param session - the session the override belongs to.
 * @param policy - the policy in effect until the next switch.
 */
export function setApprovalPolicy(session: Session, policy: ApprovalPolicy): void {
  if (!APPROVAL_POLICIES.includes(policy)) {
    throw new TypeError('approval policy must be one of "ask", "never" or "auto"')
  }
  session.append('approval/policy', { policy })
}

/**
 * Readonly same-process permission question. `callId` links to an already
 * presented tool call, so arguments are not duplicated here.
 */
export interface ApprovalRequest {
  /**
   * The agent on whose behalf the question is asked. Routes the question (a
   * UI answerer only answers for agents it owns) and receives the audit
   * events on its session log.
   */
  readonly agent: Agent
  /** The tool the question is about (presentation and audit). */
  readonly toolName: string
  /**
   * The exact tool call being decided, when the asker has one — lets a UI
   * attach the prompt to the tool call it already streamed.
   */
  readonly callId?: CallId
  /** The asker's human-readable explanation of WHY it is asking. */
  readonly reason?: string
  /**
   * Aborting withdraws the question: the request settles `'cancelled'`
   * immediately and a late answer from a still-pending answerer is discarded.
   */
  readonly signal?: AbortSignal
  /**
   * The asker can honor a session-scoped grant for this decision: an answerer
   * may answer `'allowed-for-session'` instead of `'allowed-once'`, and the
   * asker records the grant. Unadvertised asks normalize that outcome to
   * `'unavailable'` (a grant with no owner is a fail-closed answer).
   */
  readonly allowSession?: boolean
}

/** Plugin config. All optional — `static Config` supplies the defaults. */
export interface Config {
  /**
   * The deployment's default {@link ApprovalPolicy} for sessions without an
   * `approval/policy` override — `'ask'` delegates to the composed answerers
   * (fail-closed with none); `'never'` auto-rejects every ask without
   * prompting (the deterministic CI/unattended stance); `'auto'` resolves
   * every ask without prompting through the rule-gated stance.
   */
  readonly policy?: ApprovalPolicy
  /**
   * Forbid the `'auto'` policy for this deployment: selecting it on a live
   * session throws, the policy context states it is disabled, and any ask a
   * session already carrying `auto` resolves `'rejected'`. A managed
   * deployment sets this to keep unattended rule-gated execution opt-in.
   */
  readonly disableAutoMode?: boolean
}

/**
 * Approval service that applies session policy before answerers and logs every
 * ask/outcome pair to the requesting session. It exposes deterministic policy
 * changes to the model through the runtime-context snapshot and switch notices.
 */
export class ApprovalService extends Service {
  static Config: z<Config> = z.object({
    policy: z.union(APPROVAL_POLICIES as ApprovalPolicy[]).default('ask'),
    disableAutoMode: z.boolean().default(false),
  })

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'approval')
    if (this.config.disableAutoMode && this.config.policy === 'auto') {
      throw new Error('user-approval: the configured default policy is "auto" while disableAutoMode forbids it')
    }

    const effective = (agent: Agent): ApprovalPolicy => this.policyOf(agent.session)

    // The complete current value travels after retained history, so switching
    // policy does not rewrite the stable system-prompt cache prefix.
    ctx.inject(['systemPrompt'], (scope: Context) => {
      scope.systemPrompt.context({
        name: 'approval:policy',
        order: 115,
        text: (context) => {
          const agent = context.agent
          // A bare assemble() (tests, diagnostics) has no session to state.
          if (agent === undefined) return ''
          const policy = effective(agent)
          switch (policy) {
            case 'never': return NEVER_SENTENCE
            case 'auto': return this.config.disableAutoMode ? AUTO_DISABLED_SENTENCE : AUTO_SENTENCE
            case 'ask': return ASK_SENTENCE
            default: return assertNever(policy, 'ApprovalPolicy')
          }
        },
      })
    })
  }

  /**
   * Whether this deployment forbids the `'auto'` policy.
   * @returns true when `disableAutoMode` is configured.
   */
  get autoModeDisabled(): boolean {
    return this.config.disableAutoMode === true
  }

  /**
   * Switch one live agent's policy and queue the transition for its next model
   * step. Session initialization uses {@link setApprovalPolicy} directly
   * because there is no previously visible policy to change.
   * @param agent - the live agent whose policy is changing.
   * @param policy - the new effective policy.
   * @throws when the policy is `'auto'` and this deployment forbids it.
   */
  setPolicy(agent: Agent, policy: ApprovalPolicy): void {
    if (policy === 'auto' && this.config.disableAutoMode) {
      throw new Error('user-approval: "auto" is disabled in this deployment (disableAutoMode)')
    }
    const previous = this.policyOf(agent.session)
    if (previous === policy) return
    setApprovalPolicy(agent.session, policy)
    agent.inject(createUserMessage({
      content: [{
        type: 'text',
        text: `The approval policy changed from "${previous}" to "${policy}" (changed by the user).`,
      }],
      source: { kind: 'plugin', plugin: 'user-approval' },
    }))
  }

  /**
   * Ask the composed answerers to decide one readonly same-process request.
   * The service borrows the request, agent, session, and live signal directly.
   * The request requires an open turn because the audit pair must be enclosed
   * by the durable log's commit/replay boundary; an idle ask rejects before
   * appending anything. The answerer phase always produces an outcome: an
   * aborted signal yields `'cancelled'`, a missing or throwing answerer yields
   * `'unavailable'` (fail closed), and a rogue non-vocabulary return value is
   * normalized to `'unavailable'`. A failure that prevents either audit append
   * from committing still rejects because returning an unlogged decision would
   * violate the pair. Session contains post-commit observer failures, so an
   * authoritative append cannot reject the request or suppress its matching
   * audit event.
   * @param req - the pending decision (agent, tool identity, reason, signal).
   * @returns the closed outcome; `'allowed-once'` is a one-shot grant and
   *   `'allowed-for-session'` a grant the asker records (only when it
   *   advertised {@link ApprovalRequest.allowSession}).
   * @throws when no turn is open or either audit event fails before the session
   *   append commit point.
   */
  async request(req: ApprovalRequest): Promise<ApprovalOutcome> {
    const session = req.agent.session
    if (!hasOpenTurn(session.events)) {
      throw new Error(
        'approval.request() outside an open turn: the approval/asked + approval/decided audit pair '
        + 'must be turn-enclosed (a bare event between turns is crash-tail garbage on reload). '
        + 'Ask from inside the turn that needs the decision.',
      )
    }
    const id = ApprovalRequestId(randomUUID())
    session.append('approval/asked', {
      id,
      toolName: req.toolName,
      ...req.callId !== undefined ? { callId: req.callId } : {},
      ...req.reason !== undefined ? { reason: req.reason } : {},
    })
    const outcome = await this.decide(req, session)
    session.append('approval/decided', { id, outcome })
    return outcome
  }

  /**
   * The session's effective policy: its own `approval/policy` fold, else the
   * configured default (the schema already defaulted an omitted policy to
   * `'ask'`; the `??` only narrows the optional-input TYPE).
   * @param session - the exact accepted session whose policy applies.
   * @returns the policy every ask for this session resolves under right now.
   */
  policyOf(session: Session): ApprovalPolicy {
    return this.overrideOf(session) ?? this.config.policy ?? 'ask'
  }

  /**
   * Read the session override without applying the configured default.
   * @param session - session whose log supplies the override.
   * @returns the last logged policy, or `undefined` without one.
   */
  overrideOf(session: Session): ApprovalPolicy | undefined {
    return effectiveApprovalPolicy(session.events)
  }

  /**
   * Dispatch the waterfall, contained and raced against the request signal.
   * @param req - the borrowed public request.
   * @param session - the request agent's session used for policy lookup.
   * @returns the normalized closed outcome.
   */
  private async decide(req: ApprovalRequest, session: Session): Promise<ApprovalOutcome> {
    const signal = req.signal
    if (signal?.aborted) return 'cancelled'
    // The deterministic policies are decided HERE, before any dispatch: a
    // listener registered with `prepend: true` after this service mounts would
    // sit ahead of any gate LISTENER, so a listener-shaped gate cannot keep
    // the documented promise that 'never' (and a forbidden 'auto') rejects
    // regardless of registration order — only the service's own request path
    // can. 'auto' is deterministic for the same reason: the owning tools have
    // already resolved everything the rules allow, so a surviving ask is
    // outside the heuristic and fails closed without a prompt.
    const policy = this.policyOf(session)
    switch (policy) {
      case 'never': return 'rejected'
      case 'auto': return 'rejected'
      case 'ask': break
      default: return assertNever(policy, 'ApprovalPolicy')
    }
    // Enter the promise chain BEFORE dispatching: a listener that throws
    // SYNCHRONOUSLY (before its first await) must land in the same rejection
    // path as an async one — `Promise.resolve(call())` would let it escape
    // the containment into the caller.
    const answer: Promise<ApprovalOutcome> = Promise.resolve().then(
      () => this.ctx.waterfall(
        scopeTarget(this, req.agent), 'approval/request', req,
        () => Promise.resolve<ApprovalOutcome>('unavailable'),
      ),
    ).then(
      // Normalize a rogue (non-vocabulary) answerer return to the fail-closed
      // outcome instead of leaking it into callers' closed-union switches. A
      // session grant with no owner on the ask is the same fail-closed case:
      // the asker advertised nothing to record.
      outcome => OUTCOMES.includes(outcome) ? outcome : 'unavailable',
      // A throwing answerer must fail the QUESTION closed, not the caller's
      // tool call open — the seam contains its callbacks.
      (): ApprovalOutcome => 'unavailable',
    ).then(
      outcome => outcome === 'allowed-for-session' && req.allowSession !== true ? 'unavailable' : outcome,
    )
    if (signal === undefined) return answer
    return await new Promise<ApprovalOutcome>((resolve) => {
      const onAbort = () => {
        signal.removeEventListener('abort', onAbort)
        resolve('cancelled')
      }
      signal.addEventListener('abort', onAbort, { once: true })
      void answer.then((outcome) => {
        signal.removeEventListener('abort', onAbort)
        // After an abort won the race this resolve is a settled-promise no-op:
        // the late answer is discarded by construction.
        resolve(outcome)
      })
    })
  }
}

export default ApprovalService
