/**
 * Host sandbox reporting: classifies why the host denies Chrome the
 * unprivileged user namespaces its kernel-native sandbox needs, and builds
 * the exact host-side restore commands. Chrome's own sandbox is pure kernel
 * machinery (user namespaces + seccomp); on Linux a distro or container
 * policy layer can gate the namespace creation behind it, which is what this
 * probe detects. The classification is a pure function over an injected knob
 * reader, so the provider and tests run against deterministic synthetic hosts
 * while {@link probeHostSandbox} reads the real `/proc` and `/sys` knobs.
 * @module @deepseek-ai/dsh-browser-puppeteer/host-sandbox
 */

import { readFileSync } from 'node:fs'
import { platform } from 'node:os'

/** Why the host denies unprivileged user namespaces. */
export type SandboxDenialCause =
  /** Ubuntu 23.10+ gates user-namespace creation on an AppArmor profile granting `userns`; unconfined binaries are denied. */
  | 'apparmor-restricted-userns'
  /** Debian-style `kernel.unprivileged_userns_clone` knob switched off. */
  | 'userns-sysctl-disabled'
  /** `user.max_user_namespaces` is zero — a container or host ceiling forbidding any user namespace. */
  | 'user-namespaces-capped'

/** Host sandbox availability verdict for one Chrome executable. */
export type HostSandboxStatus =
  | { readonly denied: false }
  | { readonly denied: true; readonly cause: SandboxDenialCause }

/** Reads one kernel knob or policy file; `undefined` = absent or unreadable. */
export type SandboxKnobRead = (path: string) => string | undefined

/**
 * The provider's host probe: reports whether the OS policy denies Chrome's
 * sandbox for `executablePath`. Production wires {@link probeHostSandbox};
 * tests supply a synthetic verdict.
 */
export type HostSandboxProbe = (executablePath: string) => HostSandboxStatus

/** AppArmor profile file the emitted restore commands install. */
export const APPARMOR_FIX_FILE = '/etc/apparmor.d/dsh-chrome-headless-shell'

/** Kernel knob paths read by {@link probeHostSandbox}. */
const KNOBS = {
  apparmorEnabled: '/sys/module/apparmor/parameters/enabled',
  apparmorRestrictUserns: '/proc/sys/kernel/apparmor_restrict_unprivileged_userns',
  unprivilegedUsernsClone: '/proc/sys/kernel/unprivileged_userns_clone',
  maxUserNamespaces: '/proc/sys/user/max_user_namespaces',
} as const

/** A host that grants user namespaces (or a non-Linux platform). */
const SANDBOX_AVAILABLE: HostSandboxStatus = { denied: false }

/**
 * Classify a host from knob values. Absent or unreadable knobs mean the gate
 * does not exist on this kernel, never "denied". The AppArmor verdict also
 * requires AppArmor itself enabled, and is suppressed once the restore
 * profile is installed for this exact executable: the fix file is overwritten
 * by the emitted commands, so a Chrome upgrade (new build path) re-raises the
 * notice with commands for the new path.
 *
 * @param read - knob reader for this host.
 * @param executablePath - the Chrome executable the grant must cover.
 * @returns the denial verdict and cause.
 */
export function classifyHostSandbox(read: SandboxKnobRead, executablePath: string): HostSandboxStatus {
  if (read(KNOBS.unprivilegedUsernsClone) === '0') {
    return { denied: true, cause: 'userns-sysctl-disabled' }
  }
  if (read(KNOBS.maxUserNamespaces) === '0') {
    return { denied: true, cause: 'user-namespaces-capped' }
  }
  if (
    read(KNOBS.apparmorEnabled) === 'Y'
    && read(KNOBS.apparmorRestrictUserns) === '1'
    && !read(APPARMOR_FIX_FILE)?.includes(executablePath)
  ) {
    return { denied: true, cause: 'apparmor-restricted-userns' }
  }
  return SANDBOX_AVAILABLE
}

/**
 * Probe the running host. Non-Linux platforms always report available:
 * macOS (Seatbelt) and Windows (restricted tokens) grant Chrome's sandbox
 * unconditionally, so no policy gate can exist.
 *
 * @param executablePath - the Chrome executable the grant must cover.
 * @returns the denial verdict and cause.
 */
export function probeHostSandbox(executablePath: string): HostSandboxStatus {
  if (platform() !== 'linux') return SANDBOX_AVAILABLE
  return classifyHostSandbox(readKnob, executablePath)
}

/** Read one knob; a missing or unreadable gate is indistinguishable from absent. */
function readKnob(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8').trim()
  } catch {
    // Swallows ENOENT/EACCES on kernel knobs: an unreadable gate is not a
    // gate, and guessing "denied" would send healthy hosts to a useless fix.
    return undefined
  }
}

/**
 * One-line cause clause for notices and errors.
 *
 * @param cause - the classified denial.
 * @returns the diagnostic text naming the exact gate.
 */
export function describeSandboxDenial(cause: SandboxDenialCause): string {
  switch (cause) {
    case 'apparmor-restricted-userns':
      return 'AppArmor restricts unprivileged user namespaces (kernel.apparmor_restrict_unprivileged_userns=1, Ubuntu 23.10+; unconfined binaries are denied)'
    case 'userns-sysctl-disabled':
      return 'kernel.unprivileged_userns_clone=0'
    case 'user-namespaces-capped':
      return 'user.max_user_namespaces=0 (container or host ceiling; no user namespace can be created)'
  }
}

/**
 * Host-side restore guidance for the diagnosed cause: one-line paste commands
 * for the two fixable gates — a 5-line AppArmor profile granting `userns` to
 * this exact executable (the mechanism Ubuntu ships for Google Chrome), or
 * the sysctl flip plus its persistence file — and an explanation when the
 * ceiling is set outside the reach of this machine. Every command is one
 * line: no heredoc, no continuation state, so selecting and pasting a line
 * runs it as-is even when terminal wrapping splits it visually.
 *
 * @param cause - the classified denial.
 * @param executablePath - the Chrome executable the grant must cover.
 * @returns single-line commands or advice text, one per line.
 */
export function sandboxFixGuidance(cause: SandboxDenialCause, executablePath: string): string {
  switch (cause) {
    case 'apparmor-restricted-userns': {
      const profileLines = [
        'abi <abi/4.0>,',
        'include <tunables/global>',
        '',
        `profile dsh-chrome-headless-shell ${executablePath} flags=(unconfined) {`,
        '  userns,',
        '}',
      ]
      return [
        `printf '%s\\n' ${profileLines.map(shellSingleQuote).join(' ')} | sudo tee ${APPARMOR_FIX_FILE} >/dev/null`,
        `sudo apparmor_parser -r ${APPARMOR_FIX_FILE}`,
      ].join('\n')
    }
    case 'userns-sysctl-disabled':
      return [
        'sudo sysctl -w kernel.unprivileged_userns_clone=1',
        "echo 'kernel.unprivileged_userns_clone=1' | sudo tee /etc/sysctl.d/99-dsh-userns.conf >/dev/null",
      ].join('\n')
    case 'user-namespaces-capped':
      return 'raise /proc/sys/user/max_user_namespaces on the container host — a guest under a zero ceiling has no in-container fix'
  }
}

/** Shell single-quote one value; an embedded `'` splices through as `'\\''`. */
function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", '\'\\\'\'')}'`
}
