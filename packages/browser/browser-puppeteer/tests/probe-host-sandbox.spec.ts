import { beforeEach, describe, expect, it, vi } from 'vitest'

// node:os and node:fs are replaced so probeHostSandbox runs against a
// synthetic host: every knob value, the platform split, and the unreadable-
// knob path are deterministic instead of dependent on the CI machine.
const { platformMock, readFileSyncMock } = vi.hoisted(() => {
  const platformMock = vi.fn((): string => 'linux')
  const readFileSyncMock = vi.fn((_path: string): string => {
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  })
  return { platformMock, readFileSyncMock }
})

vi.mock('node:os', async importOriginal => ({
  ...(await importOriginal<typeof import('node:os')>()),
  platform: platformMock,
}))
vi.mock('node:fs', async importOriginal => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  readFileSync: readFileSyncMock,
}))

const { probeHostSandbox } = await import('@deepseek-ai/dsh-browser-puppeteer')

describe('probeHostSandbox', () => {
  beforeEach(() => {
    platformMock.mockReturnValue('linux')
    readFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
  })

  it('reports available without touching the filesystem on non-Linux platforms', () => {
    platformMock.mockReturnValue('darwin')
    expect(probeHostSandbox('/bin/chrome-headless-shell')).toEqual({ denied: false })
    expect(readFileSyncMock).not.toHaveBeenCalled()
  })

  it('classifies the real-host knobs it reads', () => {
    const knobs: Record<string, string> = {
      '/sys/module/apparmor/parameters/enabled': 'Y',
      '/proc/sys/kernel/apparmor_restrict_unprivileged_userns': '1',
      '/proc/sys/kernel/unprivileged_userns_clone': '1',
      '/proc/sys/user/max_user_namespaces': '116299',
    }
    readFileSyncMock.mockImplementation((path: string) => {
      const value = knobs[path]
      if (value === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return value
    })
    expect(probeHostSandbox('/bin/chrome-headless-shell')).toEqual({
      denied: true,
      cause: 'apparmor-restricted-userns',
    })
  })

  it('treats missing knobs as open gates', () => {
    expect(probeHostSandbox('/bin/chrome-headless-shell')).toEqual({ denied: false })
  })
})
