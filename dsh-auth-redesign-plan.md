# DSH Auth Redesign — Rule-Based, Kernel-Independent Permissions (+ Auto Mode)

**Status:** plan kept as the record of the design; implementation status lives in §11.
**Scope:** design + implementation notes; deviations from the design are recorded in place.
**Platform: Linux only.** This is a personal fork focused on Linux. The auth design targets the
Linux backend chain (`bwrap` → `landlock`) and bash only; the macOS (Seatbelt) and Windows
(pwsh / windows-acl) paths are out of scope and are not designed for, tested against, or kept in
parity. (Whether to *remove* that non-Linux code from the fork is a separate cleanup, §14.)
**Supersedes:** the earlier "3 + 5" framing; this doc folds the no-backend fallback, sticky
session grants (#5), and a Claude-Code-style auto mode into one coherent design.

---

## 1. Problem

DSH's auth is **inverted** relative to Claude Code.

| | Claude Code | DSH today |
|---|---|---|
| Primary auth | Rule matching (`allow`/`ask`/`deny` on command text + paths) — pure app logic, zero packages | Kernel sandbox mode (`read-only`/`workspace-write`/`danger-full-access`) |
| Prompt | Fallback when no rule matches | Only for *escalating* a sandbox denial |
| Kernel sandbox | **Optional** hardening layer | **Required** for the default mode to be usable |
| Works on a stock Ubuntu | Yes | **No** — confined bash is dead out of the box |

On a stock Ubuntu, both of DSH's Linux rungs are unavailable by default:

- **bwrap** = the `bubblewrap` package, not installed (and needs user namespaces).
- **landlock** = the `landlock-run` prebuilt binary, not installed (no install-time build by
  design — `native/landlock-run/AGENTS.md`).

So the default `workspace-write` confines bash only on a host the user has already set up.
`LocalSandboxProvider.confine()` fails closed with `SANDBOX_UNAVAILABLE`
(`packages/sandbox/sandbox/src/index.ts:131`), and the error's own last clause steers the user to
`danger-full-access`. The observed end state: the session flips to `danger-full-access` +
`approval: never` to get any bash running — full disk, no prompts. That is the bug.

**The fix:** make the auth layer (rules + prompts) the primary, always-available mechanism with
**zero package dependency**, and demote the kernel sandbox to an optional hardening layer.

---

## 2. Goals / Non-goals

**Goals**
- G1. On any host (stock Ubuntu included), the default experience is "apply my rules / prompt me"
  — no `apt install`, no prebuilt binary.
- G2. Bash is gated by **rules + a human prompt** when no kernel backend is present (the
  no-backend fallback). Read-only commands run free; everything else prompts (or rejects under a
  non-interactive policy).
- G3. **Auto mode**: a deterministic, heuristic rule classifier decides allow/deny with no human,
  failing closed on anything it cannot rule on.
- G4. **Sticky session grants** (#5): a human "allow for session" is a durable, replayable session
  fact; matching calls don't re-prompt.
- G5. When a kernel backend **is** present, real confinement still applies on top (no regression).
- G6. The in-process fs fence (`dsh-fs-sandbox`) is unchanged — it already works without a kernel.

**Non-goals (this design)**
- No LLM judge in auto mode (the classifier is heuristic-only by decision).
- No network/process visibility confinement (out of the current sandbox vocabulary).
- No changes to the fs fence's threat model.
- **No macOS / Windows support** (Linux-only fork): the Seatbelt and pwsh/windows-acl paths are
  out of scope; the read-only set and the no-backend fallback are bash/Linux only.

---

## 3. Claude Code reference model (what we match)

From the official docs (`code.claude.com/docs/en/permissions`):

- **Rules** `Tool` or `Tool(specifier)`: `Bash(npm run *)`, `Read(./.env)`,
  `WebFetch(domain:example.com)`. Precedence **deny → ask → allow**, first match wins.
- **Compound awareness**: split on `&&` `||` `;` `|` newlines; *every* subcommand must be allowed.
- **Wrapper stripping**: `timeout`, `nice`, `nohup`, `time`, `stdbuf`, `command`, `builtin`,
  leading env assignments, bare `xargs`.
- **Built-in read-only set** (never prompts): `ls cat echo pwd head tail grep find wc which diff
  stat du cd` + read-only `git` forms.
- **Redirection checks**: `> file` is checked against the *file* rules.
- **Modes**: `default` / `acceptEdits` / `plan` / `auto` / `dontAsk` / `bypassPermissions`.
- **Auto mode**: a background classifier reviews each gated action and checks it "aligns with your
  request"; disable-able via `permissions.disableAutoMode`.
- **"Don't ask again"**: bash approvals save a permanent rule; file approvals last until session end.

We adopt the **rule engine + read-only set + modes** shape. We do **not** adopt the LLM classifier
(heuristic-only auto, per decision) and we keep DSH's kernel sandbox as the optional hardening
layer Claude Code treats as separate.

---

## 4. Core: the permission rule engine

A new capability in `packages/interaction/` — **`dsh-permission-rules`**
(`@deepseek-ai/dsh-permission-rules`). It owns the rule vocabulary, the matchers, the rule sources,
and the single decision function. It is pure app logic with **no kernel and no model dependency**.

### 4.1 Rule syntax

```
Tool                 # matches every use of the tool
Tool(specifier)      # matches a subset
```

- **Bash specifier** = command-text pattern with `*` (matches any text incl. spaces). A pattern
  with no `*` is an exact match. `Bash(ls *)` matches `ls` and `ls -la` but not `lsof` (the space
  before a trailing `*` is significant); `Bash(ls*)` matches `lsof` too.
- **File specifier** = path pattern (`Read(./.env)`, `Edit(src/**)`), matched against the resolved
  (canonical) target.
- **Tool-name wildcards** (deny/ask only): `*`, `mcp__*`. An unanchored allow glob is ignored.

### 4.2 Precedence

`deny` → `ask` → `allow`, **first match wins**, specificity does not change order. A bare tool-name
`deny` (`Bash`) removes the tool from the model's context; a scoped deny (`Bash(rm *)`) leaves the
tool available and blocks matching calls.

### 4.3 Bash command matching (the safety-critical part)

`matchBash(rule, command) → boolean`, applied to the **normalized** command:

1. **Compound split** on `&&`, `||`, `;`, `|`, `|&`, `&`, newlines. For an **allow** rule, *every*
   subcommand must match (or be read-only). For a **deny/ask** rule, *any* subcommand matching
   triggers it (including inside `$(...)`, subshells, control-flow bodies).
2. **Wrapper strip** (allow matching only): `timeout`, `time`, `nice`, `nohup`, `stdbuf`,
   `command`, `builtin`, leading `VAR=value` env assignments, bare `xargs`. Deny/ask match *past*
   any leading assignment.
3. **Read-only set**: a subcommand whose program is in the built-in read-only set (and, for the
   flag-capable ones, carries no write/exec flag) is treated as allowed-without-prompt.
4. **Redirections**: `> f` / `>> f` / `2> f` are checked against the *file* rules as if the agent
   wrote `f`; `< f` against the *read* rules. `/dev/null`, fd forms (`2>&1`), here-docs are skipped.
5. **Unparseable** (e.g. trailing `&&`, >10 000 chars) → treated as *not* allowed by any allow rule
   (so it prompts / fails closed), never auto-allowed.

> The matcher is deliberately **conservative**: when in doubt a command is *not* read-only and *not*
> allow-matched, so it falls to the prompt (or fail-closed in auto). Bypass resistance is a
> property of the *deny* rules + the optional kernel sandbox, not of the allow matcher — exactly as
> Claude Code documents ("a Bash rule … isn't a security boundary around the program").

### 4.4 Built-in read-only set (initial, conservative)

Unambiguous read-only programs (single command, no write/exec flag):
`ls cat echo pwd head tail wc which diff stat du df file ps env printenv date whoami hostname uname
id true false test [ printf type alias basename dirname realpath readlink md5sum sha256sum cksum
cut column nl od xxd tac rev tr seq expr less more sort` (sort only without `-o`).

`git` read-only subcommands (no mutating flag): `status log diff show branch tag remote rev-parse
ls-files describe shortlog blame cat-file stash list reflog config --get`.

**Excluded** (write/exec-capable → always prompt): `find` (can `-delete`/`-exec`), `sed -i`,
`docker`/`podman` (can point at another daemon), `git` write forms, `sort -o`, anything with a
redirect to a non-`/dev/null` target outside the workspace.

The set is a **`Config` field** (overridable per deployment), not a hardcoded tunable — per the
"no hardcoded tunables in plugins" convention. The default table ships in the composition.

### 4.5 Rule sources and precedence (highest wins)

1. **Session grants** (sticky, #5) — durable session events, top precedence.
2. **User settings** — per-deployment `allow`/`ask`/`deny` (the DSH analog of
   `.claude/settings.local.json`; checkable into the workspace for project-shared rules).
3. **Composition config** — `cordis.yml` `config` on `dsh-permission-rules`.

### 4.6 The decision function (single source of truth)

```
decide(tool: string, args: ToolArgs, ctx: { session, mode }):
  'allow' | 'ask' | 'deny'
```

- Applies §4.2 precedence over the merged rule sources.
- Folds in the read-only set (a read-only call is `allow` even with no explicit rule).
- The **resulting action** is then shaped by the session's approval policy (§6):
  - `allow` → run.
  - `deny` → structured reject (model-visible marker, no execution).
  - `ask` → route to the approval channel; the policy decides who answers (§6).

---

## 5. Enforcement point (where the decision is made)

Per the "enforce a decision in the operation that makes it" convention, the gate lives in the
**tool layer** (`dsh-tool-bash`, `dsh-tool-fs`, `dsh-tool-pwsh`), *before* execution — not in the
executor and not in a prompt filter. The tool:

1. Calls `ctx.permissionRules.decide(tool, args, …)`.
2. `deny` → throw the structured reject (the model sees a `[permission: denied …]` marker).
3. `allow` → execute (confined when a backend is present; unconfined-but-authorized when not, §6.2).
4. `ask` → execute the approval channel (§6).

The kernel **executor** (`dsh-bash-sandbox`) is unchanged in its fail-closed contract: it still
refuses to run unconfined unless the *caller* explicitly stamps an unconfined policy. The tool is
the only caller that does that, and only after the gate authorized it. This keeps
"silent unconfined passthrough is forbidden" intact — the unconfined run is an *explicit,
authorized* decision, not a fallback.

---

## 6. The three approval policies (ask / never / auto)

`dsh-user-approval`'s `ApprovalPolicy` grows from `'ask' | 'never'` to **`'ask' | 'never' | 'auto'`**.
The policy decides what happens to an `ask`-classified action:

| Policy | `allow` | `deny` | `ask` (no rule / novel) |
|---|---|---|---|
| `ask` (default) | run | reject | **prompt the human** (GUI answerer); fail closed if none |
| `never` | run | reject | **reject** (deterministic; CI/unattended) |
| `auto` (new) | run | reject | **the heuristic classifier decides** (§6.3) |

### 6.1 `ask` — unchanged, but now the *default* on a no-backend host
The GUI already has the answerer (the "Allow once / Reject" composer takeover,
`packages/client/ui-conversation/src/client/apply.ts`). We add a third button, **"Allow for
session"**, which records a sticky grant (§7).

### 6.2 No-backend fallback (the G1/G2 fix)

When `ctx.sandbox.backendAvailable()` is `false` (new `SandboxProvider` method, §8) and the
resolved mode is a confining one (`read-only`/`workspace-write`):

- The command is **not** kernel-confined (impossible).
- It is gated by `decide()`:
  - read-only / `allow`-matched → run **unconfined** (safe: read-only, or explicitly allowed).
  - `ask`-classified → prompt (or reject under `never`/`auto`-fail-closed).
  - `deny` → reject.
- The result reports `sandbox: { mode: <requested>, enforcement: 'none' }` — a new
  `SandboxEnforcement` value meaning "no backend; ran unconfined under the rule gate." This is
  honest (the model is not told it has `danger-full-access`) and auditable.

When a backend **is** present, this path is never taken — confinement applies as today (G5).

> Net effect on stock Ubuntu: `ls`/`git status`/… run free; `npm install`/`rm`/… prompt; the user
> approves (and can make it sticky or add an allow rule). No package install, no full-access flip.

### 6.3 `auto` — the heuristic classifier (G3)

Under `auto`, an `ask`-classified action is **not** prompted. Instead the rule engine is the
decider, failing closed:

```
autoDecide(action):
  if matches a deny rule        → reject
  if read-only or allow-matched → allow
  else                          → reject   // heuristic cannot judge the novel → fail closed
```

This is a deterministic, model-free "auto": it runs everything the user has allow-listed or that is
read-only, and refuses the rest. It is the safe analog of Claude Code's auto mode minus the LLM
judge (per the "heuristic rules only" decision), and it doubles as a strong `dontAsk`-plus-allow
posture for unattended/CI runs. `auto` is **disable-able** via a config flag
(`disableAutoMode`, the Claude Code analog) so a managed deployment can forbid it.

> Security note (kept honest in the doc, per Claude Code's own framing): a heuristic auto mode is
> only as safe as its allow rules. It is for trusted, allow-listed workloads; it is not a
> substitute for the kernel sandbox when real isolation is required.
>
> *As landed:* there is no `autoDecide` function at the approval seam. The heuristic is the
> existing per-tool `decide()` (deny → granted → allow → read-only), which runs before any ask is
> issued; `auto` then converts every surviving ask into a synchronous `'rejected'` (audited like
> `never`, no listener consulted, no escalation can succeed). The result is the `autoDecide`
> table above with the allow half already applied upstream.

---

## 7. Sticky session grants (#5)

A human "Allow for session" (or an `auto`-mode allow decision the user wants to persist) is
recorded as a **durable, log-only session event** — the `approval/*` / `sandbox/mode` precedent:

```
'sandbox/grant': { mode: SandboxMode, root?: string }   // landed shape (no source field)
```

- **Fold** `effectiveGrants(events)`: grants in log order, **reset by the next `sandbox/mode`
  switch** (a manual tighten revokes auto-grants — the invariant "a manual mode switch resets the
  session's escalation grants"). Tested for resume and for both askers.
- **Write** `grantSandbox(session, grant)` appends exactly one event.
- **Use**: `decide()` takes `{ granted }` and ranks an effective grant **above `ask`, below
  `deny`** — a deny rule remains bypass-proof under every mode, so a grant cannot punch through
  it. Matching calls skip the prompt. A grant that came from a fresh human approval appends a new
  event; a call already covered by a grant appends nothing.
- **Scope**: bash grants are rootless and cover bash under their mode; filesystem grants carry
  the gated target path as `root` and cover that path (equal or below) only. The two scopes never
  cross. (The design's `source?: 'delegation'` field was not landed — nothing writes it.)
- **Consent**: a session grant can be answered only on an ask that advertised
  `allowSession` (service → `'unavailable'`, proxy → `bad-response` otherwise); escalation asks
  never advertise it, so "approve the escalation" stays a one-shot.
- **Replay**: resume reconstructs grants by replaying the log (no catch-up state).
- **Subagents**: a `sandbox/grant` is **not** inherited by children (a grant is a human decision for
  *this* session; children re-derive from their own log).

This replaces the current one-shot-only escalation grant and gives the "allow for session" the GUI
button a durable home.

---

## 8. Provider + policy changes

- **`dsh-sandbox`** (`SandboxProvider`): add `backendAvailable(): boolean` — whether a confining
  runner is usable on this host (from the cached chain verdict; does not throw).
- **`dsh-sandbox-local`** (`LocalSandboxProvider`): implement `backendAvailable()` from the existing
  cached `selectedRunner` (`chainVerdict()`); probe once, cache, never fail open.
- **`dsh-sandbox`** (`SandboxEnforcement`): extend `'full' | 'partial'` → `'full' | 'partial' |
  'none'` for the no-backend unconfined run.
- **`dsh-sandbox-policy`**: new `sandbox/grant` event + `effectiveGrants` fold + `grantSandbox`
  write (alongside `sandbox/mode`).
- **`dsh-user-approval`**: `ApprovalPolicy` += `'auto'`; the `auto` path answers through
  `dsh-permission-rules`' classifier instead of the human waterfall.
- **`dsh-permission-presets`**: the preset table gains the new policy value; the shipped table
  adds an `auto` preset (`workspace-write` + `auto`). A `danger-full-access` + `ask` preset is
  expressible in the schema but **not shipped yet**: the access-mode confirmation gate keys on the
  preset name, so it must first key on the sandbox mode (deferred, item 11).

---

## 9. Package layout

```
packages/interaction/permission-rules/     NEW  dsh-permission-rules
  src/index.ts        Service Definition: ctx.permissionRules, decide(), rule sources
  src/rules.ts        rule parse + Tool(specifier) model
  src/bash-match.ts   compound split, wrapper strip, redirect check, read-only set
  src/fs-match.ts     path-pattern match
  src/read-only.ts    default read-only table (Config-overridable)
  tests/*.spec.ts     pure matcher tests (verbatim, conservative cases pinned)
packages/sandbox/sandbox/                  dsh-sandbox  (+backendAvailable, +enforcement 'none',
                                              +read-only re-export if shared)
packages/sandbox/sandbox-local/            dsh-sandbox-local  (backendAvailable impl)
packages/sandbox/sandbox-policy/           dsh-sandbox-policy (+sandbox/grant fold/write)
packages/interaction/user-approval/        dsh-user-approval  (+auto policy)
packages/shell/tool-bash/                  dsh-tool-bash      (gate before exec)
packages/fs/tool-fs/                       dsh-tool-fs        (gate before mutation)
packages/client/ui-conversation/           (+ "Allow for session" button)
packages/bundle/base/cordis.patch.yml      (compose dsh-permission-rules; default read-only table)
```

---

## 10. New / changed model-visible + durable surfaces

- **Durable, log-only events**: `sandbox/grant` (new). `approval/policy` now accepts `'auto'`.
- **Model-visible text**:
  - `[permission: denied by rule <rule>]` (a deny) — distinct from the sandbox denial marker.
  - The runtime-context policy sentence gains the `auto` variant (alongside the existing
    `ask`/`never` sentences in `dsh-user-approval`).
  - The bash tool description gains a no-backend clause ("commands are gated by permission rules;
    read-only commands run free, others may prompt").
- **SDK projection**: `SessionEventMap` gains `sandbox/grant`; the TypeScript **and** Python SDK
  expected outputs update in the same change (AGENTS.md: "both SDKs project the loop").
- **Session format**: `sandbox/grant` is a new *required-on-read* event only if a build must know
  its type; otherwise it carries `ignorable: true`. Decide at implementation (lean `ignorable` —
  it's an audit/grant fact, not a transcript input).

---

## 11. Phased implementation plan

**Phase 0 — host fix (no code).** Install `bwrap` or build the landlock launcher. Confirms the
fallback is only needed when confinement is genuinely impossible. *(user action)*
**Status on this host: OPEN.** `bwrap` exists but its probe fails (`bwrap: setting up uid map:
Permission denied`) and the landlock addon is not installed, so the fallback lane (§6.2) is the
live path here.

**Phase 1 — no-backend fallback (unblocks stock Ubuntu). ✅ IMPLEMENTED.**
1. `dsh-sandbox`: `SandboxProvider.backendAvailable()` (default `false`);
   `SandboxEnforcement` += `'none'`.
2. `dsh-sandbox-local`: `LocalSandboxProvider.backendAvailable()` from the cached chain verdict
   (a configured `runnerCommand` is always available).
3. Read-only matcher: `dsh-sandbox/src/read-only.ts` (`isReadOnlyBashCommand` /
   `isReadOnlySimpleCommand`) — conservative compound-split + read-only set + git read-only forms.
   *(Housed in `dsh-sandbox`; the full rule engine landed beside it in Phase 2 — see below.)*
4. `dsh-shell` `ShellExecutor.backendAvailable()` (default `true`, the capability fact the tool
   reads); `SandboxBashExecutor` / `SandboxPwshExecutor` override it to delegate to the provider.
5. `dsh-tool-bash`: gate before exec — a confining mode with no backend is read-only-checked
   (free) or routed through `ctx.approval` (ask → prompt, else fail-closed); when authorized it
   runs unconfined and reports `sandbox: { mode: <requested>, denied: false, enforcement: 'none' }`
   (foreground and background). The executor stays fail-closed for direct callers.
6. Tests: `dsh-sandbox/tests/read-only.spec.ts` (matcher boundary), `dsh-tool-bash` no-backend
   suite (read-only free / non-read-only prompts / rejected / no-channel fail-closed / backend-present
   path unchanged). Typecheck green.
   *Deliverable: stock Ubuntu works with zero packages — read-only commands run free, everything
   else prompts (or rejects under a non-interactive policy). No full-access flip.*

   > Note: the `dsh-bash-sandbox` test "reports a real permission failure as a sandbox denial" fails
   > on this host for a pre-existing reason unrelated to this change — the host's `zh_CN` locale
   > makes bash print `权限不够` instead of the English `Permission denied` the denial signature
   > matches. It fails identically with this change reverted.

**Phase 2 — rule engine (close match). ✅ IMPLEMENTED (placements adjusted).**
6. `Tool(specifier)` parse, deny/ask/allow precedence (effect order regardless of list order,
   case-insensitive tool names), compound split (fd-dup aware), wrapper strip, redirect checks,
   `*`/`**` file path patterns: `dsh-sandbox/src/rules.ts` (`parsePermissionRule`, `parseRules`,
   `matchBashRule`, `matchFsRule`, `decide`). The engine lives in `dsh-sandbox` beside the
   read-only set instead of a new `dsh-permission-rules` package — same dependency tier, and the
   package extraction stays a clean mechanical refactor if Phase 3 grows it.
7. Gates: `dsh-tool-bash` — a deny rule blocks under EVERY mode (bypass-proof); in the no-backend
   fallback `decide()` replaces the bare read-only check (allow free / ask prompts). `dsh-tool-fs`
   — `write`/`edit` overlay-gate the resolved path (deny blocks, ask prompts, no match keeps the
   fence behavior). Rules arrive as each tool's `rules` Config (`Tool(specifier)` texts, parsed
   once at load — a malformed rule fails the composition at startup). This already houses the
   phase-4 "deny blocks a confined run" behavior for bash.
8. Tests: matcher matrix pinned (`ls *` vs `ls*`, program-only match, wrapper/env strip, redirect
   + `/dev/null`/fd-dup, allow-compound every-part vs deny-any-part), precedence, fs glob
   anchoring + `/**/` whole-segment semantics, both tool gates, load-time rule validation.
   Per-file coverage 100% on all changed sources; typecheck green.
   **Deferred deliberately:** the user-settings-file rule source (a `dsh-settings` namespace
   registration — its own seam; pairs naturally with Phase 3's auto mode and sticky grants).

**Phase 3 — auto mode + sticky grants. ⚠ PARTIALLY IMPLEMENTED (items 9, 10, and an `auto` preset
of 11 shipped; item 12 open).**
9. `dsh-user-approval`: `'auto'` policy + heuristic `autoDecide` (fail-closed) + `disableAutoMode`.
   *As landed:* `ApprovalPolicy` += `'auto'`; `request()` answers a deterministic `'rejected'`
   before any listener runs (like `never`), and normalizes an out-of-vocabulary answer to
   `'unavailable'`. There is **no** `autoDecide` in the approval service: the heuristic is the
   existing rule engine + read-only set inside the tools (`decide()` treats a grant as allow), so
   `auto` only has to stop the surviving asks from reaching a prompt. `disableAutoMode` is a
   Config field: composing `policy: 'auto'` with it throws at load, `setPolicy(..., 'auto')` throws,
   and a log that already carries `auto` (resume) still rejects deterministically; the runtime
   context states the disabled variant so the model never retries an escalation that cannot be
   granted.
10. `sandbox/grant` event + fold + write; `decide()` consumes grants; GUI "Allow for session".
    *As landed:* event `{ mode, root? }` in `dsh-sandbox-policy` with `effectiveGrants` (reset by
    the next `sandbox/mode`), `grantSandbox`, and `grantCovers`. `decide()` takes
    `{ granted }` as an option and ranks it **below deny, above ask** — deny stays bypass-proof
    under every mode, which the design's "top-precedence allow" would have lost. A grant is
    recordable only for an ask that advertises `allowSession`: the service downgrades a rogue
    `allowed-for-session` to `'unavailable'`, the proxy rejects it as `bad-response`, and
    `tool-fs`/`tool-bash` record it only for their own ask paths. Bash grants are rootless (they
    cover bash under the mode), filesystem grants carry the target path as `root`. Escalation asks
    never offer a session grant (an escalation answer is an "allow once"). GUI: a third button
    `approval.allowSession` renders iff the pending frame carries `allowSession`.
11. Preset table decoupling (`danger-full-access` + `ask`).
    *As landed:* the shipped table (base bundle) adds an `auto` preset
    (`workspace-write` + `auto`, label "Auto"); the `danger-full-access` row still pairs with
    `never`. A second full-access preset with `ask` was deliberately not shipped: the
    access-mode confirmation gate keys on the preset name (`FULL_ACCESS_PRESET`), so another
    full-access entry would slip past the confirm dialog — decoupling needs that gate to key on
    the sandbox mode instead, which is its own change.
12. SDK (TS + Python) expected-output updates; snapshot for the assembled transcript. **OPEN.**
    No existing SDK expected output carries a `sandbox/grant` or `auto` event (the new vocabulary
    only appears under the new feature), and the assembled-transcript snapshot needs a recorded
    fixture — this checkout has no `DEEPSEEK_API_KEY`, so recording is deferred to CI/PR time.
    Unit coverage landed instead: grants fold/covers/write + invariant, `decide()` grant order,
    approval `auto`/`disableAutoMode`/`allowSession` normalization, proxy frame + validation,
    bash/fs gates (grant skip, session grant, reset on mode switch, deny priority), and the
    ApprovalPanel's third button.

**Phase 4 — hardening parity (optional).** When a backend is present, layer the rule gate *in front
of* confinement (deny rules block even a confined run) so rules and the kernel sandbox compose.
*Not started.*

---

## 12. Risks / open questions

- **Allow-matcher bypass.** Command-text rules are not a security boundary (Claude Code says the
  same). Mitigation: deny rules + the optional kernel sandbox carry the security weight; the allow
  matcher only reduces prompts. Documented, not hidden.
- **`enforcement: 'none'` honesty.** Reporting the *requested* mode with `enforcement: 'none'` must
  not read as "confined." The model-visible text and the result field must make "unconfined, gated
  by rules" unambiguous.
- **Auto mode safety.** Heuristic auto is only as safe as its allow rules; it is for trusted
  allow-listed workloads. `disableAutoMode` lets managed deployments forbid it.
- **Grant reset invariant.** "A manual `sandbox/mode` switch resets grants" must hold across resume
  (replay) and delegation; needs a focused test.
- **Read-only table ownership.** It's a `Config` default, not a tunable; the default table lives in
  the composition so a deployment can extend/trim it without a code change.
- **Linux-only drift.** Because this fork drops macOS/Windows, the upstream `PLATFORM_CHAINS`
  (`bwrap`/`landlock`/`seatbelt`/`windows-acl`) and the pwsh/seatbelt profile builders become dead
  weight. Leaving them in is harmless (they never select on Linux); removing them is §14.

---

## 13. What we are explicitly NOT doing

- No LLM judge in auto mode (heuristic-only, per decision). As landed there is no judge at all:
  `auto` is a deterministic reject for anything the rules/read-only set did not already allow.
- No new sandbox *mode* (the 3-mode vocabulary is unchanged; `enforcement: 'none'` is a
  completeness value, not a mode). The *preset* list does gain an `auto` entry, which is a
  (sandbox mode, approval policy) bundle, not a sandbox mode.
- No fs-fence threat-model change.
- No network/process confinement.
- No macOS (Seatbelt) or Windows (pwsh / windows-acl) support — Linux-only fork.

---

## 14. Optional: stripping non-Linux code from the fork (separate task)

The Linux-only focus lets the fork eventually delete the non-Linux surface. This is **independent
of the auth work** and can be done before, after, or never. If wanted, the removal set is:

- **Packages:** `dsh-pwsh-local`, `dsh-pwsh-sandbox`, `dsh-tool-pwsh`,
  `dsh-sandbox-windows-acl`, and the Seatbelt profile path in `dsh-sandbox-local`.
- **`dsh-sandbox-local`:** `PLATFORM_CHAINS` collapses to `linux: ['bwrap', 'landlock']`; the
  `seatbeltProfileArgs` / `windowsAcl*` code and the windows-acl grant machinery
  (`AclWriteGrant`, `materializeAclGrant`, `revokeAclGrants`) go.
- **Compositions:** `packages/bundle/base/cordis.patch.yml` drops the `pwsh-sandbox` / `tool-pwsh`
  rows (currently `disabled: process.platform !== 'win32'`).
- **Test/coverage config:** `vitest.config.ts` drops the `windowsUnsupportedPackages` /
  `windowsOnlyCoverageExclusions` / `pwshCoverageExclusions` blocks (all keyed on `process.platform`).
- **`native/landlock-run`:** the per-platform package matrix can collapse to `linux-x64` /
  `linux-arm64` only (drop the release-matrix entries for other platforms).

Tradeoff: deleting upstream code widens the fork's divergence from upstream, making future
re-bases harder. Since it's a personal fork, that may be acceptable — but it's a deliberate,
reviewable cleanup, not something to fold into the auth change.