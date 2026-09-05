# Robust extraction deployment notes

The extractor now has three layers:

1. Provider-specific DOM extraction for Claude, ChatGPT, Gemini, Grok, and Qwen.
2. Structured-data recovery from `fetch`/XHR JSON and embedded JSON script data when the provider loads conversation data but changes its DOM.
3. Explicit failure classification for unavailable links, anti-bot/WAF responses, navigation timeouts, and empty app shells.

## Optional production variables

No extra variable is required for normal deployments.

If a provider blocks the Railway/datacenter IP, configure either a proxy or a remote browser. These are optional escape hatches for network-level blocking; selectors cannot solve an IP block.

- `EXTRACTION_PROXY_SERVER` — Chromium proxy server, for example `http://host:port`.
- `EXTRACTION_PROXY_USERNAME` — optional proxy username.
- `EXTRACTION_PROXY_PASSWORD` — optional proxy password.
- `BROWSER_WS_ENDPOINT` — optional Puppeteer-compatible remote browser WebSocket endpoint. When set, the app connects instead of launching local Chromium.
- `DEBUG_EXTRACTION=1` — enables browser console diagnostics. Keep disabled during normal operation.
- `TRUST_PROXY_HOPS` — defaults to `1`, appropriate for Railway's reverse-proxy setup.
- `PUPPETEER_PROTOCOL_TIMEOUT_MS` — defaults to `60000` (60 seconds). Long-conversation collectors are split into shorter bounded calls, so this remains a final CDP safety margin rather than the normal work budget.
- `CLAUDE_COLLECTION_BUDGET_MS` — defaults to `150000` (2.5 minutes) for Claude’s rich-DOM collector.
- `CLAUDE_CAPTURE_BATCH_SIZE` — defaults to `24`; limits how many new/richer Claude turns are cloned in one CDP call.
- `PROVIDER_COLLECTION_BUDGET_MS` — defaults to `150000` (2.5 minutes) for ChatGPT, Gemini, Grok, and Qwen.
- `PROVIDER_CAPTURE_BATCH_SIZE` — defaults to `20`; limits DOM clones per CDP call for ChatGPT, Gemini, Grok, and Qwen.
- `STREAM_HTML_CHUNK_SIZE` — defaults to `262144` bytes; large HTML results are sent to the browser as bounded NDJSON chunks instead of one giant result line.
- `FAST_LANE_BUDGET_MS` — defaults to `30000`; jobs that remain expensive beyond the fast budget are promoted to the heavy queue.
- `HEAVY_PROGRESS_SLICE_MS` — defaults to `8000`; after a quick job passes, the active heavy job gets a guaranteed progress window.
- `QUEUE_MEMORY_PRESSURE_PERCENT` — defaults to `82`; the fast lane will not open a second page beside a heavy page when cgroup memory usage is above this percentage.
- `MAX_QUEUE_DEPTH` — defaults to `25`; caps waiting requests so a tiny deployment cannot accumulate an unbounded number of open queue connections.

Do not commit proxy credentials or browser WebSocket secrets to the repository. Store them as deployment environment variables.

## Monitoring

`GET /healthz` returns `ok`, non-sensitive queue counts, and shared-browser connection status, and can be used as the Railway health-check path.

Extraction errors include a short `requestId` in the API response and server logs, making production failures easier to correlate without logging conversation content.

## Long-conversation and Gemini hardening (August 2026)

- ChatGPT long shared chats are collected from the real `[data-scroll-root]` in both directions. Turn snapshots are refreshed when later hydration produces a longer/richer copy, so a partial assistant response cannot permanently replace its final text.
- The parser compares DOM, network, and embedded-script coverage. A short DOM extraction is no longer considered authoritative merely because it contains one user/assistant pair; the broader conversation sequence wins and matching rich DOM formatting is retained.
- Gemini waits for both prompt and response content and for stable Angular hydration before snapshotting `share-turn-viewer`. Collapsed prompts are expanded before serialization.
- Structured response parsing accepts SSE, Google anti-XSSI JSON and numeric-prefixed React/Next stream chunks.
- Gemini public short links are accepted in the current `g.co/gemini/share/...` format, along with canonical `gemini.google.com/share/...` and `share.gemini.google/...` links.

## Very large Claude conversations (August 2026)

The Claude collector no longer performs the entire scroll/capture/serialization cycle inside one `page.evaluate()`. Large public shares are processed incrementally:

- DOM evidence polling uses `textContent` and bounded samples instead of repeated layout-forcing `innerText` scans.
- Rich Claude turns are cloned only when first seen or when a later copy is measurably richer, and cloning is capped per CDP call.
- When the whole conversation is already mounted, the collector skips a redundant viewport-by-viewport walk and only touches the bottom to trigger lazy hydration.
- Virtualized chats still get a forward pass and a reverse pass when the mounted-window/collected-turn ratio indicates virtualization.
- Final rich HTML crosses the Chrome DevTools Protocol in bounded chunks instead of one giant `Runtime.callFunctionOn` payload.
- If rich-DOM collection still hits a protocol timeout but structured network messages were already captured, extraction falls back to those messages instead of immediately serializing the whole live page again.
- The NDJSON progress response emits a content-free heartbeat every 12 seconds while a long stage is active. This keeps reverse proxies from treating a legitimate long extraction as an idle connection; repeated stage heartbeats do not change the loader copy.

Successful and failed extraction logs include `durationMs` for performance monitoring, but still do not log conversation titles, share IDs, or conversation text.



## Very large conversations across all providers (August 2026)

Long-conversation hardening now applies to every supported provider:

- **Claude** keeps its dedicated rich collector, bounded cloning, virtualization detection, reverse pass, and chunked CDP serialization.
- **ChatGPT** no longer performs the entire scroll/capture/final serialization inside one `page.evaluate()`. Virtualized turn containers are accumulated incrementally and final HTML crosses CDP in bounded chunks.
- **Gemini** captures `share-turn-viewer` incrementally. Prompt text is used as a stable turn key while the response hydrates, preventing a partially rendered response from becoming a duplicate turn.
- **Qwen** captures `.qwen-chat-message` incrementally and wraps the result back into the existing `.share-layout-messages` parser contract.
- **Grok** now has a dedicated long-conversation collector instead of relying only on generic scrolling followed by `page.content()`. User/assistant nodes are accumulated across virtualized windows.
- For every provider, if a protocol timeout occurs after useful structured network messages were already captured, extraction can fall back to that structured conversation without immediately asking Chrome to serialize the giant live page again.
- Large NDJSON results are streamed as `result_start` + bounded `html_chunk` records + `result_end`, with Node stream backpressure respected. The regular JSON API remains unchanged.

The loader reconstructs those chunks only inside the same same-origin extraction response, then passes the complete HTML to the existing provider parser. No new polling endpoint, shared progress store, WebSocket channel, or cross-user state is introduced.
