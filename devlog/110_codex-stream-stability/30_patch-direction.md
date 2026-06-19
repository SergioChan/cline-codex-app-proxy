# 110.30 — Patch Direction

Prioritized, file-level direction for the fixes implied by `10_root-cause-analysis.md`.
This is **direction, not applied code** — implementation is an approval-gated follow-up
phase. Sketches are illustrative; exact line offsets shift as the files evolve.

**Non-goals (explicit):** no WebSockets; no attempt to "force passthrough" for routed models
(structurally impossible — see `10_…` §7 and `20_…`). The invariant to restore: *every
streaming response terminates with exactly one `response.completed` or a classified
`response.failed`, and the upstream is aborted when the client disconnects.*

---

## P0 — Stream lifecycle correctness (highest leverage)

### P0a · RC1 — Guarantee a terminal Responses event (`src/bridge.ts`)

Track whether a terminal event was emitted; if the adapter generator ends without one,
synthesize `response.completed` before closing.

```ts
// bridge.ts — inside start(controller)
let terminated = false;
// set `terminated = true` in case "done" (after emit), case "error" (after emit),
// and in the catch block (after emit).

try {
  for await (const event of events) { /* … existing switch … */ }
} catch (err) {
  /* existing emit("response.failed", …) */            // bridge.ts:298
  terminated = true;
}

if (!terminated) {                                       // NEW — RC1 fix
  if (currentMsg) closeCurrentMessage();
  if (currentReasoning) closeCurrentReasoning();
  if (currentRawReasoning) closeCurrentRawReasoning();
  if (currentToolCall) closeCurrentToolCall();
  emit("response.completed", {
    response: { ...responseSnapshot("completed", finishedItems), usage: responsesUsage(undefined) },
  });
}

emitDone();            // bridge.ts:307 (kept; harmless for Codex)
controller.close();    // bridge.ts:308
```

Defense in depth at the adapter layer — make `anthropic.ts` always yield a terminal `done`
on EOF, mirroring `openai-chat.ts:239`:

```ts
// anthropic.ts — after the read loop, before `finally { reader.releaseLock() }`
yield { type: "done", usage: pendingUsage };   // pendingUsage may be undefined; bridge handles it
```

**Test:** feed `bridgeToResponsesSSE` an event sequence ending **without** `done`/`error`
(e.g. `[{type:"text_delta",text:"hi"}]`) and assert the SSE contains exactly one
`response.completed`.

### P0b · RC2 — Abort upstream on disconnect + never throw on a closed controller

`src/server.ts` — own an `AbortController`, pass its signal to **both** fetches, and let the
returned stream's cancel abort it.

```ts
const ac = new AbortController();
upstreamResponse = await fetch(request.url, { method, headers, body, signal: ac.signal }); // server.ts:179-183 (bridge)
// passthrough fetch (server.ts:145-149) likewise gets `signal: ac.signal`
```

`src/bridge.ts` — accept the controller (or an `onCancel` callback) and add `cancel()`;
guard every enqueue so a closed controller is a no-op, not a throw:

```ts
return new ReadableStream<Uint8Array>({
  async start(controller) {
    const emit = (name, data) => {
      try { controller.enqueue(encoder.encode(sseEvent(name, { type: name, sequence_number: seq++, ...data }))); }
      catch { /* client gone — stop emitting */ }      // NEW — stops the RC2 double-throw
    };
    /* … */
  },
  cancel() { onAbort?.(); },                            // NEW — aborts the upstream fetch
});
```

For the **passthrough** path opencodex returns `upstreamResponse.body` directly; to abort the
upstream on client cancel, pipe it through a pass-through `TransformStream` whose `cancel()`
calls `ac.abort()` (or rely on the runtime propagating cancel to the signalled fetch — verify
in Bun). The minimal, certain win is passing `signal` so an explicit abort is possible.

**Test:** start consuming the bridge stream, call `reader.cancel()`, assert the provided
abort callback fired and no unhandled rejection occurs.

---

## P1 — Stall and passthrough robustness

### P1a · RC3 — Idle heartbeat (`src/bridge.ts`)

Emit an SSE **comment** (`:\n\n`, ignored by the Codex eventsource parser) on an interval
shorter than Codex's `idle_timeout`, reset on every real emit, cleared on close/cancel.

```ts
const HEARTBEAT_MS = 10_000;   // must be < Codex idle_timeout; make configurable
let beat = setInterval(() => { try { controller.enqueue(encoder.encode(":\n\n")); } catch {} }, HEARTBEAT_MS);
const stop = () => clearInterval(beat);
// call stop() before controller.close() and in cancel()
```

**Caveat to verify:** confirm the upstream eventsource lib treats `:`-prefixed lines as
comments (standard SSE does; `responses.rs:474-478` parses `sse.data`, and comment lines
carry no `data:`). Heartbeats must never be mistaken for events.

### P1b · RC5 — Passthrough header regression test (`tests/`)

`sanitizePassthroughHeaders` (`server.ts:241-259`) already drops the stale encoding/length
and hop-by-hop headers (phase 100.5). Add an explicit regression test that
`content-type: text/event-stream` **survives** sanitization and `content-encoding` /
`content-length` are dropped, and document a one-time manual check that Bun auto-decompresses
the passthrough body (if it ever relays raw gzip, dropping `content-encoding` would corrupt
the stream — that case needs different handling).

---

## P2 — Fidelity hardening (lower urgency)

- **`src/errors.ts` — rate-limit classification.** `rate_limit_exceeded` (`errors.ts:26`) is
  not recognized by the Codex parser and degrades to generic `ApiError::Retryable`
  (`responses.rs:369-372`). Acceptable, but consider mapping 503/overload to
  `server_is_overloaded` / `slow_down` (parser-recognized, `responses.rs:577-579`) for
  faithful backoff. Also consider dropping the redundant `last_error` from the bridge
  `response.failed` (`bridge.ts:289-290`) — the parser ignores it.
- **Dropped-frame visibility.** Adapters `catch { continue }` on bad JSON
  (`openai-chat.ts:191-193`, `anthropic.ts:226-229`, `google.ts:142-143`). Add debug/telemetry
  logging so silent truncation is detectable, rather than swallowing frames silently.

---

## Verification plan (for the implementation phase)

1. **Unit (`bun test`):**
   - RC1 terminal-guarantee test (P0a).
   - RC2 cancel/abort test (P0b).
   - RC3 heartbeat-interval test (P1a, can use a fake/short interval).
   - RC5 header-preservation test (P1b).
2. **Static:** `bun x tsc --noEmit` clean; `git diff --check`.
3. **Regression:** full `bun test` stays green (baseline 26 pass / 0 fail).
4. **Live (user environment):** run the Codex CLI against `ocx` with a **routed** model over
   a multi-turn session that includes interrupts; confirm the absence of `ApiError::Stream`
   ("stream closed before response.completed" / "idle timeout") and no leaked upstream
   connections. This is the acceptance gate — the symptom is only fully reproducible with a
   live Codex client.

## Sequencing

P0a + P0b together restore the core invariant and address the most frequent errors; ship
them first behind the unit tests above. P1 follows. P2 is opportunistic. None of this
requires or benefits from a transport change (`20_…`).
