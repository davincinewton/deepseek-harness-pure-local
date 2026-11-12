/**
 * Containment tests for lexical canonical paths and filesystem-identity aliases,
 * including the Windows-convention branch (backslash separators, case-folded
 * comparison) driven by spoofing `process.platform`, which the containment
 * reads at call time. A spoofed test needs no filesystem fixture: the backslash
 * paths exist on no POSIX host, so the identity fallback stays silent and the
 * lexical fast path decides — the same path a real win32 host takes.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { isPathUnder } from '@deepseek-ai/dsh-sandbox'

let base: string

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'dsh-sbx-containment-'))
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

describe('sandbox containment', () => {
  it('accepts equal paths, descendants, and a filesystem-root boundary', async () => {
    expect(await isPathUnder(base, base)).toBe(true)
    expect(await isPathUnder(join(base, 'child'), base)).toBe(true)
    expect(await isPathUnder(base, parse(base).root)).toBe(true)
  })

  it('uses case-insensitive lexical comparison for Windows-style containment', async () => {
    expect(await isPathUnder(join(base.toUpperCase(), 'child'), base.toLowerCase(), false)).toBe(true)
    expect(await isPathUnder(join(base, 'case-sensitive-child'), base, true)).toBe(true)
  })

  it('recognizes an alias-equivalent root by filesystem identity for a missing target', async () => {
    const realRoot = join(base, 'real')
    const aliasRoot = join(base, 'alias')
    await mkdir(realRoot)
    await symlink(realRoot, aliasRoot)
    expect(await isPathUnder(join(await realpath(realRoot), 'missing', 'file.txt'), aliasRoot)).toBe(true)
  })

  it('denies unrelated and missing roots', async () => {
    const allowed = join(base, 'allowed')
    const outside = join(base, 'outside')
    await mkdir(allowed)
    await mkdir(outside)
    expect(await isPathUnder(join(outside, 'file.txt'), allowed)).toBe(false)
    expect(await isPathUnder(join(outside, 'file.txt'), join(base, 'missing-root'))).toBe(false)
  })

  it('treats a regular-file path segment as a missing target, not containment', async () => {
    const allowed = join(base, 'allowed')
    const blocker = join(base, 'blocker')
    await mkdir(allowed)
    await writeFile(blocker, 'not a directory')
    expect(await isPathUnder(join(blocker, 'child.txt'), allowed)).toBe(false)
  })
})

describe('Windows-convention containment (process.platform spoofed to win32)', () => {
  const hostPlatform = process.platform

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: hostPlatform, configurable: true })
  })

  it('matches a backslash-spelled descendant of a backslash-spelled root, case-insensitively', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    const root = 'G:\\work\\quant\\astock-ai-trader'
    expect(await isPathUnder(root, root)).toBe(true)
    expect(await isPathUnder(`${root}\\data_loader\\download_akshare_stock_data.py`, root)).toBe(true)
    expect(await isPathUnder('g:\\WORK\\quant\\astock-ai-trader\\data_loader\\x.py', root)).toBe(true)
  })

  it('denies a same-prefix sibling, another drive, and an ancestor directory', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    const root = 'G:\\work\\quant\\astock-ai-trader'
    expect(await isPathUnder('G:\\work\\quant\\astock-ai-trader-old\\x.py', root)).toBe(false)
    expect(await isPathUnder('C:\\work\\quant\\astock-ai-trader\\x.py', root)).toBe(false)
    expect(await isPathUnder('G:\\work\\quant', root)).toBe(false)
  })
})
