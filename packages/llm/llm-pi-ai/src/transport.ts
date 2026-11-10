/**
 * Transport-activity observation for pi-ai provider streams.
 *
 * pi-ai hands the wire to the pinned OpenAI and Anthropic SDK clients, whose
 * SSE parsers discard comment lines (`: keep-alive`) before any Harness code
 * can see them. Local OpenAI-compatible and Anthropic-style servers keep those
 * comments coming for minutes while processing a prompt, so comment bytes are
 * often the only sign the provider is alive while no stream value is produced.
 * Passing {@link pulsingFetch} as pi-ai's `fetch` option taps the raw response
 * body below the SDK's SSE parser: every received chunk reports activity before
 * the bytes are parsed, which is what rearms the stream idle watchdog during a
 * long prefill. A connection that truly stalls sends nothing, so idle detection
 * keeps its original meaning.
 *
 * pi-ai documents the `fetch` option as not affecting WebSocket transports;
 * those routes keep watchdog behavior driven by stream values alone.
 *
 * @module dsh-llm-pi-ai/transport
 */

/** pi-ai's `fetch` option type: a fetch implementation for provider HTTP requests. */
export type TransportFetch = typeof globalThis.fetch

/**
 * Wrap a fetch implementation so every response-body chunk reports transport
 * activity. The request is forwarded untouched, and the response keeps its
 * status, status text, headers, and bytes; only observation is added.
 * @param base - the fetch implementation to delegate to.
 * @param pulse - called once per received body chunk as the response is read;
 *   must not throw.
 * @returns the observing fetch implementation.
 */
export function pulsingFetch(base: TransportFetch, pulse: () => void): TransportFetch {
  return async (input, init) => {
    const response = await base(input, init)
    // A null body carries nothing to observe, and status codes that forbid a
    // body (204/206/304) cannot be reconstructed through `new Response`.
    if (response.body === null) return response
    const activity = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller): void {
        pulse()
        controller.enqueue(chunk)
      },
    })
    return new Response(response.body.pipeThrough(activity), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  }
}
