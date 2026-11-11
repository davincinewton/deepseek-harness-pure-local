import { describe, expect, it } from 'vitest'
import { pulsingFetch } from '../src/transport.ts'

function bodyFetch(...chunks: (Uint8Array | string)[]): typeof globalThis.fetch {
  const body = new ReadableStream<Uint8Array>({
    start(controller): void {
      const encoder = new TextEncoder()
      for (const chunk of chunks) controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk)
      controller.close()
    },
  })
  return () => Promise.resolve(new Response(body, {
    status: 201,
    statusText: 'Created',
    headers: { 'content-type': 'text/event-stream' },
  }))
}

describe('pulsingFetch', () => {
  it('pulses once per received chunk and forwards status, headers, and bytes', async () => {
    const pulses: number[] = []
    let byteLength = 0
    const response = await pulsingFetch(bodyFetch(': keep-alive\n\n', 'data: 1\n\n', 'data: 2\n\n'), () => {
      pulses.push(pulses.length)
    })(':http://example.invalid/v1/chat/completions')
    const reader = response.body!.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      byteLength += value.byteLength
    }

    expect(pulses).toHaveLength(3)
    expect(byteLength).toBe(new TextEncoder().encode(': keep-alive\n\ndata: 1\n\ndata: 2\n\n').byteLength)
    expect(response.status).toBe(201)
    expect(response.statusText).toBe('Created')
    expect(response.headers.get('content-type')).toBe('text/event-stream')
  })

  it('passes a bodiless response through untouched without pulsing', async () => {
    const original = new Response(null, { status: 204 })
    const wrapped = await pulsingFetch(() => Promise.resolve(original), () => { throw new Error('must not pulse') })(':http://example.invalid')
    expect(wrapped).toBe(original)
  })

  it('forwards the request unchanged, including its signal', async () => {
    const seen: { input: RequestInfo | URL; init: RequestInit | undefined }[] = []
    const controller = new AbortController()
    await pulsingFetch((input, init) => {
      seen.push({ input, init })
      return Promise.resolve(new Response(null, { status: 204 }))
    }, () => {})('http://example.invalid/v1/chat/completions', { method: 'POST', body: '{}', signal: controller.signal })

    expect(seen).toHaveLength(1)
    expect(seen[0]!.input).toBe('http://example.invalid/v1/chat/completions')
    expect(seen[0]!.init?.method).toBe('POST')
    expect(seen[0]!.init?.signal).toBe(controller.signal)
  })
})
