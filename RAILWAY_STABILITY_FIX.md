# Railway / Puppeteer stability fix

## Root cause found in the supplied Railway logs

The original extraction route launched one full Chromium process for every request and had no concurrency control. Long provider pages could keep those browsers alive for several minutes. Once enough browsers overlapped, Chrome's CDP stopped answering basic setup commands such as `Network.enable` and `Network.setUserAgentOverride`.

The fatal crash was especially important: `puppeteer-extra-plugin-stealth` runs its `user-agent-override` evasion from an async target-created hook. The Railway log showed that hook timing out in `Network.setUserAgentOverride`, followed by a fresh Node application start. Because that hook is not awaited by the extraction route, the route-level try/catch could not reliably contain the failure.

## Changes in this build

1. Disabled only Stealth's `user-agent-override` evasion. The app still applies its own awaited `page.setUserAgent(...)`, so a UA failure remains inside request error handling.
2. Replaced "one request = one Chromium" with one shared Chromium process and isolated browser contexts/pages per extraction.
3. Added a two-level in-memory scheduler: every request starts in the fast lane; clearly expensive or slow work is promoted to the heavy lane.
4. Only one heavy job owns the long-haul slot. A single short job may pass at a safe heavy checkpoint when cgroup memory has headroom.
5. Heavy work receives a guaranteed progress slice between fast-lane jobs so a stream of small requests cannot starve a large conversation.
6. Added live queue positions over the existing NDJSON progress stream. The loader reuses its existing status line instead of adding a new UI component.
7. Reduced the connection-wide Puppeteer protocol timeout default to 60 seconds and kept provider collectors on bounded CDP calls.
8. Added a 210-second active extraction deadline. Time spent waiting in the queue does not consume that processing deadline.
9. Client disconnects remove queued work and close an active page/context.
10. Claude's large-chat collector remains chunked through bounded `Runtime.evaluate` calls instead of one giant `page.evaluate()`.

## Railway Free defaults

No additional environment variables are required. Recommended defaults are already built in:

- `FAST_LANE_BUDGET_MS=30000`
- `HEAVY_PROGRESS_SLICE_MS=8000`
- `HEAVY_MESSAGE_THRESHOLD=260`
- `HEAVY_SCROLL_HEIGHT_THRESHOLD=120000`
- `HEAVY_SAMPLED_TEXT_THRESHOLD=90000`
- `QUEUE_MEMORY_PRESSURE_PERCENT=82`
- `MAX_QUEUE_DEPTH=25`
- `BROWSER_LAUNCH_TIMEOUT_MS=20000`
- `BROWSER_CLOSE_TIMEOUT_MS=8000`
- `EXTRACTION_HARD_TIMEOUT_MS=210000`
- `PUPPETEER_PROTOCOL_TIMEOUT_MS=60000`
- `PROVIDER_COLLECTOR_CALL_TIMEOUT_MS=12000`

Do not re-introduce `MAX_CONCURRENT_EXTRACTIONS`; this build controls concurrency through the queue and the shared browser. Increasing `PUPPETEER_PROTOCOL_TIMEOUT_MS` is not a fix for resource saturation.

## Expected behavior after deploy

A burst no longer returns `SERVER_BUSY`. Requests stay connected, receive queue position updates, and are admitted according to the fast/heavy scheduler. A large extraction can continue making progress while short conversations pass only at bounded checkpoints. Under cgroup memory pressure, the fast page remains queued rather than risking an OOM/restart.

`GET /healthz` now also exposes non-sensitive queue counts and whether the shared browser is connected.
