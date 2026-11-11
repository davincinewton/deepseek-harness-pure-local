# Two-Mode Auth: Native Backends, Fence-First Prompts

**Status:** approved design; implementation plan only — no code landed by this doc.
**Supersedes:** `dsh-auth-redesign-plan.md` (rule-engine era; kept as the historical record, not edited).
**Platform stance:** Linux + macOS + Windows are first-class; the Linux-only-fork premise is reversed.

---

## 1. Design (agreed)

**Backends.** Kernel enforcement stays, but only OS-native mechanisms: Linux = Landlock
(`@deepseek-ai/node-addon-landlock-run`, an in-repo artifact calling an in-tree kernel LSM),
macOS = Seatbelt (`sandbox-exec`, ships with the OS), Windows = restricted token
(`dsh-sandbox-windows-acl`). `bwrap`/bubblewrap is deleted — it is the only backend requiring an
external package, and its user-namespace probe is the failure that drove every workaround.
Each platform chain collapses to a sole candidate; no cross-rung probe arbitration remains
(the Landlock ABI probe stays — it distinguishes `full` vs `partial` enforcement).

**Modes.** The sandbox vocabulary becomes exactly two modes:

| Mode | Identity (kept) | Enforcement | Reach |
|---|---|---|---|
| **A — workspace** | `workspace-write` | confine under the native backend | RW inside the workspace + a documented extra-writable allow-set (D1); model-addressed file effects outside it are prompted (§3) |
| **B — full access** | `danger-full-access` | no runner | the user account's reach; never any privilege elevation |

`read-only` mode is deleted. `SandboxEnforcement` stays `'full' | 'partial'` (`'none'` is deleted
with the fallback lane). Escalation targets collapse to one: from A, the only strict widening is to B.

**Prompts.** The rule engine, read-only command set, `auto` policy, `disableAutoMode`, sticky
session grants, the no-backend fallback lane, and the `allowSession` grant plumbing are deleted.
The only ask in the system is **outside-workspace file access while in Mode A**, answered with
exactly three options:

1. **Deny** — the call fails; the model stops or explains. Nothing changes.
2. **Use once** — exactly this call runs unconfined (today's `allowed-once` escalation shape).
3. **Full access (session)** — the session durably switches to Mode B: one `sandbox/mode` event,
   replayable, visible in the runtime context and the GUI preset row, gated by the full-access
   confirmation dialog. Every later op runs free.

**Prompt sites.**

- **fs tools (`read`/`write`/`edit`):** the fence resolves the target path before touching disk, so
  the three-option prompt fires **pre-emptively** in the tool layer when Mode A is active and the
  resolved path is outside the workspace + allow-set. This covers reads too: a model-addressed read
  outside the workspace prompts even though the kernel profile keeps broad reads (subprocesses must
  read `/usr`, libc, certificates). Read-gating is therefore a tool-surface rule, not a kernel rule;
  the asymmetry is deliberate and is stated in the runtime context.
- **bash / pwsh:** **reactive only.** The confined run hits the kernel denial, the tool emits the
  existing `[sandbox: …denied…]` marker plus escalation hint, and the model's sanctioned
  `sandbox_permissions` + `justification` retry raises the three-option prompt. No command-text
  scanning, anywhere — the kernel is the detector, the retry is the request.

**Approval policy.** Stays `'ask' | 'never'` only. Under `never` (CI/headless) no prompt can appear,
so every Mode A boundary hit resolves **Deny** — unattended runs get Mode A + allow-set, or are
launched in B by the operator. No `auto` variant, no third sentence in the runtime context.

**Lifecycle.** A subagent does not inherit the parent's Mode B: children are seeded at most Mode A
even when the parent is full access (the current `captureDelegatedPolicyOverrides` copy must clamp).
Children also stop being pinned to `approval: 'never'`: they inherit the parent's policy so their
own boundary hits can prompt (requirement: child asks must route to the root GUI — verify/extend the
apiproxy event routing and answerer scoping). Reverting B → A is user-only (GUI preset switch);
the model can never change modes beyond the one-call answer, and cannot narrow at all. A later
manual re-widening is a fresh prompt; the existing `sandbox/mode` fold already gives the
"switch resets state" semantics.

**Presets.** Shipped table: `workspace-write` (Mode A, `ask`, default) and `danger-full-access`
(B, `never`, confirmation). `read-only` and `auto` rows are deleted. The full-access confirmation
gate stops keying on the preset **name** (`FULL_ACCESS_PRESET`) and keys on the option's **sandbox
mode** value — fixing the known defect where any second full-access preset slips past the dialog;
the third GUI answer button uses the same mode-keyed confirmation.

---

## 2. Decisions already made

- D-1: bwrap deleted; landlock/seatbelt/windows-acl kept.
- D-2: exec in Mode A is kernel-confined for file effects; no text heuristics; no accepted hole.
- D-3: reads outside the workspace (model-addressed, fs tools) are blocked in A, promptable.
- D-4: the three answers are Deny / Use once / Full access (session); nothing else prompts.
- D-5: bash prompting is reactive-only (kernel denial → escalation retry).
- D-6: full access is not inherited by subagents; children prompt.
- D-7: revert to A is GUI-only; the model has no mode-changing power.
- D-8: everything the rule-engine commits added (rules, read-only set, grants, `auto`,
  `allowSession`, fallback, `enforcement: 'none'`) is deleted, not kept as opt-in.

## 3. Open decisions — RESOLVED (D1, D2)

- **D1 — RESOLVED: task-infrastructure use outside the workspace is pre-allowed.** The principle:
  normal tool operation must run smoothly with zero prompts, so the Mode A profile allow-set
  (an explicit `Config` field, not a hardcoded table) defaults to the infrastructure paths programs
  touch as side effects — platform temp dirs (`$TMPDIR`/`/tmp`, `%TEMP%`, `os.tmpdir()`), DSH-managed
  data dirs (browser profile/data, job spill dirs), and package/tool caches and stores
  (`~/.cache` + XDG dirs, `~/.npm`, the pnpm store, pip/cargo/go caches; macOS `~/Library/Caches`;
  Windows `%LOCALAPPDATA%` cache paths). Deliberate file effects on user data outside the workspace
  (documents, project dirs elsewhere, `~/.ssh`, `~/.aws`, `~/.gnupg`, and every credentials/config
  location) are NOT in the allow-set and still raise the three-option prompt. The exact per-OS table
  is pinned in the Phase-2 profile work; every entry is a documented hole, and additions must name
  the concrete tool that needs them.
- **D2 — RESOLVED: fail-closed on hosts with no usable native backend** (kernel < 5.13, LSM list
  without landlock, broken token runner). Confined exec refuses to run; the message points the
  **user** to the GUI full-access switch and never instructs the model. No silent degradation, no
  auto-flip. Every OS this design targets ships a working rung, so this path exists only for
  old-kernel or stripped hosts.
- **Standing risks, accepted not solved:** Apple marks `sandbox-exec` deprecated (no replacement
  exists; industry-wide practice); Landlock enforcement is `partial` on pre-referral ABIs;
  `windows-acl` is `partial` by construction (Everyone ACE and hard-link boundaries), and
  Mode A read-restriction on Windows is the weakest rung (the tool-surface read gate D-3 is what
  actually delivers read policy on Windows).

---

## 4. Phases

> Status (this checkout): ALL FIVE PHASES LANDED. Phase 1 rule-lane revert
> (`8007f74761`). Phase 2 two-mode vocabulary, bwrap deleted, native-only
> backends, D2 fail-closed message (`8aec9b05fd`), D1 extra-writable
> allow-set (`60c19c516d`); the Landlock launcher builds and passes real
> confinement e2e on a Linux dev host (musl-gcc unavailable — host-cc dev
> build; CI owns the release matrix). Phase 3 three-answer prompt
> (`c30e64fdbf`): pre-emptive fs gate (write/edit/read), `allowed-full-access`
> through approval → apiproxy → GUI, confirmations keyed on sandbox mode.
> Phase 4 delegation clamp + child-ask root routing (`5802be0186`).
> Phase 5: TS SDK fixtures refreshed green (`examples/jsonrpc-agent`);
> Python single-exe fixtures refreshed green locally (exe built with
> `build-exe-for-python-sdk`, smokes pass for sdk-minimal/sdk-snapshot/
> direct). Deferred to the with-key PR window: the web e2e goldens for the
> three-button panel and any additional with-key recordings; the keyless
> prompt path is pinned by the ACP `fs-gate-rejected` scenario, the
> headless inheritance child fail-closed, and package suites for once /
> full-access / contained paths (a keyless Use-once/Full-access example-leaf
> scenario needs a cross-platform outside-workspace writable target that is
> also scenario-cleanable — unsolved, deliberate gap).
> Known pre-existing failures (not from this work): zh_CN bash-denial
> signature test, shiki lazy-load GUI flake, three browser-provisioning
> snapshot failures from the worktree's in-progress browser packages.

**Phase 1 — delete the rule-engine lane (revert to the pre-`14bc4330d0` shape).**

- `packages/sandbox/sandbox/`: delete `src/rules.ts`, `src/read-only.ts`, their tests, and the
  index re-exports (`parseRules`, `decide`, `decideRaw`, `matchBashRule`, `matchFsRule`,
  `isReadOnlyBashCommand`, …).
- `packages/sandbox/sandbox-policy/`: delete `src/grants.ts`, its tests, the `sandbox/grant`
  declaration; drop `sandbox/grant` from `packages/core/session/src/known-event-types.ts`.
  (Logs that contain it must still replay: keep the type in the known list with an "obsolete,
  ignored on fold" note, or accept that no log with it escapes this fork — decide at commit time;
  `SESSION_FORMAT_VERSION` stays 0.)
- `packages/interaction/user-approval/`: `ApprovalPolicy` back to `'ask' | 'never'`; delete
  `disableAutoMode`, AUTO sentences, the auto case in `decide()`; runtime-context vocabulary tests
  updated.
- `packages/shell/tool-bash/`: delete `rules` Config, the `decide()` call, the no-backend fallback
  branch, `fallbackOriginalMode`, and `enforcement: 'none'` reporting (foreground + background);
  keep the deny-rule-free escalation path exactly as-is. Delete `SandboxEnforcement`'s `'none'`
  member and `ShellExecutor.backendAvailable()` / `SandboxProvider.backendAvailable()` (or fold to
  internal chain-selection use).
- `packages/fs/tool-fs/`: delete the `rules` Config and `FsSandboxController.gate()` overlay.
- `packages/bundle/base/cordis.patch.yml`: delete the `auto` preset row.
- `packages/host/apiproxy/` + `packages/client/ui-conversation/`: delete the `allowSession` frame
  field, `allowed-for-session` answer handling, and the third button (restored in Phase 3 with the
  new vocabulary).
- Tests: delete `rules.spec.ts` (sandbox + tool-fs + tool-bash no-backend suites),
  `read-only.spec.ts`, `grants.spec.ts`, approval auto suites; per-file coverage recomputed.

**Phase 2 — backend consolidation to native-only.**

- `packages/sandbox/sandbox-local/`: delete the bwrap runner, its probe, its mount-profile builder
  (`profiles.ts`), `PLATFORM_CHAINS.linux = ['landlock']`; update chain/probe docs and the README
  model-experience notes; delete `tests/bwrap.e2e.ts` and bwrap cases in `local.spec.ts`,
  `packed-install.e2e.ts`, `multi-project-sandbox.e2e.ts`.
- `packages/sandbox/sandbox/`: mode vocabulary to two members (delete `'read-only'`): update
  `WIDER_MODES` (`workspace-write → ['danger-full-access']`), `ESCALATION_TARGETS`, profile
  builders, roots, denial-marker texts, and the bash/fs tool descriptions that enumerate modes.
- Preset table: drop the `read-only` row; the default preset is Mode A.
- Ship/build story for `landlock-run` is a prerequisite for real Mode A on Linux: this host has the
  kernel feature listed in `/sys/kernel/security/lsm` but no built addon — build/matrix publication
  is a Phase-2 deliverable (release-matrix entries already designed in `native/`).
- Implement D2 once decided (fail-closed message must name the GUI switch, never the model).

**Phase 3 — the three-option prompt.**

- `packages/interaction/user-approval/`: `ApprovalOutcome` → `'allowed-once' | 'allowed-full-access'
  | 'rejected' | 'cancelled' | 'unavailable'` (rename of `allowed-for-session`); the ask advertises
  the third option via a request field (replaces `allowSession`, e.g. `allowFullAccess`).
- New shared helper (home: `dsh-sandbox-policy`): `grantFullAccessSession(session)` — appends the
  `sandbox/mode` B event, injects the model-visible mode-change notice (the `setPolicy` message
  pattern), and is the only write path; both prompt sites call it after the human answers.
- `dsh-sandbox/src/escalation.ts`: outcome mapping gains `allowed-full-access` (answers via the
  helper; the "cannot record a session grant" throw goes away — session widening is now a legal
  answer only on asks that advertise it).
- `packages/fs/tool-fs/`: pre-emptive gate on `write`/`edit`/`read` — resolve the canonical target,
  compare against workspace root + D1 allow-set, prompt (advertise `allowFullAccess`), map
  Deny/once/full-access; `never` policy maps to Deny without a prompt (service already guarantees
  it). Reads: gate lives in the tool surface, backend read behavior unchanged.
- `packages/host/apiproxy/`: answer schema + `approval/requested` frame updated to the new outcome
  and advertisement flag.
- `packages/client/ui-conversation/ApprovalPanel`: three buttons — Reject / Allow once /
  **Full access (session)** (danger-styled, confirm dialog) iff the frame advertises it; locales en
  + zh.
- `packages/client/ui-permission-presets/`: confirmation keys on the option's sandbox mode, not the
  preset name; presets table reduced to A/B rows.
- Model-visible text: tool descriptions, denial markers, runtime-context sentences re-derived for
  the two-mode + three-answer vocabulary and pinned in tests verbatim.

**Phase 4 — delegation and lifecycle.**

- `packages/subagent/subagent/src/child-agent.ts`: clamp `captureDelegatedPolicyOverrides` —
  a parent `danger-full-access` override seeds the child at `workspace-write`; the approval pin
  changes from `'never'` to the parent's policy so children can ask.
- Verify/extend the child-ask route: scoped approval dispatch reaches child agents and the web GUI
  renders/answers prompts from child sessions (apiproxy `approval/requested` carries the child
  sessionId — confirm the UI surface resolves and displays it with the owning agent's identity).
- Resume: replaying a B `sandbox/mode` event restores full access (already true via the fold);
  focused test that a mid-session answer + crash before a later op still replays correctly.

**Phase 5 — cross-cutting obligations (same PR boundaries as the surfaces they cover).**

- SDK projection: `ApprovalOutcome` and any `SessionEventMap` deltas update the TypeScript and
  Python SDK expected outputs together.
- Keyless snapshots through a real runnable `examples/` leaf (Mode A happy path, Deny, Use once,
  Full-access + revert); web e2e golden for the three-button panel. Recording needs
  `DEEPSEEK_API_KEY` → schedule for PR/CI time; unit coverage in the meantime, as this checkout
  lacked the key.
- REAL-composition (loader-booted `cordis.yml`) tests for the prompt flow per the product-visible
  plugin policy.
- Generated catalogs (`docs/persistence-catalog.md`, config catalog) drift with the deletions; the
  checkout's no-`.md`-updates rule defers regeneration — regenerate if that rule is lifted before
  landing, otherwise record the pending regen in the commit messages.

## 5. Sequencing and risk notes

- Phases 1 and 2 are deletions with no behavior addition; landing them first removes the double
  churn of modernizing machinery that dies anyway.
- Phase 3 is the only new user-visible behavior; it is GUI-reachable end to end and snapshot-gated.
- The regression to watch: `tool-bash` currently couples escalation advertisement to
  `ctx.shell.sandboxMode` presence and `sandboxPolicy` — deleting `read-only` must keep the
  enum/advertise logic and split-composition load-time errors coherent.
- Windows work is real code, not a flag: the pwsh enforcing executor must carry the same reactive
  escalation posture (it shares `approveEscalation` already) and the tool-surface read gate must be
  covered by path-canonicalization tests (case-insensitivity, drive letters, UNC, symlinks).
- Nothing in the plan reintroduces command-text gating; if D1's allow-set proves too tight in
  practice, widen the allow-set, never the matcher.
