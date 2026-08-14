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

Do not commit proxy credentials or browser WebSocket secrets to the repository. Store them as deployment environment variables.

## Monitoring

`GET /healthz` returns `{ "ok": true }` and can be used as the Railway health-check path.

Extraction errors include a short `requestId` in the API response and server logs, making production failures easier to correlate without logging conversation content.
