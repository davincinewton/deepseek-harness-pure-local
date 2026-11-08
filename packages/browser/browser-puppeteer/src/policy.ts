/**
 * URL validation and network-address policy for the Puppeteer provider — the
 * half that runs before any browser navigation. A browser executes page scripts
 * and fetches subresources, so it gets a stricter target policy than the
 * `dsh-web-fetch-http` provider (which defers SSRF protection): literal
 * private/reserved addresses, `*.localhost`, and hostnames resolving to
 * private addresses are refused unless explicitly allowed.
 *
 * @module @deepseek-ai/dsh-browser-puppeteer/policy
 */

import { lookup } from 'node:dns/promises'
import { BrowserError } from '@deepseek-ai/dsh-browser'

/** Options for {@link assertNavigationTargetAllowed}. */
export interface NavigationPolicyOptions {
  /** Allow loopback addresses (`127.0.0.0/8`, `::1`, `*.localhost`). */
  readonly allowLoopback: boolean
  /** Hostnames (case-insensitive, exact match) allowed regardless of address class. */
  readonly allowHosts: readonly string[]
}

/**
 * Validate a navigation URL against transport hygiene the provider enforces
 * before any browser contact: http(s) only, no embedded credentials, bounded
 * length. Returns the parsed `URL`; throws {@link BrowserError} otherwise.
 *
 * @param input - the raw URL string from the navigate request.
 * @param maxUrlLength - inclusive upper bound on `input`'s length.
 * @returns the parsed `URL`.
 */
export function validateNavigateUrl(input: string, maxUrlLength: number): URL {
  if (input.length > maxUrlLength) {
    throw new BrowserError(`URL exceeds the maximum length of ${maxUrlLength}`, 'BROWSER_INVALID_URL')
  }
  let url: URL
  try {
    url = new URL(input)
  } catch (error: unknown) {
    throw new BrowserError(`invalid URL: ${input}`, 'BROWSER_INVALID_URL', { cause: error })
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BrowserError(`unsupported URL scheme "${url.protocol}" (only http and https are allowed)`, 'BROWSER_INVALID_URL')
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new BrowserError('credentials in URLs are not allowed', 'BROWSER_BLOCKED_URL')
  }
  return url
}

/**
 * True for IPv4 addresses in ranges that must never be reached by a
 * model-chosen URL: this-network, RFC1918, CGNAT, loopback, link-local
 * (covers the cloud metadata address), benchmarking, documentation,
 * multicast, and reserved blocks.
 */
function isPrivateIpv4(address: string): boolean {
  const parts = address.split('.')
  if (parts.length !== 4) return true
  const octets = parts.map(part => (/^\d{1,3}$/.test(part) ? Number(part) : NaN))
  if (octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)) return true
  const [a = 0, b = 0] = octets
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT 100.64.0.0/10
  if (a === 169 && b === 254) return true // link-local, includes 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && (b === 0 || b === 168)) return true // 192.0.0.0/24, 192.168.0.0/16
  if (a === 198 && (b === 18 || b === 19)) return true // benchmarking 198.18.0.0/15
  if (a === 198 && b === 51) return true // documentation 198.51.100.0/24
  if (a === 203 && b === 0) return true // documentation 203.0.113.0/24
  if (a >= 224) return true // multicast and reserved
  return false
}

/**
 * Expand an IPv6 address literal (zone ids and embedded IPv4 suffixes accepted)
 * to its 16 bytes, or `undefined` when malformed. Malformed addresses are
 * treated as blocked by every caller, so this never widens the allowed set.
 */
function ipv6ToBytes(address: string): number[] | undefined {
  const [zoneless = ''] = address.toLowerCase().split('%')
  let text = zoneless
  // Replace a trailing embedded IPv4 with the two hex words it encodes.
  const embedded = text.match(/(\d{1,3}\.){3}\d{1,3}$/)
  if (embedded !== null) {
    const octets = embedded[0].split('.').map(Number)
    if (octets.length !== 4 || octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)) return undefined
    const [a = 0, b = 0, c = 0, d = 0] = octets
    const hi = ((a << 8) | b).toString(16)
    const lo = ((c << 8) | d).toString(16)
    text = text.slice(0, embedded.index) + hi + ':' + lo
  }
  const sides = text.split('::')
  if (sides.length > 2) return undefined
  let words: string[]
  if (sides.length === 1) {
    words = text.split(':')
    if (words.length !== 8) return undefined
  } else {
    const [leftText = '', rightText = ''] = sides
    const left = leftText === '' ? [] : leftText.split(':')
    const right = rightText === '' ? [] : rightText.split(':')
    if (left.includes('') || right.includes('')) return undefined
    const fill = 8 - left.length - right.length
    if (fill < 0) return undefined
    words = [...left, ...Array<string>(fill).fill('0'), ...right]
  }
  if (!words.every(word => /^[0-9a-f]{1,4}$/.test(word))) return undefined
  return words.flatMap((word) => {
    const value = parseInt(word, 16)
    return [(value >> 8) & 0xff, value & 0xff]
  })
}

/** True for IPv6 addresses in loopback, unspecified, ULA, link-local, multicast, or private-mapped ranges. */
function isPrivateIpv6(address: string): boolean {
  const bytes = ipv6ToBytes(address)
  if (bytes === undefined) return true
  const [a = 0, b = 0] = bytes
  if (bytes.every(byte => byte === 0)) return true // :: unspecified
  if (bytes.slice(0, 15).every(byte => byte === 0) && bytes[15] === 1) return true // ::1
  if (bytes.slice(0, 10).every(byte => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
    // IPv4-mapped: classify the embedded IPv4 address itself.
    return isPrivateIpv4(bytes.slice(12).map(byte => String(byte)).join('.'))
  }
  if ((a & 0xfe) === 0xfc) return true // fc00::/7 unique-local
  if (a === 0xfe && (b & 0xc0) === 0x80) return true // fe80::/10 link-local
  if (a === 0xff) return true // ff00::/8 multicast
  return false
}

/** True for the loopback address classes `allowLoopback` unlocks. */
function isLoopbackAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, '').toLowerCase()
  if (bare.includes(':')) {
    if (bare === '::1') return true
    const bytes = ipv6ToBytes(bare)
    if (bytes === undefined) return false
    return bytes.slice(0, 15).every(byte => byte === 0) && bytes[15] === 1
  }
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare)
}

/** True when the address literal belongs to a class the policy refuses. */
export function isBlockedAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, '')
  if (bare.includes(':')) return isPrivateIpv6(bare)
  if (/^\d+$/.test(bare)) return true // IPv4 shorthand literals (e.g. 2130706433) never name a public host
  if (/^[0-9.]+$/.test(bare)) return isPrivateIpv4(bare)
  return false
}

/**
 * Assert a parsed navigation URL names an allowed target. Exact
 * `allowHosts` matches bypass the address rules; otherwise loopback names
 * (`localhost`, `*.localhost`, `127.0.0.0/8`, `::1`) follow `allowLoopback`,
 * and every other host must resolve to no private/reserved address.
 * Unresolvable hostnames pass (the navigation itself then fails with the
 * browser's own error); DNS lookups that cannot run pass for the same reason.
 *
 * @param url - the URL from {@link validateNavigateUrl}.
 * @param options - the deployment's policy knobs.
 * @returns resolves when allowed; rejects with {@link BrowserError}
 *   `BROWSER_BLOCKED_URL` otherwise.
 */
export async function assertNavigationTargetAllowed(url: URL, options: NavigationPolicyOptions): Promise<void> {
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  if (options.allowHosts.some(allowed => allowed.toLowerCase() === host)) return
  if (host === 'localhost' || host.endsWith('.localhost')) {
    if (!options.allowLoopback) {
      throw new BrowserError(`host "${host}" is loopback; allow it via allowLoopback or allowHosts`, 'BROWSER_BLOCKED_URL')
    }
    return
  }
  if (isBlockedAddress(url.hostname)) {
    if (options.allowLoopback && isLoopbackAddress(url.hostname)) return
    throw new BrowserError(`address "${url.hostname}" is private or reserved; add the host to allowHosts to permit it`, 'BROWSER_BLOCKED_URL')
  }
  let records: { address: string }[]
  try {
    // Node >= 17 resolves verbatim (no IPv4-first reordering) by default.
    records = await lookup(host, { all: true })
  } catch {
    return // unresolvable or lookup unavailable: navigation will surface the real failure
  }
  const blocked = records.find(record =>
    isBlockedAddress(record.address) && !(options.allowLoopback && isLoopbackAddress(record.address)),
  )
  if (blocked !== undefined) {
    throw new BrowserError(`host "${host}" resolves to private or reserved address ${blocked.address}; add it to allowHosts to permit it`, 'BROWSER_BLOCKED_URL')
  }
}
