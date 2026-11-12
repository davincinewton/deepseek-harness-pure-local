import { describe, expect, it } from 'vitest'
import {
  APPARMOR_FIX_FILE,
  classifyHostSandbox,
  describeSandboxDenial,
  sandboxFixGuidance,
} from '@deepseek-ai/dsh-browser-puppeteer'
import type { SandboxKnobRead } from '@deepseek-ai/dsh-browser-puppeteer'

/** Knob map fixture: paths not present in the map read as absent gates. */
function knobs(values: Record<string, string>): SandboxKnobRead {
  return (path: string) => values[path]
}

const EXE = '/home/user/.cache/puppeteer/chrome-headless-shell/linux-157/chrome-headless-shell-linux64/chrome-headless-shell'
const RESTRICT = '/proc/sys/kernel/apparmor_restrict_unprivileged_userns'
const CLONE = '/proc/sys/kernel/unprivileged_userns_clone'
const MAX = '/proc/sys/user/max_user_namespaces'
const ENABLED = '/sys/module/apparmor/parameters/enabled'

describe('classifyHostSandbox', () => {
  it('classifies the Ubuntu AppArmor userns restriction', () => {
    expect(classifyHostSandbox(knobs({ [ENABLED]: 'Y', [RESTRICT]: '1', [CLONE]: '1', [MAX]: '1000' }), EXE))
      .toEqual({ denied: true, cause: 'apparmor-restricted-userns' })
  })

  it('classifies the disabled unprivileged_userns_clone knob first', () => {
    expect(classifyHostSandbox(knobs({ [ENABLED]: 'Y', [RESTRICT]: '1', [CLONE]: '0' }), EXE))
      .toEqual({ denied: true, cause: 'userns-sysctl-disabled' })
  })

  it('classifies a zeroed user-namespace ceiling', () => {
    expect(classifyHostSandbox(knobs({ [ENABLED]: 'Y', [RESTRICT]: '1', [MAX]: '0' }), EXE))
      .toEqual({ denied: true, cause: 'user-namespaces-capped' })
  })

  it('reports available when every gate is open, absent, or disabled', () => {
    const open = { [ENABLED]: 'Y', [RESTRICT]: '0', [CLONE]: '1', [MAX]: '116299' }
    expect(classifyHostSandbox(knobs(open), EXE)).toEqual({ denied: false })
    expect(classifyHostSandbox(knobs({}), EXE)).toEqual({ denied: false })
    expect(classifyHostSandbox(knobs({ [RESTRICT]: '1' }), EXE)).toEqual({ denied: false })
  })

  it('stays quiet once the restore profile grants this exact executable', () => {
    const fixed = knobs({
      [ENABLED]: 'Y',
      [RESTRICT]: '1',
      [APPARMOR_FIX_FILE]: `profile dsh-chrome-headless-shell ${EXE} flags=(unconfined) {`,
    })
    expect(classifyHostSandbox(fixed, EXE)).toEqual({ denied: false })
    // A Chrome upgrade changes the executable path; the old grant does not silence it.
    expect(classifyHostSandbox(fixed, '/cache/linux-158/chrome-headless-shell').denied).toBe(true)
  })
})

describe('sandbox fix guidance', () => {
  it('emits the AppArmor profile commands with the executable path interpolated', () => {
    const guidance = sandboxFixGuidance('apparmor-restricted-userns', EXE)
    expect(guidance).toContain(`sudo tee ${APPARMOR_FIX_FILE}`)
    expect(guidance).toContain(`profile dsh-chrome-headless-shell ${EXE} flags=(unconfined) {`)
    expect(guidance).toContain('userns,')
    expect(guidance).toContain(`sudo apparmor_parser -r ${APPARMOR_FIX_FILE}`)
  })

  it('keeps every command on one paste-safe line with no heredoc or continuation', () => {
    const guidance = sandboxFixGuidance('apparmor-restricted-userns', EXE)
    const lines = guidance.split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatch(/^printf '%s\\n' 'abi <abi\/4\.0>,' /)
    expect(lines[0]).toContain(`| sudo tee ${APPARMOR_FIX_FILE} >/dev/null`)
    expect(lines[1]).toMatch(/^sudo apparmor_parser -r /)
    expect(guidance).not.toContain('<<')
    expect(guidance).not.toMatch(/\\$/)
  })

  it('escapes an embedded single quote in the executable path', () => {
    expect(sandboxFixGuidance('apparmor-restricted-userns', "/home/o'brien/chrome")).toContain("o'\\''brien")
  })

  it('names the exact kernel gate for each cause', () => {
    expect(describeSandboxDenial('apparmor-restricted-userns')).toContain('apparmor_restrict_unprivileged_userns=1')
    expect(describeSandboxDenial('userns-sysctl-disabled')).toContain('kernel.unprivileged_userns_clone=0')
    expect(describeSandboxDenial('user-namespaces-capped')).toContain('max_user_namespaces=0')
  })

  it('flips the sysctl knob and persists it', () => {
    const guidance = sandboxFixGuidance('userns-sysctl-disabled', EXE)
    expect(guidance).toContain('sudo sysctl -w kernel.unprivileged_userns_clone=1')
    expect(guidance).toContain('/etc/sysctl.d/99-dsh-userns.conf')
  })

  it('points the namespace ceiling at the container host', () => {
    expect(sandboxFixGuidance('user-namespaces-capped', EXE)).toContain('max_user_namespaces')
  })
})
