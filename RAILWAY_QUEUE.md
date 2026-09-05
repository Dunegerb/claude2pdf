# Railway Free queue strategy

Claude2PDF now uses a two-level in-memory scheduler designed for a small single Railway container.

## Behavior

- Every request starts in the **fast lane**.
- A conversation stays fast if it completes inside the quick processing budget.
- A conversation is promoted to the **heavy lane** when the page clearly exposes a very large message count / page height / text density, or when its fast-lane processing time reaches the budget.
- Only one heavy conversation owns the long-haul slot at a time.
- A heavy conversation yields at bounded browser/CDP checkpoints so one short conversation can pass through without opening a second Chromium process.
- After each short conversation, the heavy conversation receives a guaranteed progress slice before another short conversation may pass. This prevents starvation.
- The scheduler checks Linux cgroup memory pressure before opening the fast-lane page beside a heavy page. Under pressure, safety wins and the quick job remains queued.
- All requests use isolated browser contexts inside one shared Chromium process.
- Disconnecting the loading page removes that request from the queue.
- Queue position is streamed over the existing NDJSON progress response and rendered in the existing loading status line; no extra card or UI block is added.

## Defaults for Railway Free

```env
FAST_LANE_BUDGET_MS=30000
HEAVY_PROGRESS_SLICE_MS=8000
HEAVY_MESSAGE_THRESHOLD=260
HEAVY_SCROLL_HEIGHT_THRESHOLD=120000
HEAVY_SAMPLED_TEXT_THRESHOLD=90000
QUEUE_MEMORY_PRESSURE_PERCENT=82
MAX_QUEUE_DEPTH=25
PUPPETEER_PROTOCOL_TIMEOUT_MS=60000
EXTRACTION_HARD_TIMEOUT_MS=210000
```

These queue values are tuning knobs, not requirements. Start with the defaults and tune only from real Railway logs.

## Queue copy shown to users

The UI deliberately reuses the current shiny status text:

- `You're #3 in line, partner.`
- `Big chat. You're #2 in line, partner.`
- `That is one big ol' conversation. Givin' it the long-haul lane.`

Positions update in place as jobs ahead complete or leave the queue.

## Important limitation

The queue is in-memory because the target deployment is a single small container. A Railway restart clears queued requests. The browser extraction itself remains stateless and conversation content is not persisted by the queue.
