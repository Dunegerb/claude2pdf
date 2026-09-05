const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
    PROVIDER_CONFIG,
    ExtractionError,
    validateShareUrl,
    parsePotentialStructuredBody,
    collectStructuredMessages,
    collectEmbeddedStructuredMessages,
    appendNetworkFallback
} = require('./lib/extraction-utils');

// Ativa o modo invisível do Puppeteer. O evasion `user-agent-override` usa um
// hook assíncrono de target do puppeteer-extra. Se o Chrome/CDP estiver sob
// pressão e `Network.setUserAgentOverride` expirar, essa rejeição pode nascer
// fora do try/catch da rota e derrubar o processo Node inteiro. Mantemos os
// demais evasions e fazemos o UA override explicitamente (e aguardado) abaixo.
const stealthPlugin = StealthPlugin();
stealthPlugin.enabledEvasions.delete('user-agent-override');
puppeteer.use(stealthPlugin);

const app = express();
const PORT = process.env.PORT || 3000;

function boundedEnvInt(name, fallback, min, max) {
    const raw = Number(process.env[name]);
    if (!Number.isFinite(raw)) return fallback;
    return Math.min(max, Math.max(min, Math.round(raw)));
}

// Puppeteer's default protocol timeout is 180s. Long public-share pages can make a
// single CDP serialization expensive, so keep a larger safety margin. All long-
// conversation collectors below are deliberately split into short CDP calls so
// this is a fallback, not the primary long-conversation strategy.
const PUPPETEER_PROTOCOL_TIMEOUT_MS = boundedEnvInt('PUPPETEER_PROTOCOL_TIMEOUT_MS', 60000, 30000, 120000);
const CLAUDE_COLLECTION_BUDGET_MS = boundedEnvInt('CLAUDE_COLLECTION_BUDGET_MS', 150000, 30000, 300000);
const CLAUDE_CAPTURE_BATCH_SIZE = boundedEnvInt('CLAUDE_CAPTURE_BATCH_SIZE', 24, 4, 64);
const PROVIDER_COLLECTION_BUDGET_MS = boundedEnvInt('PROVIDER_COLLECTION_BUDGET_MS', 150000, 30000, 300000);
const PROVIDER_CAPTURE_BATCH_SIZE = boundedEnvInt('PROVIDER_CAPTURE_BATCH_SIZE', 20, 4, 64);
// ChatGPT can expose a very large fully-mounted thread. Keep each V8/CDP unit
// intentionally tiny so one pathological turn cannot monopolize the browser.
// The per-call timeout is enforced by Runtime.evaluate inside Chrome, rather
// than relying only on Puppeteer's much larger connection-wide protocol timeout.
const CHATGPT_CAPTURE_BATCH_SIZE = boundedEnvInt('CHATGPT_CAPTURE_BATCH_SIZE', 6, 1, 16);
const PROVIDER_COLLECTOR_CALL_TIMEOUT_MS = boundedEnvInt('PROVIDER_COLLECTOR_CALL_TIMEOUT_MS', 12000, 3000, 45000);
const PROVIDER_FINAL_CHUNK_CHARS = boundedEnvInt('PROVIDER_FINAL_CHUNK_CHARS', 360000, 100000, 900000);
const STREAM_HTML_CHUNK_SIZE = boundedEnvInt('STREAM_HTML_CHUNK_SIZE', 262144, 65536, 1048576);
const FAST_LANE_BUDGET_MS = boundedEnvInt('FAST_LANE_BUDGET_MS', 30000, 12000, 60000);
const HEAVY_PROGRESS_SLICE_MS = boundedEnvInt('HEAVY_PROGRESS_SLICE_MS', 8000, 2000, 20000);
const HEAVY_MESSAGE_THRESHOLD = boundedEnvInt('HEAVY_MESSAGE_THRESHOLD', 260, 80, 1200);
const HEAVY_SCROLL_HEIGHT_THRESHOLD = boundedEnvInt('HEAVY_SCROLL_HEIGHT_THRESHOLD', 120000, 30000, 500000);
const HEAVY_SAMPLED_TEXT_THRESHOLD = boundedEnvInt('HEAVY_SAMPLED_TEXT_THRESHOLD', 90000, 30000, 190000);
const QUEUE_MEMORY_PRESSURE_PERCENT = boundedEnvInt('QUEUE_MEMORY_PRESSURE_PERCENT', 82, 55, 95);
const MAX_QUEUE_DEPTH = boundedEnvInt('MAX_QUEUE_DEPTH', 25, 5, 200);
const BROWSER_LAUNCH_TIMEOUT_MS = boundedEnvInt('BROWSER_LAUNCH_TIMEOUT_MS', 20000, 5000, 60000);
const BROWSER_CLOSE_TIMEOUT_MS = boundedEnvInt('BROWSER_CLOSE_TIMEOUT_MS', 8000, 2000, 20000);
const EXTRACTION_HARD_TIMEOUT_MS = boundedEnvInt('EXTRACTION_HARD_TIMEOUT_MS', 210000, 60000, 300000);


app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 1));


// Configura EJS como motor de templates
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Carrega os dados de SEO em memória
const seoPagesData = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'seo-pages.json'), 'utf8'));

// ==========================================
// CONFIGURAÇÕES GERAIS E SEGURANÇA
// ==========================================
// Relaxamos o Helmet para evitar bloqueios no ambiente local e no DevTools
app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: false,
}));
app.use(express.json({ limit: '16kb' }));

// Serve os arquivos do Frontend automaticamente (o index.html)
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// PÁGINAS INSTITUCIONAIS
// ==========================================
app.get('/how-it-works', (req, res) => res.render('how-it-works'));
app.get('/features', (req, res) => res.render('features'));
app.get('/privacy', (req, res) => res.render('privacy'));
app.get('/terms', (req, res) => res.render('terms'));

// ==========================================
// ROTAS PROGRAMMATIC SEO
// ==========================================

// Hub de Ferramentas e Guias
app.get('/tools', (req, res) => {
    res.render('tools-index', { pages: seoPagesData });
});

// Páginas de Ferramentas Específicas
app.get('/tools/:slug', (req, res) => {
    const pageData = seoPagesData.find(p => p.slug === req.params.slug);
    if (!pageData) {
        return res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
    }
    res.render('programmatic-seo-page', { 
        data: pageData,
        allPages: seoPagesData
    });
});

// Limita abusos de requisição
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, 
    max: 20,
    message: { error: "Muitas requisições. Tente novamente mais tarde." }
});

async function collectChunkedProviderHTML(page, provider, url, { expectedMessages = 0, checkpoint = null } = {}) {
    // ChatGPT, Gemini, Grok, and Qwen can all expose very large public chats. Keep
    // expensive DOM work inside many short CDP calls instead of one long
    // Runtime.callFunctionOn. State lives only inside this page/request and is
    // deleted immediately after serialization.
    const STATE_KEY = `__c2p${provider.replace(/[^a-z0-9]/gi, '')}CollectorV1`;
    const startedAt = Date.now();

    await page.evaluate(({ stateKey, providerName, sourceUrl, captureBatchSize }) => {
        const normalize = (value) => String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
        const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

        function getScrollTarget() {
            const explicit = document.querySelector('[data-scroll-root]');
            if (explicit) return explicit;

            // Avoid a broad querySelectorAll('[class*="scroll"]') on giant pages:
            // it can inspect thousands of descendants just to discover the scroll
            // root. A handful of likely containers is enough and keeps collector
            // initialization cheap even for very large ChatGPT shares.
            const candidates = [
                document.scrollingElement,
                document.documentElement,
                document.body,
                document.querySelector('main'),
                document.querySelector('[class*="overflow-y-auto"]'),
                document.querySelector('[class*="overflow-y-scroll"]')
            ].filter(Boolean);

            let best = document.scrollingElement || document.documentElement;
            let bestDelta = -1;
            for (const el of candidates) {
                const delta = Math.max(0, (el.scrollHeight || 0) - (el.clientHeight || 0));
                if (delta > bestDelta) {
                    best = el;
                    bestDelta = delta;
                }
            }
            return best;
        }

        function uniqueOutermost(nodes) {
            const set = new Set(nodes.filter(Boolean));
            return Array.from(set).filter((node) => {
                let parent = node.parentElement;
                while (parent) {
                    if (set.has(parent)) return false;
                    parent = parent.parentElement;
                }
                return true;
            });
        }

        function providerNodes() {
            if (providerName === 'chatgpt') {
                const explicit = Array.from(document.querySelectorAll('section[data-turn], article[data-turn], [data-testid^="conversation-turn-"]'));
                if (explicit.length) return uniqueOutermost(explicit);
                return uniqueOutermost(Array.from(document.querySelectorAll('[data-message-author-role="user"], [data-message-author-role="assistant"]')));
            }
            if (providerName === 'gemini') {
                return uniqueOutermost(Array.from(document.querySelectorAll('share-viewer share-turn-viewer, .share-viewer share-turn-viewer, share-turn-viewer, .share-turn-viewer')));
            }
            if (providerName === 'qwen') {
                const exact = Array.from(document.querySelectorAll('.share-layout-messages .qwen-chat-message'));
                if (exact.length) return uniqueOutermost(exact);
                return uniqueOutermost(Array.from(document.querySelectorAll('.share-layout-messages [data-message-author-role="user"], .share-layout-messages [data-message-author-role="assistant"]')));
            }
            if (providerName === 'grok') {
                return uniqueOutermost(Array.from(document.querySelectorAll('[data-testid="user-message"], [data-testid="assistant-message"]')));
            }
            return [];
        }

        function roleFor(node) {
            if (providerName === 'gemini') return 'pair';
            const value = [
                node?.getAttribute?.('data-turn'),
                node?.getAttribute?.('data-message-author-role'),
                node?.getAttribute?.('data-testid'),
                node?.className
            ].filter(Boolean).join(' ');
            if (/user/i.test(value)) return 'user';
            if (/assistant|bot|model|response/i.test(value)) return 'assistant';
            return '';
        }

        function numberFromNode(node) {
            const values = [
                node?.getAttribute?.('data-turn-index'),
                node?.getAttribute?.('data-index'),
                node?.getAttribute?.('data-message-index'),
                node?.getAttribute?.('aria-posinset'),
                node?.getAttribute?.('data-testid'),
                node?.id
            ].filter(Boolean).join(' ');
            const match = values.match(/conversation-turn-(\d+)|(?:turn|message|index)[-_]?(\d+)|\b(\d+)\b/i);
            const numeric = match ? Number(match[1] || match[2] || match[3]) : NaN;
            return Number.isFinite(numeric) ? numeric : null;
        }

        function smallHash(value) {
            const text = String(value || '');
            let hash = 2166136261;
            for (let i = 0; i < text.length; i += 1) {
                hash ^= text.charCodeAt(i);
                hash = Math.imul(hash, 16777619);
            }
            return (hash >>> 0).toString(36);
        }

        function stableBaseKey(node, role, numericOrder) {
            const attrNames = [
                'data-turn-id', 'data-turn-id-container', 'data-message-id', 'data-message-key',
                'data-testid', 'data-id', 'data-key', 'id'
            ];
            for (const attr of attrNames) {
                const value = normalize(node?.getAttribute?.(attr));
                if (value && !/^(user-message|assistant-message)$/i.test(value)) return `id:0:${attr}:${value}`;
            }

            // Some UIs put a message UUID one wrapper above the visible role node.
            // Only trust explicitly message-scoped ancestor attributes; a generic
            // parent id/testid could be shared by the whole thread and collapse a
            // virtualized conversation into the same keys.
            const ancestorAttrs = ['data-turn-id', 'data-turn-id-container', 'data-message-id', 'data-message-key'];
            let candidate = node?.parentElement;
            for (let depth = 1; candidate && depth < 4; depth += 1, candidate = candidate.parentElement) {
                for (const attr of ancestorAttrs) {
                    const value = normalize(candidate?.getAttribute?.(attr));
                    if (value) return `id:${depth}:${attr}:${value}`;
                }
            }

            // Gemini wraps a prompt + response in one turn. The prompt is stable while
            // the response hydrates, so key that pair from the prompt when possible.
            if (providerName === 'gemini') {
                const prompt = node?.querySelector?.('user-query .query-text, user-query-content .query-text, .query-text, .query-text-line');
                const promptText = normalize(prompt?.textContent);
                if (promptText) {
                    const sample = `${promptText.slice(0, 520)}|${promptText.slice(-220)}|${promptText.length}`;
                    return `gemini-prompt:${smallHash(sample)}:${promptText.length}${Number.isFinite(numericOrder) ? `:${numericOrder}` : ''}`;
                }
            }

            const text = normalize(node?.textContent);
            const sample = `${text.slice(0, 520)}|${text.slice(-220)}|${text.length}`;
            return `txt:${role || 'turn'}:${smallHash(sample)}:${text.length}${Number.isFinite(numericOrder) ? `:${numericOrder}` : ''}`;
        }

        function cleanClone(node) {
            const clone = node.cloneNode(true);
            const common = [
                'script', 'style', 'noscript', 'template', 'input', 'textarea', 'select',
                'nav', 'footer', 'aside', 'form', 'iframe', 'canvas', 'audio', 'video',
                '[aria-hidden="true"]', '.sr-only', '.hidden', '[class*="copy-button"]',
                '[class*="popover"]', '[class*="tooltip"]', '[data-testid*="action"]',
                '[data-testid*="copy"]'
            ];
            const extra = providerName === 'gemini'
                ? ['button', '.luminous-actions-container', '.link-action-buttons', '.response-container-header', '.response-container-footer', '[data-test-id="prompt-copy-button"]', '[data-test-id="report-link"]']
                : providerName === 'qwen'
                    ? ['button', 'svg', '[role="button"]', '.message-hoc-container', '.user-message-footer', '.response-message-footer']
                    : [];
            clone.querySelectorAll([...common, ...extra].join(',')).forEach(el => el.remove());

            if (providerName === 'chatgpt' || providerName === 'grok') {
                Array.from(clone.querySelectorAll('button')).forEach((button) => {
                    const label = normalize(`${button.getAttribute('aria-label') || ''} ${button.textContent || ''}`);
                    const keepThought = /thought for|thinking|reasoning/i.test(label) || !!button.closest?.('.thinking-container');
                    if (!keepThought) button.remove();
                });
            }
            return clone;
        }

        function escapeHTML(value) {
            return String(value || '')
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');
        }

        function bestContentNode(nodes) {
            let best = null;
            let bestLength = -1;
            for (const node of Array.from(nodes || [])) {
                if (!node) continue;
                const length = String(node.textContent || '').length;
                if (length > bestLength) {
                    best = node;
                    bestLength = length;
                }
            }
            return best;
        }

        function serializeChatGPTTurn(node, role) {
            if (!node || !role) return '';

            if (role === 'user') {
                const userRoot = node.matches?.('[data-message-author-role="user"]')
                    ? node
                    : node.querySelector?.('[data-message-author-role="user"]');
                const content = bestContentNode([
                    ...(node.querySelectorAll?.('[data-message-author-role="user"] .whitespace-pre-wrap') || []),
                    ...(node.querySelectorAll?.('.user-message-bubble-color .whitespace-pre-wrap') || []),
                    ...(node.querySelectorAll?.('.user-message-bubble-color > div') || []),
                    userRoot
                ]) || node;
                const clone = cleanClone(content);
                return `<section data-turn="user"><div data-message-author-role="user">${clone.outerHTML}</div></section>`;
            }

            const assistantRoots = Array.from(node.querySelectorAll?.('[data-message-author-role="assistant"]') || []);
            if (node.matches?.('[data-message-author-role="assistant"]')) assistantRoots.unshift(node);
            const startRoots = assistantRoots.filter(el => el.getAttribute?.('data-turn-start-message') === 'true');
            const roots = startRoots.length ? startRoots : assistantRoots;
            const candidates = [];
            for (const root of roots) {
                candidates.push(...Array.from(root.querySelectorAll?.('.markdown.prose, .markdown-new-styling, .markdown') || []));
                candidates.push(root);
            }
            if (!candidates.length) {
                candidates.push(...Array.from(node.querySelectorAll?.('.markdown.prose, .markdown-new-styling, .markdown') || []));
            }
            const content = bestContentNode(candidates) || node;
            const clone = cleanClone(content);

            let thought = '';
            for (const button of Array.from(node.querySelectorAll?.('button') || [])) {
                const label = normalize(`${button.getAttribute?.('aria-label') || ''} ${button.textContent || ''}`);
                if (/thought for|thinking|reasoning/i.test(label)) {
                    thought = label.slice(0, 180);
                    break;
                }
            }
            const thoughtMarkup = thought ? `<button>${escapeHTML(thought)}</button>` : '';
            return `<section data-turn="assistant">${thoughtMarkup}<div data-message-author-role="assistant" data-turn-start-message="true">${clone.outerHTML}</div></section>`;
        }

        function serializeLightTurn(node, role) {
            const text = normalize(node?.textContent);
            if (!text || !role) return '';
            return `<section data-turn="${escapeHTML(role)}"><div data-message-author-role="${escapeHTML(role)}"><div class="whitespace-pre-wrap">${escapeHTML(text).replace(/\n/g, '<br>')}</div></div></section>`;
        }

        const state = {
            provider: providerName,
            sourceUrl,
            target: getScrollTarget(),
            turns: new Map(),
            scanEntries: [],
            scanOccurrences: new Map(),
            sequence: 0,
            maxMounted: 0,
            minMounted: Number.POSITIVE_INFINITY,
            batchSize: captureBatchSize,
            maxObservedTop: 0,

            ensureTarget() {
                if (!this.target || !this.target.isConnected) this.target = getScrollTarget();
                return this.target || document.scrollingElement || document.documentElement;
            },

            metrics(extra = {}) {
                const target = this.ensureTarget();
                const top = target?.scrollTop || window.scrollY || 0;
                const height = target?.scrollHeight || document.documentElement.scrollHeight || 0;
                const client = target?.clientHeight || window.innerHeight || 0;
                this.maxObservedTop = Math.max(this.maxObservedTop, top);
                return {
                    collected: this.turns.size,
                    maxMounted: this.maxMounted,
                    minMounted: Number.isFinite(this.minMounted) ? this.minMounted : 0,
                    top,
                    height,
                    client,
                    maxTop: Math.max(0, height - client),
                    ...extra
                };
            },

            clickExpanders(nodes = []) {
                let buttons = [];
                let pattern = null;

                if (this.provider === 'chatgpt') {
                    pattern = /(show more|see more|load more|continue reading|expand response|expand text)/i;
                    // Only inspect buttons inside the currently mounted turns. The
                    // previous global '#thread button, main button' scan revisited
                    // every button in a huge fully-mounted conversation on every
                    // viewport and could dominate collection time.
                    const seenButtons = new Set();
                    for (const node of Array.from(nodes || []).slice(0, 96)) {
                        for (const button of Array.from(node?.querySelectorAll?.('button') || [])) {
                            if (seenButtons.has(button)) continue;
                            seenButtons.add(button);
                            buttons.push(button);
                            if (buttons.length >= 160) break;
                        }
                        if (buttons.length >= 160) break;
                    }
                } else if (this.provider === 'gemini') {
                    pattern = /.*/;
                    buttons = Array.from(document.querySelectorAll('[data-test-id="luminous-expand-button"], button[aria-label="Expand"]')).slice(0, 80);
                }

                if (!pattern || !buttons.length) return 0;
                let clicked = 0;
                for (const button of buttons) {
                    const label = normalize(`${button.getAttribute('aria-label') || ''} ${button.textContent || ''}`);
                    if (!pattern.test(label)) continue;
                    if (/log in|sign up|continue chat|continue conversation/i.test(label)) continue;
                    try { button.click(); clicked += 1; } catch (_) {}
                }
                return clicked;
            },

            beginScan() {
                const nodes = providerNodes();
                this.clickExpanders(nodes);
                this.maxMounted = Math.max(this.maxMounted, nodes.length);
                this.minMounted = Math.min(this.minMounted, nodes.length);

                this.scanOccurrences = new Map();
                this.scanEntries = nodes.map((node) => ({
                    node,
                    role: roleFor(node),
                    orderHint: numberFromNode(node)
                }));
                return { total: this.scanEntries.length, ...this.metrics() };
            },

            captureBatch(cursor = 0, maxClones = this.batchSize) {
                const start = Math.max(0, Number(cursor) || 0);
                const limit = Math.max(1, Math.min(64, Number(maxClones) || this.batchSize));
                const end = Math.min(this.scanEntries.length, start + limit);
                const localOccurrences = new Map();
                const pending = [];

                // Build the whole batch before mutating collector state. If Chrome
                // terminates this execution because one turn is pathological, a retry
                // starts from the same cursor without duplicate occurrence counters.
                for (let index = start; index < end; index += 1) {
                    const entry = this.scanEntries[index];
                    const node = entry?.node;
                    if (!node?.isConnected) continue;
                    const text = normalize(node.textContent);
                    if (!text || !entry.role) continue;
                    const base = stableBaseKey(node, entry.role, entry.orderHint);
                    const occurrence = localOccurrences.has(base)
                        ? localOccurrences.get(base)
                        : (this.scanOccurrences.get(base) || 0);
                    localOccurrences.set(base, occurrence + 1);
                    const key = `${base}:occ:${occurrence}`;
                    const html = this.provider === 'chatgpt'
                        ? serializeChatGPTTurn(node, entry.role)
                        : cleanClone(node).outerHTML;
                    if (!html) continue;
                    pending.push({ key, role: entry.role, html, textLength: text.length, orderHint: entry.orderHint });
                }

                for (const [base, nextOccurrence] of localOccurrences) {
                    this.scanOccurrences.set(base, nextOccurrence);
                }

                let changed = 0;
                for (const item of pending) {
                    const existing = this.turns.get(item.key);
                    if (!existing) {
                        const firstSeen = this.sequence++;
                        this.turns.set(item.key, {
                            role: item.role,
                            html: item.html,
                            textLength: item.textLength,
                            htmlLength: item.html.length,
                            order: item.orderHint ?? firstSeen,
                            firstSeen
                        });
                        changed += 1;
                        continue;
                    }

                    if (item.textLength > existing.textLength || item.html.length > existing.htmlLength * 1.06) {
                        existing.html = item.html;
                        existing.textLength = Math.max(existing.textLength, item.textLength);
                        existing.htmlLength = Math.max(existing.htmlLength, item.html.length);
                        changed += 1;
                    }
                }

                return { next: end, total: this.scanEntries.length, changed, ...this.metrics() };
            },

            captureBatchLight(cursor = 0, maxItems = 2) {
                const start = Math.max(0, Number(cursor) || 0);
                const limit = Math.max(1, Math.min(8, Number(maxItems) || 2));
                const end = Math.min(this.scanEntries.length, start + limit);
                const localOccurrences = new Map();
                const pending = [];

                for (let index = start; index < end; index += 1) {
                    const entry = this.scanEntries[index];
                    const node = entry?.node;
                    if (!node?.isConnected || !entry.role) continue;
                    const text = normalize(node.textContent);
                    if (!text) continue;
                    const base = stableBaseKey(node, entry.role, entry.orderHint);
                    const occurrence = localOccurrences.has(base)
                        ? localOccurrences.get(base)
                        : (this.scanOccurrences.get(base) || 0);
                    localOccurrences.set(base, occurrence + 1);
                    const key = `${base}:occ:${occurrence}`;
                    const html = serializeLightTurn(node, entry.role);
                    if (!html) continue;
                    pending.push({ key, role: entry.role, html, textLength: text.length, orderHint: entry.orderHint });
                }

                for (const [base, nextOccurrence] of localOccurrences) {
                    this.scanOccurrences.set(base, nextOccurrence);
                }

                let changed = 0;
                for (const item of pending) {
                    if (this.turns.has(item.key)) continue;
                    const firstSeen = this.sequence++;
                    this.turns.set(item.key, {
                        role: item.role,
                        html: item.html,
                        textLength: item.textLength,
                        htmlLength: item.html.length,
                        order: item.orderHint ?? firstSeen,
                        firstSeen
                    });
                    changed += 1;
                }

                return { next: end, total: this.scanEntries.length, changed, degraded: true, ...this.metrics() };
            },

            async scrollTo(y, waitMs = 120) {
                const target = this.ensureTarget();
                const requested = Math.max(0, Number(y) || 0);
                try { target.scrollTo?.(0, requested); } catch (_) { window.scrollTo(0, requested); }
                if (waitMs > 0) await sleep(waitMs);
                return this.metrics();
            },

            async scrollDown(waitMs = 150) {
                const target = this.ensureTarget();
                const beforeTop = target?.scrollTop || window.scrollY || 0;
                const client = target?.clientHeight || window.innerHeight || 900;
                const step = Math.max(500, Math.floor(client * 0.82));
                try { target.scrollBy?.(0, step); } catch (_) { window.scrollBy(0, step); }
                if (waitMs > 0) await sleep(waitMs);
                const result = this.metrics({ beforeTop, step });
                result.atBottom = result.top >= result.maxTop - 18 || (result.top === beforeTop && result.maxTop <= beforeTop + 18);
                return result;
            },

            prepareFinal() {
                this.finalTurns = Array.from(this.turns.values()).sort((a, b) => {
                    if (a.order === b.order) return a.firstSeen - b.firstSeen;
                    return a.order - b.order;
                });
                const geminiTitle = document.querySelector('share-viewer .headline strong, .share-viewer .headline strong')?.textContent?.trim() || '';
                const qwenTitle = document.querySelector('.share-layout-title')?.textContent?.trim() || '';
                const date = this.provider === 'gemini'
                    ? document.querySelector('share-viewer .publish-time, .share-viewer .publish-time')?.textContent?.trim() || ''
                    : this.provider === 'qwen'
                        ? document.querySelector('.share-layout-date')?.textContent?.trim() || ''
                        : '';
                return {
                    count: this.finalTurns.length,
                    title: geminiTitle || qwenTitle || document.title || '',
                    canonical: document.querySelector('link[rel="canonical"]')?.getAttribute('href') || this.sourceUrl || '',
                    ogTitle: document.querySelector('meta[property="og:title"]')?.getAttribute('content') || '',
                    ogDescription: document.querySelector('meta[property="og:description"]')?.getAttribute('content') || '',
                    date,
                    lang: document.documentElement.lang || 'en'
                };
            },

            readFinalChunk(offset = 0, maxItems = 10, maxChars = 1400000) {
                const source = Array.isArray(this.finalTurns) ? this.finalTurns : [];
                const items = [];
                let chars = 0;
                let index = Math.max(0, Number(offset) || 0);
                const itemLimit = Math.max(1, Math.min(24, Number(maxItems) || 10));
                const charLimit = Math.max(100000, Math.min(2500000, Number(maxChars) || 1400000));

                while (index < source.length && items.length < itemLimit) {
                    const turn = source[index];
                    const size = String(turn?.html || '').length;
                    if (items.length && chars + size > charLimit) break;
                    items.push({ role: turn.role, html: turn.html });
                    chars += size;
                    index += 1;
                    if (chars >= charLimit) break;
                }
                return { items, next: index, total: source.length };
            }
        };

        window[stateKey] = state;
    }, {
        stateKey: STATE_KEY,
        providerName: provider,
        sourceUrl: url,
        captureBatchSize: provider === 'chatgpt' ? CHATGPT_CAPTURE_BATCH_SIZE : PROVIDER_CAPTURE_BATCH_SIZE
    });

    const collectorSession = await page.createCDPSession();
    await collectorSession.send('Runtime.enable').catch(() => {});

    const callCollector = async (method, ...args) => {
        if (checkpoint) await checkpoint(`${provider}.${method}`);
        const encodedKey = JSON.stringify(STATE_KEY);
        const encodedMethod = JSON.stringify(method);
        const encodedArgs = JSON.stringify(args).replace(/</g, '\\u003c');
        const expression = `(() => { const c = globalThis[${encodedKey}]; if (!c || typeof c[${encodedMethod}] !== 'function') throw new Error('Provider collector state was lost.'); return c[${encodedMethod}](...${encodedArgs}); })()`;

        try {
            const response = await collectorSession.send('Runtime.evaluate', {
                expression,
                awaitPromise: true,
                returnByValue: true,
                timeout: PROVIDER_COLLECTOR_CALL_TIMEOUT_MS,
                userGesture: false
            });
            if (response.exceptionDetails) {
                const detail = response.exceptionDetails.exception?.description ||
                    response.exceptionDetails.text ||
                    'Provider collector execution failed.';
                throw new Error(detail);
            }
            return response.result?.value;
        } catch (error) {
            const message = String(error?.message || error || '');
            if (/timed out|terminated.*timeout|execution.*timeout/i.test(message)) {
                const wrapped = new Error(`${provider}.${method} exceeded ${PROVIDER_COLLECTOR_CALL_TIMEOUT_MS}ms collector deadline.`);
                wrapped.name = 'ProviderCollectorTimeoutError';
                wrapped.code = 'PROVIDER_COLLECTOR_CALL_TIMEOUT';
                wrapped.operation = `${provider}.${method}`;
                wrapped.cause = error;
                throw wrapped;
            }
            if (error && !error.operation) error.operation = `${provider}.${method}`;
            throw error;
        }
    };

    const drainCurrentPosition = async (maxRounds = 512) => {
        const scan = await callCollector('beginScan');
        let cursor = 0;
        let metrics = scan;
        const batchSize = provider === 'chatgpt' ? CHATGPT_CAPTURE_BATCH_SIZE : PROVIDER_CAPTURE_BATCH_SIZE;

        for (let round = 0; cursor < (scan?.total || 0) && round < maxRounds; round += 1) {
            let batch;
            try {
                batch = await callCollector('captureBatch', cursor, batchSize);
            } catch (error) {
                if (provider !== 'chatgpt' || !isProtocolTimeoutError(error)) throw error;

                // One exceptionally complex ChatGPT turn should not kill the entire
                // export. Retry the same cursor with a text-preserving minimal
                // serializer and only two turns per V8 call.
                batch = await callCollector('captureBatchLight', cursor, Math.min(2, batchSize));
            }
            if (!batch || batch.next <= cursor) break;
            cursor = batch.next;
            metrics = batch;
            if (Date.now() - startedAt >= PROVIDER_COLLECTION_BUDGET_MS) break;
        }
        return metrics;
    };

    try {
        await callCollector('scrollTo', 0, 220);
        let metrics = await drainCurrentPosition();
        if (!metrics) return '';

        const expected = Math.max(0, Number(expectedMessages) || 0);
        let likelyFullyMounted = metrics.maxTop <= 20;

        if (!likelyFullyMounted) {
            // Probe the bottom once before deciding whether a full viewport walk is
            // necessary. If new turn keys appear there, the provider is virtualizing
            // or lazy-mounting the conversation and we must walk the range. If the
            // exact same set remains mounted, rescanning every viewport is wasted work.
            const initialCollected = metrics.collected;
            const initialMounted = metrics.maxMounted;
            await callCollector('scrollTo', metrics.maxTop, provider === 'gemini' ? 520 : 360);
            const bottomMetrics = await drainCurrentPosition() || metrics;
            const addedAtBottom = bottomMetrics.collected > initialCollected;
            const expectedCovered = expected > 0 && bottomMetrics.collected >= Math.max(2, Math.floor(expected * 0.82));
            const sameMountedSet = !addedAtBottom && bottomMetrics.maxMounted === initialMounted;
            likelyFullyMounted = !addedAtBottom && (expectedCovered || sameMountedSet);

            await callCollector('scrollTo', 0, 160);
            metrics = await drainCurrentPosition() || bottomMetrics;
        }

        if (!likelyFullyMounted) {
            let stableBottom = 0;
            let previousSignature = '';
            const maxForwardSteps = 420;
            const stepWait = provider === 'gemini' ? 260 : (provider === 'chatgpt' ? 220 : 180);

            for (let i = 0; i < maxForwardSteps && Date.now() - startedAt < PROVIDER_COLLECTION_BUDGET_MS; i += 1) {
                const moved = await callCollector('scrollDown', stepWait);
                metrics = await drainCurrentPosition(64) || moved;
                const signature = `${metrics.collected}:${metrics.height}:${Math.round(metrics.top)}`;
                if (moved.atBottom && signature === previousSignature) stableBottom += 1;
                else stableBottom = 0;
                previousSignature = signature;

                if (moved.atBottom && stableBottom === 0) {
                    await callCollector('scrollTo', moved.maxTop, provider === 'gemini' ? 600 : 420);
                    metrics = await drainCurrentPosition(64) || metrics;
                }
                if (stableBottom >= 2) break;
            }

            // A reverse pass matters only when the number collected is materially
            // larger than the mounted window, which signals DOM virtualization.
            const virtualized = metrics && metrics.maxMounted > 0 &&
                metrics.collected > Math.max(metrics.maxMounted + 6, Math.floor(metrics.maxMounted * 1.25));
            if (virtualized && Date.now() - startedAt < PROVIDER_COLLECTION_BUDGET_MS) {
                const reverseStep = Math.max(520, Math.floor((metrics.client || 900) * 0.95));
                let reverseRounds = 0;
                for (let pos = metrics.maxTop; pos > 0 && reverseRounds < 180 && Date.now() - startedAt < PROVIDER_COLLECTION_BUDGET_MS; pos -= reverseStep) {
                    reverseRounds += 1;
                    await callCollector('scrollTo', pos, 100);
                    metrics = await drainCurrentPosition(48) || metrics;
                }
            }

            await callCollector('scrollTo', 0, 160);
            await drainCurrentPosition(48);
        }

        const meta = await callCollector('prepareFinal');
        if (!meta?.count) return '';

        const chunks = [];
        let offset = 0;
        const finalItemsPerCall = provider === 'chatgpt' ? 4 : 10;
        const finalCharsPerCall = provider === 'chatgpt'
            ? PROVIDER_FINAL_CHUNK_CHARS
            : Math.min(900000, PROVIDER_FINAL_CHUNK_CHARS * 2);

        while (offset < meta.count) {
            const chunk = await callCollector('readFinalChunk', offset, finalItemsPerCall, finalCharsPerCall);
            if (!chunk?.items?.length || chunk.next <= offset) break;
            chunks.push(...chunk.items);
            offset = chunk.next;
        }
        if (!chunks.length) return '';

        const escapeAttr = (value) => String(value || '')
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/</g, '&lt;');
        const body = chunks.map(item => item.html).join('\n');
        const head = `<title>${escapeAttr(meta.title)}</title>` +
            `<link rel="canonical" href="${escapeAttr(meta.canonical)}">` +
            (meta.ogTitle ? `<meta property="og:title" content="${escapeAttr(meta.ogTitle)}">` : '') +
            (meta.ogDescription ? `<meta property="og:description" content="${escapeAttr(meta.ogDescription)}">` : '');

        if (provider === 'chatgpt') {
            return `<!doctype html><html lang="${escapeAttr(meta.lang)}"><head>${head}</head><body>` +
                `<main id="c2p-collected-chatgpt" data-provider="chatgpt" data-collected-turns="${chunks.length}">${body}</main></body></html>`;
        }
        if (provider === 'gemini') {
            return `<!doctype html><html lang="${escapeAttr(meta.lang)}"><head>${head}</head><body>` +
                `<div class="publish-time">${escapeAttr(meta.date)}</div><main id="c2p-collected-gemini" data-provider="gemini" data-collected-turns="${chunks.length}">` +
                `<share-viewer>${body}</share-viewer></main></body></html>`;
        }
        if (provider === 'qwen') {
            return `<!doctype html><html lang="${escapeAttr(meta.lang)}"><head>${head}</head><body>` +
                `<div class="share-layout-title">${escapeAttr(meta.title)}</div><div class="share-layout-date">${escapeAttr(meta.date)}</div>` +
                `<div class="share-layout-messages" data-provider="qwen" data-collected-turns="${chunks.length}">${body}</div></body></html>`;
        }
        if (provider === 'grok') {
            return `<!doctype html><html lang="${escapeAttr(meta.lang)}"><head>${head}</head><body>` +
                `<main id="c2p-collected-grok" data-provider="grok" data-collected-turns="${chunks.length}">${body}</main></body></html>`;
        }
        return '';
    } finally {
        // Do not use page.evaluate() for cleanup after a collector timeout; that
        // would create another Runtime.callFunctionOn while Chrome may still be
        // recovering. Reuse the bounded CDP session instead.
        await collectorSession.send('Runtime.evaluate', {
            expression: `try { delete globalThis[${JSON.stringify(STATE_KEY)}]; } catch (_) {}`,
            returnByValue: true,
            timeout: 2000
        }).catch(() => {});
        await collectorSession.detach().catch(() => {});
    }
}

async function collectChatGPTHTML(page, url, options = {}) {
    return collectChunkedProviderHTML(page, 'chatgpt', url, options);
}

async function collectClaudeHTML(page, url, { expectedMessages = 0, checkpoint = null } = {}) {
    // Claude chats can be enormous. The old collector performed the entire scroll,
    // repeated DOM scans, cloning, and final serialization inside one page.evaluate().
    // On very large conversations that kept one Runtime.callFunctionOn open long
    // enough to hit Puppeteer's protocol timeout. This collector keeps state in the
    // page, but advances it through many short CDP calls and clones only new/richer
    // turns in bounded batches.
    const STATE_KEY = '__c2pClaudeCollectorV3';
    const startedAt = Date.now();

    await page.evaluate(({ stateKey, sourceUrl, captureBatchSize }) => {
        const normalize = (value) => String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
        const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
        const turnSelector = [
            '[data-testid="user-message"]', '[class*="font-user-message"]', '[data-message-author-role="user"]',
            '.font-claude-response', '[class*="font-claude-message"]', '[data-testid="assistant-message"]', '[data-message-author-role="assistant"]'
        ].join(',');
        const assistantRootSelector = '.font-claude-response, [class*="font-claude-message"], [data-testid="assistant-message"], [data-message-author-role="assistant"]';
        const richSelector = 'strong,b,em,i,h1,h2,h3,h4,h5,h6,ul,ol,li,pre,code,table,blockquote,math,.katex,.MathJax,[class*="math"]';

        function getScrollTarget() {
            const candidates = [
                document.scrollingElement,
                document.documentElement,
                document.body,
                ...Array.from(document.querySelectorAll('main, [class*="overflow-y-auto"], [class*="overflow-y-scroll"], [class*="scroll"]'))
            ].filter(Boolean);
            return candidates
                .map((el) => ({ el, delta: Math.max(0, (el.scrollHeight || 0) - (el.clientHeight || 0)) }))
                .sort((a, b) => b.delta - a.delta)[0]?.el || document.scrollingElement || document.documentElement;
        }

        function roleFor(node) {
            if (!node) return '';
            if (node.matches?.('[data-testid="user-message"], [class*="font-user-message"], [data-message-author-role="user"]')) return 'user';
            if (node.matches?.(assistantRootSelector)) return 'assistant';
            return '';
        }

        function contentFor(node, role) {
            if (role !== 'assistant') return node;
            if (node.matches?.('.font-claude-response, [class*="font-claude-message"]')) return node;
            return node.closest?.('.font-claude-response, [class*="font-claude-message"]') ||
                node.querySelector?.('.standard-markdown, .progressive-markdown, [class*="markdown"]') || node;
        }

        function isNestedDuplicate(node, role) {
            if (role === 'assistant') {
                const preferred = '.font-claude-response, [class*="font-claude-message"]';
                if (node.parentElement?.closest?.(preferred)) return true;
                if (node.matches?.('[data-testid="assistant-message"], [data-message-author-role="assistant"]') && node.querySelector?.(preferred)) return true;
                return false;
            }
            if (role === 'user') {
                const preferred = '[data-testid="user-message"], [class*="font-user-message"]';
                if (node.parentElement?.closest?.(preferred)) return true;
                if (node.matches?.('[data-message-author-role="user"]') && node.querySelector?.(preferred)) return true;
            }
            return false;
        }

        function semanticRichness(node) {
            if (!node?.querySelectorAll) return 0;
            const weighted = [
                ['strong,b', 8], ['em,i', 5], ['h1,h2,h3,h4,h5,h6', 6],
                ['ul,ol,li', 4], ['pre', 10], ['code', 5], ['table', 10],
                ['blockquote', 6], ['math,.katex,.MathJax,[class*="math"]', 12]
            ];
            return weighted.reduce((score, [selector, weight]) => {
                let count = 0;
                try { count = node.querySelectorAll(selector).length; } catch (_) {}
                return score + Math.min(count, 50) * weight;
            }, 0);
        }

        function cleanClone(node) {
            const clone = node.cloneNode(true);
            clone.querySelectorAll([
                'script', 'style', 'noscript', 'template', 'textarea', 'select',
                'iframe', 'canvas', 'audio', 'video', 'form',
                'input:not([type="checkbox"])', 'button', '[role="button"]',
                '[class*="copy-button"]', '[class*="popover"]', '[class*="tooltip"]'
            ].join(',')).forEach(el => el.remove());
            return clone;
        }

        const target = getScrollTarget();
        const viewport = Math.max(650, target?.clientHeight || window.innerHeight || 900);
        const state = {
            version: 3,
            sourceUrl,
            target,
            step: Math.max(480, Math.floor(viewport * 0.82)),
            turns: new Map(),
            sequence: 0,
            capturePass: 0,
            maxMounted: 0,
            minMounted: Number.POSITIVE_INFINITY,
            batchSize: captureBatchSize,

            metrics(extra = {}) {
                const currentTarget = this.target || document.scrollingElement || document.documentElement;
                const top = currentTarget?.scrollTop || window.scrollY || 0;
                const height = currentTarget?.scrollHeight || document.documentElement.scrollHeight || 0;
                const client = currentTarget?.clientHeight || window.innerHeight || 0;
                return {
                    collected: this.turns.size,
                    maxMounted: this.maxMounted,
                    minMounted: Number.isFinite(this.minMounted) ? this.minMounted : 0,
                    top,
                    height,
                    client,
                    maxTop: Math.max(0, height - client),
                    step: this.step,
                    ...extra
                };
            },

            capture(maxClones = this.batchSize) {
                this.capturePass += 1;
                const occurrences = new Map();
                const nodes = Array.from(document.querySelectorAll(turnSelector));
                let mounted = 0;
                let changed = 0;
                let cloned = 0;
                let pending = 0;

                for (const node of nodes) {
                    const role = roleFor(node);
                    if (!role || isNestedDuplicate(node, role)) continue;
                    const content = contentFor(node, role);
                    const text = normalize(content?.textContent || '');
                    if (!text) continue;
                    mounted += 1;

                    // A stable prefix survives normal hydration while avoiding the huge
                    // full-text keys that made repeated scans expensive. Occurrence keeps
                    // intentionally repeated short messages distinct within a viewport.
                    const base = `${role}:${text.slice(0, 320)}`;
                    const occurrence = occurrences.get(base) || 0;
                    occurrences.set(base, occurrence + 1);
                    const key = `${base}:${occurrence}`;
                    const existing = this.turns.get(key);

                    let shouldClone = !existing || text.length > existing.textLength + 8;
                    let quickMarkupCount = existing?.markupCount || 0;
                    if (!shouldClone && this.capturePass % 6 === 0) {
                        try { quickMarkupCount = content.querySelectorAll(richSelector).length; } catch (_) {}
                        if (quickMarkupCount > (existing?.markupCount || 0)) shouldClone = true;
                    }
                    if (!shouldClone) continue;

                    if (cloned >= maxClones) {
                        pending += 1;
                        continue;
                    }

                    const clone = cleanClone(content);
                    const html = clone.outerHTML;
                    const richness = semanticRichness(clone);
                    if (!quickMarkupCount) {
                        try { quickMarkupCount = clone.querySelectorAll(richSelector).length; } catch (_) {}
                    }
                    const order = existing?.order ?? this.sequence++;

                    if (!existing || text.length >= existing.textLength || richness >= existing.richness || html.length > existing.html.length * 1.05) {
                        this.turns.set(key, {
                            role,
                            html,
                            richness,
                            markupCount: quickMarkupCount,
                            textLength: text.length,
                            order
                        });
                        changed += 1;
                    }
                    cloned += 1;
                }

                this.maxMounted = Math.max(this.maxMounted, mounted);
                this.minMounted = Math.min(this.minMounted, mounted);
                return this.metrics({ mounted, changed, cloned, pending });
            },

            async scrollTo(y, settleMs = 120) {
                const currentTarget = this.target || document.scrollingElement || document.documentElement;
                try { currentTarget?.scrollTo?.(0, Math.max(0, y)); } catch (_) { window.scrollTo(0, Math.max(0, y)); }
                await sleep(settleMs);
                return this.metrics();
            },

            async scrollDown(settleMs = 140) {
                const currentTarget = this.target || document.scrollingElement || document.documentElement;
                const beforeTop = currentTarget?.scrollTop || window.scrollY || 0;
                try { currentTarget?.scrollBy?.(0, this.step); } catch (_) { window.scrollBy(0, this.step); }
                await sleep(settleMs);
                const result = this.metrics({ beforeTop });
                result.atBottom = result.top >= result.maxTop - 16 || result.top === beforeTop;
                return result;
            },

            prepareFinal() {
                this.finalTurns = Array.from(this.turns.values()).sort((a, b) => a.order - b.order);
                return {
                    count: this.finalTurns.length,
                    title: document.querySelector('meta[property="og:title"]')?.getAttribute('content') || document.title || '',
                    canonical: document.querySelector('link[rel="canonical"]')?.getAttribute('href') || this.sourceUrl || '',
                    lang: document.documentElement.lang || 'en'
                };
            },

            readFinalChunk(offset = 0, maxItems = 12, maxChars = 1500000) {
                const source = Array.isArray(this.finalTurns) ? this.finalTurns : [];
                const items = [];
                let chars = 0;
                let index = Math.max(0, Number(offset) || 0);
                const itemLimit = Math.max(1, Math.min(24, Number(maxItems) || 12));
                const charLimit = Math.max(100000, Math.min(3000000, Number(maxChars) || 1500000));

                while (index < source.length && items.length < itemLimit) {
                    const turn = source[index];
                    const size = String(turn?.html || '').length;
                    if (items.length && chars + size > charLimit) break;
                    items.push({ role: turn.role, richness: turn.richness, html: turn.html });
                    chars += size;
                    index += 1;
                    if (chars >= charLimit) break;
                }
                return { items, next: index, total: source.length };
            }
        };

        window[stateKey] = state;
    }, { stateKey: STATE_KEY, sourceUrl: url, captureBatchSize: CLAUDE_CAPTURE_BATCH_SIZE });

    // Use the same bounded CDP execution model as the other providers. The old
    // Claude path used page.evaluate() here, so each batch could inherit the full
    // connection-wide protocol timeout (previously 300s). One pathological DOM
    // batch could therefore pin a whole Chrome process for minutes.
    const collectorSession = await page.createCDPSession();
    await collectorSession.send('Runtime.enable').catch(() => {});

    const callCollector = async (method, ...args) => {
        if (checkpoint) await checkpoint(`claude.${method}`);
        const encodedKey = JSON.stringify(STATE_KEY);
        const encodedMethod = JSON.stringify(method);
        const encodedArgs = JSON.stringify(args).replace(/</g, '\\u003c');
        const expression = `(() => { const c = globalThis[${encodedKey}]; if (!c || typeof c[${encodedMethod}] !== 'function') throw new Error('Claude collector state was lost.'); return c[${encodedMethod}](...${encodedArgs}); })()`;

        try {
            const response = await collectorSession.send('Runtime.evaluate', {
                expression,
                awaitPromise: true,
                returnByValue: true,
                timeout: PROVIDER_COLLECTOR_CALL_TIMEOUT_MS,
                userGesture: false
            });
            if (response.exceptionDetails) {
                const detail = response.exceptionDetails.exception?.description ||
                    response.exceptionDetails.text ||
                    'Claude collector execution failed.';
                throw new Error(detail);
            }
            return response.result?.value;
        } catch (error) {
            const message = String(error?.message || error || '');
            if (/timed out|terminated.*timeout|execution.*timeout/i.test(message)) {
                const wrapped = new Error(`claude.${method} exceeded ${PROVIDER_COLLECTOR_CALL_TIMEOUT_MS}ms collector deadline.`);
                wrapped.name = 'ProviderCollectorTimeoutError';
                wrapped.code = 'PROVIDER_COLLECTOR_CALL_TIMEOUT';
                wrapped.operation = `claude.${method}`;
                wrapped.cause = error;
                throw wrapped;
            }
            if (error && !error.operation) error.operation = `claude.${method}`;
            throw error;
        }
    };

    const drainCurrentPosition = async (maxRounds = 96) => {
        let metrics = null;
        for (let round = 0; round < maxRounds; round += 1) {
            metrics = await callCollector('capture', CLAUDE_CAPTURE_BATCH_SIZE);
            if (!metrics?.pending) return metrics;
            if (Date.now() - startedAt >= CLAUDE_COLLECTION_BUDGET_MS) return metrics;
            // Yield to Chrome/Node between bounded batches instead of monopolizing one
            // Runtime.callFunctionOn for the whole conversation.
            await delay(0);
        }
        return metrics;
    };

    try {
        await callCollector('scrollTo', 0, 280);
        let metrics = await drainCurrentPosition();
        if (!metrics?.collected) return '';

        const expected = Math.max(0, Number(expectedMessages) || 0);
        const likelyFullyMounted = (
            (expected >= 8 && metrics.collected >= Math.max(2, Math.floor(expected * 0.82))) ||
            (metrics.maxMounted >= 120 && metrics.collected === metrics.maxMounted)
        );

        if (likelyFullyMounted) {
            // Claude frequently keeps the whole shared chat mounted. For hundreds of
            // turns, walking every viewport only re-scans the same DOM. Touch the bottom
            // once to trigger any lazy hydration, capture changes, then return to top.
            await callCollector('scrollTo', metrics.maxTop, 420);
            metrics = await drainCurrentPosition();
            await callCollector('scrollTo', 0, 180);
            metrics = await drainCurrentPosition();
        } else {
            let stableBottom = 0;
            let previousSignature = '';
            const maxForwardSteps = 420;

            for (let i = 0; i < maxForwardSteps && Date.now() - startedAt < CLAUDE_COLLECTION_BUDGET_MS; i += 1) {
                const moved = await callCollector('scrollDown', 140);
                metrics = await drainCurrentPosition(32) || moved;
                const signature = `${metrics.collected}:${metrics.height}:${Math.round(metrics.top)}`;

                if (moved.atBottom && signature === previousSignature) stableBottom += 1;
                else stableBottom = 0;
                previousSignature = signature;
                if (stableBottom >= 2) break;
            }

            // Reverse only when the number of distinct collected turns is materially
            // larger than the mounted window, which is strong evidence of virtualization.
            const virtualized = metrics && metrics.maxMounted > 0 && metrics.collected > Math.max(metrics.maxMounted + 8, Math.floor(metrics.maxMounted * 1.35));
            if (virtualized && Date.now() - startedAt < CLAUDE_COLLECTION_BUDGET_MS) {
                const reverseStep = Math.max(520, Math.floor((metrics.step || 700) * 1.15));
                for (let pos = metrics.maxTop; pos > 0 && Date.now() - startedAt < CLAUDE_COLLECTION_BUDGET_MS; pos -= reverseStep) {
                    await callCollector('scrollTo', pos, 90);
                    metrics = await drainCurrentPosition(24);
                }
            }

            await callCollector('scrollTo', 0, 160);
            await drainCurrentPosition(24);
        }

        const meta = await callCollector('prepareFinal');
        if (!meta?.count) return '';

        const escapeAttr = (value) => String(value || '')
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/</g, '&lt;');
        const sections = [];
        let offset = 0;
        while (offset < meta.count) {
            const chunk = await callCollector('readFinalChunk', offset, 12, 1500000);
            if (!chunk?.items?.length || chunk.next <= offset) break;
            chunk.items.forEach((turn, chunkIndex) => {
                const index = offset + chunkIndex;
                sections.push(
                    `<section data-c2p-claude-turn="${index}" data-message-author-role="${turn.role}" data-c2p-richness="${turn.richness}">` +
                    `<div class="c2p-claude-content">${turn.html}</div></section>`
                );
            });
            offset = chunk.next;
        }

        if (!sections.length) return '';
        return `<!doctype html><html lang="${escapeAttr(meta.lang)}"><head>` +
            `<title>${escapeAttr(meta.title)}</title><link rel="canonical" href="${escapeAttr(meta.canonical)}">` +
            `<meta property="og:title" content="${escapeAttr(meta.title)}"></head>` +
            `<body><main id="c2p-collected-claude" data-provider="claude" data-collected-turns="${sections.length}">${sections.join('\n')}</main></body></html>`;
    } finally {
        // Never start a fresh page.evaluate() after a collector timeout. Reuse the
        // bounded CDP session, then detach it regardless of Chrome health.
        await collectorSession.send('Runtime.evaluate', {
            expression: `try { delete globalThis[${JSON.stringify(STATE_KEY)}]; } catch (_) {}`,
            returnByValue: true,
            timeout: 2000
        }).catch(() => {});
        await collectorSession.detach().catch(() => {});
    }
}

async function collectGeminiHTML(page, url, options = {}) {
    return collectChunkedProviderHTML(page, 'gemini', url, options);
}

async function collectQwenHTML(page, url, options = {}) {
    return collectChunkedProviderHTML(page, 'qwen', url, options);
}

async function collectGrokHTML(page, url, options = {}) {
    return collectChunkedProviderHTML(page, 'grok', url, options);
}


// ==========================================
// EXTRACTION HELPERS
// ==========================================
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function closeBrowserSafely(browser, remoteBrowser = false) {
    if (!browser) return;
    if (remoteBrowser) {
        try { browser.disconnect(); } catch (_) {}
        return;
    }

    const processHandle = typeof browser.process === 'function' ? browser.process() : null;
    let timer;
    try {
        await Promise.race([
            Promise.resolve(browser.close()).catch(() => {}),
            new Promise((resolve) => {
                timer = setTimeout(resolve, BROWSER_CLOSE_TIMEOUT_MS);
                timer.unref?.();
            })
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }

    // If CDP was wedged, browser.close() can return late or fail to reap Chrome.
    // A leftover Chrome is worse than a failed extraction in a small container.
    if (processHandle && !processHandle.killed && processHandle.exitCode == null) {
        try { processHandle.kill('SIGKILL'); } catch (_) {}
    }
}


class QueuePromotionError extends Error {
    constructor(reason = 'heavy') {
        super(`Conversation promoted to the heavy queue (${reason}).`);
        this.name = 'QueuePromotionError';
        this.code = 'QUEUE_PROMOTION';
        this.reason = reason;
    }
}

function createDeferred() {
    let resolve;
    let reject;
    let settled = false;
    const promise = new Promise((res, rej) => {
        resolve = (value) => {
            if (settled) return;
            settled = true;
            res(value);
        };
        reject = (error) => {
            if (settled) return;
            settled = true;
            rej(error);
        };
    });
    return { promise, resolve, reject, get settled() { return settled; } };
}

function readCgroupMemoryRatio() {
    const candidates = [
        ['/sys/fs/cgroup/memory.current', '/sys/fs/cgroup/memory.max'],
        ['/sys/fs/cgroup/memory/memory.usage_in_bytes', '/sys/fs/cgroup/memory/memory.limit_in_bytes']
    ];
    for (const [currentPath, maxPath] of candidates) {
        try {
            const currentRaw = fs.readFileSync(currentPath, 'utf8').trim();
            const maxRaw = fs.readFileSync(maxPath, 'utf8').trim();
            if (!currentRaw || !maxRaw || maxRaw === 'max') continue;
            const current = Number(currentRaw);
            const max = Number(maxRaw);
            if (Number.isFinite(current) && Number.isFinite(max) && max > 0) {
                return Math.max(0, Math.min(1, current / max));
            }
        } catch (_) {}
    }
    return null;
}

class ExtractionScheduler {
    constructor({ memoryRatioReader = readCgroupMemoryRatio } = {}) {
        this.memoryRatioReader = memoryRatioReader;
        this.quickQueue = [];
        this.heavyQueue = [];
        this.activeQuick = null;
        this.activeHeavy = null;
        this.changeWaiters = new Set();
        this.heavyAtCheckpoint = false;
        this.heavyPriorityUntil = 0;
        this.pumpTimer = null;
    }

    createJob({ requestId, provider, sendProgress }) {
        return {
            requestId,
            provider,
            sendProgress,
            lane: 'new',
            state: 'new',
            cancelled: false,
            quickDeferred: null,
            heavyDeferred: null,
            quickStartedAt: 0,
            heavyReason: '',
            currentOperation: 'queue',
            abortAttempt: null
        };
    }

    _signalChange() {
        const waiters = Array.from(this.changeWaiters);
        this.changeWaiters.clear();
        waiters.forEach(resolve => resolve());
    }

    _waitForChange() {
        return new Promise(resolve => this.changeWaiters.add(resolve));
    }

    _removeFromQueue(queue, job) {
        const index = queue.indexOf(job);
        if (index !== -1) queue.splice(index, 1);
    }

    _canRunQuickAlongsideHeavy() {
        if (!this.activeHeavy) return true;
        // Never admit a fast-lane page in the middle of a heavy CDP operation.
        // Heavy work explicitly opens a yield point at bounded checkpoints.
        if (!this.heavyAtCheckpoint) return false;
        if (Date.now() < this.heavyPriorityUntil) return false;
        const ratio = this.memoryRatioReader?.();
        if (ratio == null) return true;
        return ratio * 100 < QUEUE_MEMORY_PRESSURE_PERCENT;
    }

    _schedulePump(delayMs = 1000) {
        if (this.pumpTimer) return;
        this.pumpTimer = setTimeout(() => {
            this.pumpTimer = null;
            this._pump();
        }, Math.max(50, delayMs));
        this.pumpTimer.unref?.();
    }

    _notifyPositions() {
        this.quickQueue.forEach((job, index) => {
            if (job.cancelled) return;
            const position = (this.activeQuick ? 1 : 0) + index + 1;
            job.sendProgress?.('queued', { position, lane: 'quick' });
        });
        this.heavyQueue.forEach((job, index) => {
            if (job.cancelled) return;
            const position = (this.activeHeavy ? 1 : 0) + index + 1;
            job.sendProgress?.('queued', { position, lane: 'heavy' });
        });
    }

    _grantQuick(job) {
        this.activeQuick = job;
        job.state = 'active';
        job.lane = 'quick';
        job.quickStartedAt = Date.now();
        job.quickDeferred?.resolve();
        this._signalChange();
    }

    _grantHeavy(job) {
        this.activeHeavy = job;
        this.heavyAtCheckpoint = false;
        job.state = 'active';
        job.lane = 'heavy';
        job.heavyDeferred?.resolve();
        this._signalChange();
    }

    _pump() {
        this.quickQueue = this.quickQueue.filter(job => !job.cancelled);
        this.heavyQueue = this.heavyQueue.filter(job => !job.cancelled);

        // A queued heavy job gets the long-haul slot as soon as the current fast
        // pass finishes. Once it owns that slot, a new quick pass may run beside it
        // in the same Chromium process when container memory has enough headroom.
        if (!this.activeHeavy && !this.activeQuick && this.heavyQueue.length) {
            this._grantHeavy(this.heavyQueue.shift());
        }

        if (!this.activeQuick && this.quickQueue.length) {
            if (this._canRunQuickAlongsideHeavy()) {
                this._grantQuick(this.quickQueue.shift());
            } else if (this.activeHeavy) {
                const sliceWait = Math.max(0, this.heavyPriorityUntil - Date.now());
                // Re-check both the guaranteed heavy slice and cgroup memory pressure.
                this._schedulePump(sliceWait > 0 ? Math.min(sliceWait + 25, 1500) : 1500);
            }
        }

        this._notifyPositions();
    }

    async enqueueQuick(job) {
        if (job.cancelled) throw new ExtractionError('The extraction request was cancelled.', { status: 499, code: 'CLIENT_DISCONNECTED' });
        if (this.quickQueue.length + this.heavyQueue.length >= MAX_QUEUE_DEPTH) {
            throw new ExtractionError('The conversion line is full right now. Please try again in a bit.', {
                status: 503,
                code: 'QUEUE_FULL'
            });
        }
        job.lane = 'quick_queue';
        job.state = 'queued';
        job.quickDeferred = createDeferred();
        this.quickQueue.push(job);
        this._notifyPositions();
        this._pump();
        return job.quickDeferred.promise;
    }

    promoteOrQueue(job, reason = 'heavy') {
        if (job.cancelled) throw new ExtractionError('The extraction request was cancelled.', { status: 499, code: 'CLIENT_DISCONNECTED' });
        if (job.lane === 'heavy' || job.lane === 'heavy_queue') return job.lane === 'heavy' ? 'promoted' : 'queued';
        if (this.activeQuick !== job) return 'unchanged';

        job.heavyReason = reason;
        job.sendProgress?.('long_chat_detected', { reason });
        this.activeQuick = null;

        if (!this.activeHeavy) {
            this.activeHeavy = job;
            job.lane = 'heavy';
            job.state = 'active';
            this._signalChange();
            this._pump();
            return 'promoted';
        }

        job.lane = 'heavy_queue';
        job.state = 'queued';
        job.heavyDeferred = createDeferred();
        this.heavyQueue.push(job);
        this._signalChange();
        this._notifyPositions();
        this._pump();
        return 'queued';
    }

    async waitForHeavy(job) {
        if (job.lane === 'heavy') return;
        if (!job.heavyDeferred) throw new Error('Heavy queue waiter was not initialized.');
        return job.heavyDeferred.promise;
    }

    async checkpoint(job, operation = '') {
        if (operation) job.currentOperation = operation;
        if (job.cancelled) {
            throw new ExtractionError('The extraction request was cancelled.', { status: 499, code: 'CLIENT_DISCONNECTED' });
        }

        if (job.lane === 'quick' && job.quickStartedAt && Date.now() - job.quickStartedAt >= FAST_LANE_BUDGET_MS) {
            const decision = this.promoteOrQueue(job, 'time-budget');
            if (decision === 'queued') throw new QueuePromotionError('time-budget');
        }

        // Heavy work cooperatively yields only between bounded browser/CDP
        // operations. That prevents a second page from starting halfway through a
        // sensitive Runtime.evaluate while still giving short chats a fast lane.
        if (job.lane === 'heavy') {
            this.heavyAtCheckpoint = true;
            this._pump();
            try {
                while (this.activeQuick && this.activeQuick !== job) {
                    if (job.cancelled) {
                        throw new ExtractionError('The extraction request was cancelled.', { status: 499, code: 'CLIENT_DISCONNECTED' });
                    }
                    await this._waitForChange();
                }
            } finally {
                if (this.activeHeavy === job) this.heavyAtCheckpoint = false;
            }
        }
    }

    finish(job) {
        this._removeFromQueue(this.quickQueue, job);
        this._removeFromQueue(this.heavyQueue, job);
        const finishedQuick = this.activeQuick === job;
        if (finishedQuick) this.activeQuick = null;
        if (this.activeHeavy === job) {
            this.activeHeavy = null;
            this.heavyAtCheckpoint = false;
            this.heavyPriorityUntil = 0;
        } else if (finishedQuick && this.activeHeavy) {
            this.heavyPriorityUntil = Date.now() + HEAVY_PROGRESS_SLICE_MS;
        }
        job.state = 'done';
        this._signalChange();
        this._pump();
    }

    cancel(job) {
        if (!job || job.cancelled) return;
        job.cancelled = true;
        this._removeFromQueue(this.quickQueue, job);
        this._removeFromQueue(this.heavyQueue, job);
        const cancelledQuick = this.activeQuick === job;
        if (cancelledQuick) this.activeQuick = null;
        if (this.activeHeavy === job) {
            this.activeHeavy = null;
            this.heavyAtCheckpoint = false;
            this.heavyPriorityUntil = 0;
        } else if (cancelledQuick && this.activeHeavy) {
            this.heavyPriorityUntil = Date.now() + HEAVY_PROGRESS_SLICE_MS;
        }
        const error = new ExtractionError('The extraction request was cancelled.', { status: 499, code: 'CLIENT_DISCONNECTED' });
        job.quickDeferred?.reject(error);
        job.heavyDeferred?.reject(error);
        try { job.abortAttempt?.(); } catch (_) {}
        this._signalChange();
        this._pump();
    }

    stats() {
        return {
            quickWaiting: this.quickQueue.length,
            heavyWaiting: this.heavyQueue.length,
            totalWaiting: this.quickQueue.length + this.heavyQueue.length,
            quickActive: !!this.activeQuick,
            heavyActive: !!this.activeHeavy
        };
    }
}

const extractionScheduler = new ExtractionScheduler();

function estimateConversationWork(evidence, structuredMessages = []) {
    const domMessages = Math.max(0, Number(evidence?.users || 0) + Number(evidence?.assistants || 0));
    const structuredCount = Array.isArray(structuredMessages) ? structuredMessages.length : 0;
    const messageCount = Math.max(domMessages, structuredCount);
    const scrollHeight = Math.max(0, Number(evidence?.scrollHeight || 0));
    const sampledText = Math.max(0, Number(evidence?.textLength || 0));

    if (messageCount >= HEAVY_MESSAGE_THRESHOLD) return { heavy: true, reason: 'message-count', messageCount };
    if (scrollHeight >= HEAVY_SCROLL_HEIGHT_THRESHOLD) return { heavy: true, reason: 'page-height', messageCount };
    if (sampledText >= HEAVY_SAMPLED_TEXT_THRESHOLD) return { heavy: true, reason: 'text-density', messageCount };
    return { heavy: false, reason: 'quick', messageCount };
}

let sharedBrowser = null;
let sharedBrowserPromise = null;
let sharedBrowserRemote = false;

async function launchSharedBrowser() {
    const launchArgs = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage'
    ];
    if (process.env.EXTRACTION_PROXY_SERVER) launchArgs.push(`--proxy-server=${process.env.EXTRACTION_PROXY_SERVER}`);

    if (process.env.BROWSER_WS_ENDPOINT) {
        sharedBrowserRemote = true;
        return puppeteer.connect({
            browserWSEndpoint: process.env.BROWSER_WS_ENDPOINT,
            protocolTimeout: PUPPETEER_PROTOCOL_TIMEOUT_MS
        });
    }

    sharedBrowserRemote = false;
    return puppeteer.launch({
        headless: true,
        args: launchArgs,
        timeout: BROWSER_LAUNCH_TIMEOUT_MS,
        protocolTimeout: PUPPETEER_PROTOCOL_TIMEOUT_MS
    });
}

async function getSharedBrowser() {
    if (sharedBrowser?.connected) return sharedBrowser;
    if (sharedBrowserPromise) return sharedBrowserPromise;

    sharedBrowserPromise = (async () => {
        const browser = await launchSharedBrowser();
        sharedBrowser = browser;
        browser.once('disconnected', () => {
            if (sharedBrowser === browser) sharedBrowser = null;
        });
        return browser;
    })().finally(() => {
        sharedBrowserPromise = null;
    });
    return sharedBrowserPromise;
}

async function openSharedExtractionPage() {
    let lastError;
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            const browser = await getSharedBrowser();
            const context = typeof browser.createBrowserContext === 'function'
                ? await browser.createBrowserContext()
                : null;
            const page = context ? await context.newPage() : await browser.newPage();
            return { browser, context, page };
        } catch (error) {
            lastError = error;
            if (sharedBrowser && !sharedBrowser.connected) sharedBrowser = null;
        }
    }
    throw lastError || new Error('Unable to create a browser page.');
}

async function closeSharedExtractionPage(resource) {
    if (!resource) return;
    const { page, context } = resource;
    const closeWithDeadline = async (fn) => {
        let timer;
        try {
            await Promise.race([
                Promise.resolve().then(fn).catch(() => {}),
                new Promise(resolve => {
                    timer = setTimeout(resolve, Math.min(4000, BROWSER_CLOSE_TIMEOUT_MS));
                    timer.unref?.();
                })
            ]);
        } finally {
            if (timer) clearTimeout(timer);
        }
    };

    if (page && !page.isClosed?.()) await closeWithDeadline(() => page.close({ runBeforeUnload: false }));
    if (context) await closeWithDeadline(() => context.close());
}

async function closeSharedBrowserSafely() {
    const browser = sharedBrowser;
    sharedBrowser = null;
    if (!browser) return;
    if (sharedBrowserRemote) {
        try { browser.disconnect(); } catch (_) {}
        return;
    }
    await closeBrowserSafely(browser, false);
}

function isProtocolTimeoutError(error) {
    if (error?.code === 'PROVIDER_COLLECTOR_CALL_TIMEOUT' || error?.name === 'ProviderCollectorTimeoutError') return true;
    const message = String(error?.message || error || '');
    return /Runtime\.(?:callFunctionOn|evaluate) timed out|protocolTimeout|protocol timeout|ProtocolError[^\n]*timed out|execution.*(?:terminated|timed out).*timeout|exceeded \d+ms collector deadline/i.test(message);
}

function safeUrlForLog(value) {
    try {
        // Share IDs and provider resource IDs commonly live in the path/query.
        // Logs only need the origin for diagnostics; never persist the secret path.
        return new URL(value).origin.slice(0, 160);
    } catch (_) {
        return '[invalid-url]';
    }
}

function extractionSecurityHeaders(req, res, next) {
    // Extraction responses can contain the full conversation HTML. Explicitly forbid
    // browsers, reverse proxies, and CDNs from storing either JSON or NDJSON results.
    res.set({
        'Cache-Control': 'no-store, private, max-age=0',
        'Pragma': 'no-cache',
        'Expires': '0',
        'CDN-Cache-Control': 'no-store',
        'Surrogate-Control': 'no-store',
        'Cross-Origin-Resource-Policy': 'same-origin'
    });
    res.vary('Accept');
    next();
}

function rejectCrossOriginBrowserRequests(req, res, next) {
    // No CORS is enabled anywhere in the app. Fetch Metadata gives modern browsers
    // an additional same-origin gate before Puppeteer work can start.
    const fetchSite = String(req.get('sec-fetch-site') || '').toLowerCase();
    if (fetchSite && fetchSite !== 'same-origin') {
        return res.status(403).json({ success: false, code: 'CROSS_ORIGIN_BLOCKED', error: 'Cross-origin extraction requests are not allowed.' });
    }

    // Origin is checked independently for browsers that send it. Requests without
    // browser metadata (for example server-to-server diagnostics) remain valid.
    const origin = String(req.get('origin') || '').trim();
    if (!origin) return next();

    let parsedOrigin;
    try {
        parsedOrigin = new URL(origin).origin;
    } catch (_) {
        return res.status(403).json({ success: false, code: 'CROSS_ORIGIN_BLOCKED', error: 'Cross-origin extraction requests are not allowed.' });
    }

    const forwardedProto = String(req.get('x-forwarded-proto') || '')
        .split(',')[0]
        .trim();
    const protocol = forwardedProto || req.protocol;
    const expectedOrigin = `${protocol}://${req.get('host')}`;

    if (parsedOrigin !== expectedOrigin) {
        return res.status(403).json({ success: false, code: 'CROSS_ORIGIN_BLOCKED', error: 'Cross-origin extraction requests are not allowed.' });
    }

    next();
}

function createNetworkCapture(page, requestId) {
    const payloads = [];
    const pending = new Set();
    const failedApiResponses = [];
    let capturedBytes = 0;
    const MAX_TOTAL_BYTES = 12_000_000;
    const MAX_RESPONSE_BYTES = 6_000_000;

    const responseHandler = (response) => {
        const request = response.request();
        const resourceType = request.resourceType();
        if (resourceType !== 'xhr' && resourceType !== 'fetch') return;

        const task = (async () => {
            const status = response.status();
            const responseUrl = response.url();
            if (status >= 400) {
                failedApiResponses.push({ status, url: safeUrlForLog(responseUrl) });
                if (failedApiResponses.length > 12) failedApiResponses.shift();
            }

            if (capturedBytes >= MAX_TOTAL_BYTES || status < 200 || status >= 300) return;
            const headers = response.headers();
            const contentType = String(headers['content-type'] || '').toLowerCase();
            const looksStructured = /json|event-stream|text\/plain/.test(contentType) || /api|conversation|share|message|chat/i.test(responseUrl);
            if (!looksStructured) return;

            let body;
            try {
                body = await response.text();
            } catch (_) {
                return;
            }
            if (!body || body.length > MAX_RESPONSE_BYTES || capturedBytes + body.length > MAX_TOTAL_BYTES) return;
            const parsed = parsePotentialStructuredBody(body);
            if (!parsed) return;

            capturedBytes += body.length;
            payloads.push(parsed);
            if (payloads.length > 40) payloads.shift();
        })().catch((error) => {
            if (process.env.DEBUG_EXTRACTION === '1') {
                console.log(`[${requestId}] response capture error: ${error?.name || 'Error'}`);
            }
        });

        pending.add(task);
        task.finally(() => pending.delete(task));
    };

    page.on('response', responseHandler);

    return {
        payloads,
        failedApiResponses,
        async flush() {
            const snapshot = Array.from(pending);
            if (!snapshot.length) return;
            await Promise.race([
                Promise.allSettled(snapshot),
                delay(2500)
            ]);
        }
    };
}

async function inspectConversationDOM(page, provider) {
    const selectors = PROVIDER_CONFIG[provider]?.selectors || {};
    return page.evaluate(({ userSelector, assistantSelector }) => {
        // Evidence polling runs repeatedly while the provider hydrates. Avoid innerText
        // (layout-forcing) and avoid hashing every message body on giant conversations.
        // We only need proof that both roles exist plus a small text sample.
        const summarize = (selector) => {
            if (!selector) return { count: 0, textLength: 0 };
            const nodes = Array.from(document.querySelectorAll(selector));
            let count = 0;
            let sampled = 0;
            let textLength = 0;

            for (const node of nodes) {
                // Broad provider selectors intentionally include nested fallbacks. Count
                // only the outermost match so diagnostics stay meaningful.
                if (node.parentElement?.closest?.(selector)) continue;
                count += 1;
                if (sampled >= 24) continue;
                const text = String(node.textContent || '').replace(/\s+/g, ' ').trim();
                if (!text) continue;
                textLength += Math.min(text.length, 4000);
                sampled += 1;
            }
            return { count, textLength };
        };

        const users = summarize(userSelector);
        const assistants = summarize(assistantSelector);
        const hasBothRoles = users.count > 0 && assistants.count > 0;
        return {
            users: users.count,
            assistants: assistants.count,
            textLength: users.textLength + assistants.textLength,
            bodyText: hasBothRoles ? '' : String(document.body?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 3000),
            title: document.title || '',
            url: location.href,
            scrollHeight: Math.max(
                document.scrollingElement?.scrollHeight || 0,
                document.documentElement?.scrollHeight || 0,
                document.body?.scrollHeight || 0
            ),
            viewportHeight: window.innerHeight || 0
        };
    }, {
        userSelector: selectors.user || '',
        assistantSelector: selectors.assistant || ''
    });
}

function hasUsableDomEvidence(evidence) {
    if (!evidence) return false;
    const total = (evidence.users || 0) + (evidence.assistants || 0);
    return total >= 2 && evidence.textLength >= 20 && evidence.users > 0 && evidence.assistants > 0;
}

function hasUsableNetworkEvidence(messages) {
    if (!Array.isArray(messages) || messages.length < 2) return false;
    const hasUser = messages.some(message => message.role === 'user');
    const hasAssistant = messages.some(message => message.role === 'assistant');
    const textLength = messages.reduce((sum, message) => sum + String(message.text || '').length, 0);
    return hasUser && hasAssistant && textLength >= 20;
}

function detectBlockedOrUnavailable({ status, evidence, failedApiResponses }) {
    const haystack = `${evidence?.title || ''} ${evidence?.bodyText || ''}`.toLowerCase();
    const finalUrl = String(evidence?.url || '').toLowerCase();

    if (status === 403 || status === 429 || failedApiResponses.some(item => item.status === 403 || item.status === 429)) {
        return 'blocked';
    }
    if (/just a moment|verify you are human|checking your browser|access denied|captcha|cloudflare ray id|unusual traffic/.test(haystack)) {
        return 'blocked';
    }
    if (/\/login(?:[/?#]|$)|\/signin(?:[/?#]|$)|\/auth(?:[/?#]|$)/.test(finalUrl) || /sign in to continue|log in to continue/.test(haystack)) {
        return 'unavailable';
    }
    if (status === 404 || /conversation.*not found|share.*not found|page not found|link.*expired/.test(haystack)) {
        return 'unavailable';
    }
    return '';
}

async function waitForConversation(page, provider, timeout, { checkpoint = null } = {}) {
    const deadline = Date.now() + Math.max(1000, timeout || 0);
    let stable = 0;
    let previous = '';

    while (Date.now() < deadline) {
        if (checkpoint) await checkpoint(`${provider}.wait`);
        try {
            if (provider === 'gemini') {
                await page.evaluate(() => {
                    document.querySelectorAll('[data-test-id="luminous-expand-button"], button[aria-label="Expand"]')
                        .forEach((button) => { try { button.click(); } catch (_) {} });
                }).catch(() => {});
            }

            const evidence = await inspectConversationDOM(page, provider);
            if (hasUsableDomEvidence(evidence)) {
                const signature = `${evidence.users}:${evidence.assistants}:${evidence.textLength}`;
                if (signature === previous) stable += 1;
                else stable = 0;
                previous = signature;

                // Gemini needs an extra stable poll because its Angular route often
                // mounts the prompt first and the response shortly afterwards.
                if ((provider === 'gemini' && stable >= 2) || (provider !== 'gemini' && stable >= 1)) {
                    return true;
                }
            }
        } catch (_) {}
        await delay(provider === 'gemini' ? 650 : 500);
    }
    return false;
}

function inspectCollectedHTMLEvidence(html, provider) {
    const source = String(html || '');
    if (!source) return { users: 0, assistants: 0, textLength: 0 };
    const count = (regex) => (source.match(regex) || []).length;
    const plainTextLength = source
        .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;|&#160;/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim().length;

    let users = 0;
    let assistants = 0;
    if (provider === 'chatgpt') {
        users = count(/data-(?:message-author-role|turn)=["']user["']/gi);
        assistants = count(/data-(?:message-author-role|turn)=["']assistant["']/gi);
    } else if (provider === 'gemini') {
        users = count(/class=["'][^"']*\bquery-text(?:-line)?\b[^"']*["']/gi) || count(/<user-query\b/gi);
        assistants = count(/class=["'][^"']*\bmarkdown-main-panel\b[^"']*["']/gi) || count(/<response-container\b/gi);
    } else if (provider === 'qwen') {
        users = count(/qwen-chat-message-user/gi);
        assistants = count(/qwen-chat-message-assistant/gi);
    } else if (provider === 'grok') {
        users = count(/data-testid=["']user-message["']/gi);
        assistants = count(/data-testid=["']assistant-message["']/gi);
    } else if (provider === 'claude') {
        users = count(/data-testid=["']user-message["']|font-user-message|data-message-author-role=["']user["']/gi);
        assistants = count(/font-claude-response|font-claude-message|standard-markdown|progressive-markdown|data-message-author-role=["']assistant["']|data-test-render/gi);
    }

    return { users, assistants, textLength: plainTextLength };
}

function hasUsableCollectedEvidence(evidence) {
    return !!evidence && evidence.users > 0 && evidence.assistants > 0 && evidence.textLength >= 20;
}

async function collectSmallPageSnapshot(page, { maxChars = 2_500_000, timeoutMs = 8000 } = {}) {
    // Legacy full-page fallback, but only for genuinely small pages. Using
    // page.content() after a collector timeout can issue another unbounded
    // Runtime.callFunctionOn and multiply a 5-minute failure into a 10-15 minute
    // request. Runtime.evaluate's V8 timeout gives this fallback a hard ceiling.
    const session = await page.createCDPSession();
    try {
        await session.send('Runtime.enable').catch(() => {});
        const expression = `(() => {
            const body = document.body;
            const textLength = String(body?.textContent || '').length;
            const nodeCount = document.getElementsByTagName('*').length;
            if (textLength > 1200000 || nodeCount > 22000) return '';
            const html = document.documentElement?.outerHTML || '';
            return html.length <= 2500000 ? html : '';
        })()`;
        const response = await session.send('Runtime.evaluate', {
            expression,
            returnByValue: true,
            timeout: Math.max(1000, Math.min(15000, Number(timeoutMs) || 8000))
        });
        if (response.exceptionDetails) return '';
        return typeof response.result?.value === 'string' ? response.result.value : '';
    } catch (_) {
        return '';
    } finally {
        await session.detach().catch(() => {});
    }
}

async function collectPageHTML(page, provider, url, { expectedMessages = 0, checkpoint = null } = {}) {
    try {
        if (checkpoint) await checkpoint(`${provider}.network_idle`);
        await page.waitForNetworkIdle({ idleTime: 650, timeout: 7000 }).catch(() => {});

        if (provider === 'chatgpt') {
            const html = await collectChatGPTHTML(page, url, { expectedMessages, checkpoint });
            if (/data-message-author-role|conversation-turn-|data-turn=/i.test(html)) return html;
            return (await collectSmallPageSnapshot(page)) || html;
        }

        if (provider === 'claude') {
            const html = await collectClaudeHTML(page, url, { expectedMessages, checkpoint });
            if (/data-c2p-claude-turn|font-claude-response|standard-markdown|progressive-markdown/i.test(html)) return html;
            return (await collectSmallPageSnapshot(page)) || html;
        }

        if (provider === 'gemini') {
            const html = await collectGeminiHTML(page, url, { expectedMessages, checkpoint });
            if (/share-turn-viewer|markdown-main-panel|query-text/i.test(html)) return html;
            return (await collectSmallPageSnapshot(page)) || html;
        }

        if (provider === 'qwen') {
            const html = await collectQwenHTML(page, url, { expectedMessages, checkpoint });
            if (/share-layout-messages|qwen-chat-message/i.test(html)) return html;
            return (await collectSmallPageSnapshot(page)) || html;
        }

        if (provider === 'grok') {
            const html = await collectGrokHTML(page, url, { expectedMessages, checkpoint });
            if (/data-testid=["'](?:user-message|assistant-message)["']/i.test(html)) return html;
            return (await collectSmallPageSnapshot(page)) || html;
        }

        return await collectSmallPageSnapshot(page);
    } catch (error) {
        if (isProtocolTimeoutError(error)) {
            // Critical: never call page.content() after a protocol/collector timeout.
            // That repeats the same expensive Runtime call and was the main reason a
            // ChatGPT failure could stretch to ~15 minutes and end as a proxy
            // "Network error". If structured messages are already available, the
            // route appends them to this shell. Otherwise fail promptly and cleanly.
            if (expectedMessages >= 2) {
                return `<!doctype html><html><head></head><body><main id="c2p-${provider}-structured-fallback" data-provider="${provider}"></main></body></html>`;
            }
            throw error;
        }

        const snapshot = await collectSmallPageSnapshot(page);
        if (snapshot) return snapshot;
        throw error;
    }
}

// ==========================================
// EXTRACTION EXECUTION + QUEUE-AWARE API
// ==========================================
async function executeExtractionAttempt({ job, validation, sendProgress }) {
    const { url, provider } = validation;
    const attemptStartedAt = Date.now();
    let resource = null;
    let closingPromise = null;
    let hardTimeoutTriggered = false;
    let currentOperation = 'attempt.starting';

    const closeCurrentPage = () => {
        if (closingPromise) return closingPromise;
        if (!resource) return Promise.resolve();
        const current = resource;
        resource = null;
        closingPromise = closeSharedExtractionPage(current)
            .catch(() => {})
            .finally(() => { closingPromise = null; });
        return closingPromise;
    };

    job.abortAttempt = () => { void closeCurrentPage(); };

    const hardTimeout = setTimeout(() => {
        hardTimeoutTriggered = true;
        void closeCurrentPage();
    }, EXTRACTION_HARD_TIMEOUT_MS);
    hardTimeout.unref?.();

    const checkpoint = async (operation) => {
        if (operation) currentOperation = operation;
        await extractionScheduler.checkpoint(job, operation || currentOperation);
    };

    try {
        console.log(`[${job.requestId}] extracting ${provider} share lane=${job.lane} from ${validation.parsedUrl.hostname}`);
        sendProgress('browser_starting');
        currentOperation = 'browser.sharedPage';
        await checkpoint(currentOperation);
        resource = await openSharedExtractionPage();
        const { browser, page } = resource;

        if (job.cancelled || hardTimeoutTriggered) {
            throw new ExtractionError('The extraction was cancelled before the browser became ready.', {
                status: job.cancelled ? 499 : 504,
                code: job.cancelled ? 'CLIENT_DISCONNECTED' : 'EXTRACTION_HARD_TIMEOUT'
            });
        }

        sendProgress('browser_ready');
        if (process.env.EXTRACTION_PROXY_USERNAME && process.env.EXTRACTION_PROXY_PASSWORD) {
            currentOperation = 'page.authenticate';
            await checkpoint(currentOperation);
            await page.authenticate({
                username: process.env.EXTRACTION_PROXY_USERNAME,
                password: process.env.EXTRACTION_PROXY_PASSWORD
            });
        }

        page.setDefaultNavigationTimeout(30000);
        page.setDefaultTimeout(20000);
        currentOperation = 'page.setup';
        await checkpoint(currentOperation);
        await page.setViewport({ width: 1440, height: 1200, deviceScaleFactor: 1 });
        await page.setCacheEnabled(false);

        // The stealth plugin's async UA override is disabled globally. Keep the
        // explicit, awaited override inside this request so failures remain catchable.
        const browserUA = await browser.userAgent();
        await page.setUserAgent(browserUA.replace(/HeadlessChrome\//i, 'Chrome/'));
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9'
        });

        await page.setRequestInterception(true);
        page.on('request', (request) => {
            const operation = request.resourceType() === 'media'
                ? request.abort()
                : request.continue();
            operation.catch(() => {});
        });

        const networkCapture = createNetworkCapture(page, job.requestId);
        const pageErrors = [];
        page.on('pageerror', (error) => {
            pageErrors.push(error?.name || 'PageError');
            if (pageErrors.length > 8) pageErrors.shift();
        });
        if (process.env.DEBUG_EXTRACTION === '1') {
            page.on('console', message => console.log(`[${job.requestId}] browser:${message.type()}`));
        }

        let navigationResponse;
        sendProgress('opening_link');
        currentOperation = 'page.goto';
        await checkpoint(currentOperation);
        try {
            navigationResponse = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
            sendProgress('link_opened');
        } catch (error) {
            if (job.cancelled || hardTimeoutTriggered) throw error;
            throw new ExtractionError(`The ${provider} share page did not finish loading.`, {
                status: 504,
                code: 'NAVIGATION_TIMEOUT'
            });
        }

        sendProgress('waiting_for_conversation');
        currentOperation = 'conversation.wait';
        await waitForConversation(page, provider, provider === 'gemini' ? 26000 : 18000, { checkpoint });
        await networkCapture.flush();

        sendProgress('inspecting_conversation');
        currentOperation = 'conversation.inspect';
        await checkpoint(currentOperation);
        let evidence = await inspectConversationDOM(page, provider);
        let networkMessages = collectStructuredMessages(networkCapture.payloads);
        let embeddedMessages = [];
        let fallbackMessages = collectStructuredMessages(networkMessages);
        let html = '';
        let htmlEvidence = { users: 0, assistants: 0, textLength: 0 };
        let status = navigationResponse?.status() || 0;

        // Size is only a hint. A medium-looking chat that finishes inside the fast
        // budget stays fast; a truly huge DOM/network payload is promoted early.
        if (job.lane === 'quick') {
            const work = estimateConversationWork(evidence, fallbackMessages);
            if (work.heavy) {
                const decision = extractionScheduler.promoteOrQueue(job, work.reason);
                if (decision === 'queued') throw new QueuePromotionError(work.reason);
                await checkpoint('conversation.heavy_promoted');
            }
        }

        if (!hasUsableDomEvidence(evidence) && !hasUsableNetworkEvidence(fallbackMessages)) {
            sendProgress('collecting_conversation');
            currentOperation = `${provider}.collect`;
            html = await collectPageHTML(page, provider, url, { expectedMessages: fallbackMessages.length, checkpoint });
            htmlEvidence = inspectCollectedHTMLEvidence(html, provider);
            embeddedMessages = collectEmbeddedStructuredMessages(html);
            fallbackMessages = collectStructuredMessages([networkMessages, embeddedMessages]);
        }

        let hasConversationEvidence = hasUsableDomEvidence(evidence) ||
            hasUsableNetworkEvidence(fallbackMessages) ||
            hasUsableCollectedEvidence(htmlEvidence);
        let state = !hasConversationEvidence
            ? detectBlockedOrUnavailable({ status, evidence, failedApiResponses: networkCapture.failedApiResponses })
            : '';

        if (!hasConversationEvidence && !state) {
            console.log(`[${job.requestId}] no complete conversation evidence after first load; retrying hydration once`);
            sendProgress('retrying_provider');
            try {
                currentOperation = `${provider}.reload`;
                await checkpoint(currentOperation);
                navigationResponse = await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }) || navigationResponse;
                await waitForConversation(page, provider, provider === 'gemini' ? 18000 : 11000, { checkpoint });
                await networkCapture.flush();
                evidence = await inspectConversationDOM(page, provider);
                networkMessages = collectStructuredMessages(networkCapture.payloads);

                if (job.lane === 'quick') {
                    const work = estimateConversationWork(evidence, networkMessages);
                    if (work.heavy) {
                        const decision = extractionScheduler.promoteOrQueue(job, work.reason);
                        if (decision === 'queued') throw new QueuePromotionError(work.reason);
                        await checkpoint('conversation.heavy_promoted_retry');
                    }
                }

                currentOperation = `${provider}.collect_retry`;
                html = await collectPageHTML(page, provider, url, { expectedMessages: fallbackMessages.length, checkpoint });
                htmlEvidence = inspectCollectedHTMLEvidence(html, provider);
                embeddedMessages = collectEmbeddedStructuredMessages(html);
                fallbackMessages = collectStructuredMessages([networkMessages, embeddedMessages]);
                status = navigationResponse?.status() || status;
                hasConversationEvidence = hasUsableDomEvidence(evidence) ||
                    hasUsableNetworkEvidence(fallbackMessages) ||
                    hasUsableCollectedEvidence(htmlEvidence);
                state = !hasConversationEvidence
                    ? detectBlockedOrUnavailable({ status, evidence, failedApiResponses: networkCapture.failedApiResponses })
                    : '';
            } catch (error) {
                if (error instanceof QueuePromotionError || job.cancelled || hardTimeoutTriggered) throw error;
                // The detailed evidence below is more useful than a reload error.
            }
        }

        if (hasConversationEvidence) sendProgress('conversation_found');

        if (state === 'blocked') {
            throw new ExtractionError(
                `${provider} is blocking automated access to this public share page right now. Please try again later or from a different deployment network.`,
                { status: 502, code: 'PROVIDER_BLOCKED' }
            );
        }
        if (state === 'unavailable') {
            throw new ExtractionError(
                'The share link opened, but the provider reports that the conversation is unavailable, private, expired, or requires sign-in.',
                { status: 422, code: 'SHARE_UNAVAILABLE' }
            );
        }

        if (!hasConversationEvidence) {
            console.warn(`[${job.requestId}] no messages: status=${status} finalOrigin=${safeUrlForLog(evidence?.url)} dom=${evidence?.users || 0}/${evidence?.assistants || 0} collected=${htmlEvidence.users}/${htmlEvidence.assistants} apiFailures=${JSON.stringify(networkCapture.failedApiResponses)} pageErrors=${JSON.stringify(pageErrors)}`);
            throw new ExtractionError(
                `The public ${provider} page opened, but its conversation data was not delivered to the extractor. The provider may have changed its page structure or blocked datacenter browsers.`,
                { status: 502, code: 'CONVERSATION_NOT_DELIVERED' }
            );
        }

        if (!html) {
            sendProgress('collecting_conversation');
            currentOperation = `${provider}.collect_final`;
            html = await collectPageHTML(page, provider, url, { expectedMessages: fallbackMessages.length, checkpoint });
        }

        sendProgress('finalizing_extraction');
        currentOperation = 'conversation.finalize';
        await checkpoint(currentOperation);
        htmlEvidence = inspectCollectedHTMLEvidence(html, provider);
        await networkCapture.flush();
        networkMessages = collectStructuredMessages(networkCapture.payloads);
        embeddedMessages = collectEmbeddedStructuredMessages(html);
        fallbackMessages = collectStructuredMessages([networkMessages, embeddedMessages]);
        html = appendNetworkFallback(html, provider, fallbackMessages);

        if (!hasUsableDomEvidence(evidence) &&
            !hasUsableNetworkEvidence(fallbackMessages) &&
            !hasUsableCollectedEvidence(htmlEvidence)) {
            throw new ExtractionError('No conversation messages were found after extraction.', {
                status: 502,
                code: 'EMPTY_EXTRACTION'
            });
        }

        const source = hasUsableCollectedEvidence(htmlEvidence)
            ? 'collected-html'
            : (hasUsableDomEvidence(evidence) ? 'dom' : 'structured-fallback');

        console.log(`[${job.requestId}] attempt succeeded lane=${job.lane} provider=${provider} dom=${evidence.users}/${evidence.assistants} collected=${htmlEvidence.users}/${htmlEvidence.assistants} fallbackMessages=${fallbackMessages.length} attemptMs=${Date.now() - attemptStartedAt}`);
        return {
            success: true,
            provider,
            html,
            diagnostics: {
                requestId: job.requestId,
                source,
                lane: job.lane,
                domMessages: { users: evidence.users || 0, assistants: evidence.assistants || 0 },
                collectedMessages: { users: htmlEvidence.users || 0, assistants: htmlEvidence.assistants || 0 },
                structuredMessages: fallbackMessages.length
            }
        };
    } catch (error) {
        if (error instanceof QueuePromotionError) throw error;
        if (job.cancelled) {
            throw new ExtractionError('The extraction request was cancelled.', { status: 499, code: 'CLIENT_DISCONNECTED' });
        }
        if (hardTimeoutTriggered) {
            throw new ExtractionError('The browser exceeded the maximum extraction time and was stopped. Please try the link again.', {
                status: 504,
                code: 'EXTRACTION_HARD_TIMEOUT'
            });
        }
        if (error && !error.operation) error.operation = currentOperation;
        throw error;
    } finally {
        clearTimeout(hardTimeout);
        job.abortAttempt = null;
        await closeCurrentPage();
    }
}

app.post('/api/extract', extractionSecurityHeaders, rejectCrossOriginBrowserRequests, limiter, async (req, res) => {
    const requestId = crypto.randomUUID().slice(0, 8);
    const requestStartedAt = Date.now();
    const wantsProgressStream = String(req.get('accept') || '').includes('application/x-ndjson');
    const validation = validateShareUrl(req.body?.url);
    if (validation.error) {
        return res.status(400).json({ success: false, code: 'INVALID_SHARE_URL', error: validation.error, requestId });
    }

    const { provider } = validation;

    if (wantsProgressStream) {
        res.status(200);
        res.set({
            'Content-Type': 'application/x-ndjson; charset=utf-8',
            'Cache-Control': 'no-store, private, max-age=0, no-transform',
            'X-Accel-Buffering': 'no'
        });
        if (typeof res.flushHeaders === 'function') res.flushHeaders();
    }

    let currentProgressStage = 'validated';
    const sendProgress = (stage, extra = {}) => {
        if (stage && !extra.heartbeat) currentProgressStage = stage;
        if (!wantsProgressStream || res.writableEnded || res.destroyed) return;
        res.write(`${JSON.stringify({ type: 'progress', stage, provider, ...extra })}\n`);
    };

    const progressHeartbeat = wantsProgressStream
        ? setInterval(() => sendProgress(currentProgressStage, { heartbeat: true }), 12000)
        : null;
    progressHeartbeat?.unref?.();

    const writeNdjson = async (event) => {
        if (res.writableEnded || res.destroyed) return false;
        const writable = res.write(`${JSON.stringify(event)}\n`);
        if (!writable && !res.writableEnded) {
            await new Promise((resolve) => {
                const done = () => {
                    res.off('drain', done);
                    res.off('close', done);
                    resolve();
                };
                res.once('drain', done);
                res.once('close', done);
            });
        }
        return !res.writableEnded;
    };

    const sendExtractionResponse = async (status, payload) => {
        if (!wantsProgressStream) return res.status(status).json(payload);
        if (res.writableEnded || res.destroyed) return;
        if (progressHeartbeat) clearInterval(progressHeartbeat);

        const html = typeof payload?.html === 'string' ? payload.html : '';
        if (html.length > STREAM_HTML_CHUNK_SIZE) {
            const { html: _html, ...metadata } = payload;
            const totalChunks = Math.ceil(html.length / STREAM_HTML_CHUNK_SIZE);
            if (!await writeNdjson({ type: 'result_start', status, htmlChunked: true, totalChunks, ...metadata })) return;
            for (let offset = 0, index = 0; offset < html.length; offset += STREAM_HTML_CHUNK_SIZE, index += 1) {
                const data = html.slice(offset, offset + STREAM_HTML_CHUNK_SIZE);
                if (!await writeNdjson({ type: 'html_chunk', index, data })) return;
            }
            if (!await writeNdjson({ type: 'result_end' })) return;
            res.end();
            return;
        }

        await writeNdjson({ type: 'result', status, ...payload });
        if (!res.writableEnded) res.end();
    };

    const job = extractionScheduler.createJob({ requestId, provider, sendProgress });
    const onResponseClose = () => {
        if (res.writableEnded) return;
        extractionScheduler.cancel(job);
    };
    res.on('close', onResponseClose);

    sendProgress('validated');

    try {
        await extractionScheduler.enqueueQuick(job);

        let result;
        while (!result) {
            try {
                result = await executeExtractionAttempt({ job, validation, sendProgress });
            } catch (error) {
                if (!(error instanceof QueuePromotionError)) throw error;
                await extractionScheduler.waitForHeavy(job);
            }
        }

        extractionScheduler.finish(job);
        console.log(`[${requestId}] extraction succeeded provider=${provider} lane=${result.diagnostics?.lane || job.lane} totalMs=${Date.now() - requestStartedAt}`);
        sendProgress('extraction_complete', { source: result.diagnostics?.source });
        return await sendExtractionResponse(200, result);
    } catch (error) {
        extractionScheduler.finish(job);
        const protocolTimedOut = !(error instanceof ExtractionError) && isProtocolTimeoutError(error);
        const status = error instanceof ExtractionError ? error.status : (protocolTimedOut ? 504 : 500);
        const code = error instanceof ExtractionError ? error.code : (protocolTimedOut ? 'BROWSER_PROTOCOL_TIMEOUT' : 'EXTRACTION_FAILED');
        const operationName = error?.operation || job.currentOperation;
        const operation = operationName ? ` op=${String(operationName).replace(/[^a-z0-9_.:-]/gi, '').slice(0, 80)}` : '';
        console.error(`[${requestId}] ${code}${error instanceof ExtractionError ? `: ${error.message}` : ` (${error?.name || 'Error'})`}${operation} totalMs=${Date.now() - requestStartedAt}`);
        sendProgress('extraction_error', { code });
        return await sendExtractionResponse(status, {
            success: false,
            code,
            requestId,
            error: error instanceof ExtractionError
                ? error.message
                : (protocolTimedOut
                    ? 'This public conversation is unusually large and the browser hit a processing timeout. Please try the link again.'
                    : 'The conversation could not be extracted due to an unexpected server error.')
        });
    } finally {
        if (progressHeartbeat) clearInterval(progressHeartbeat);
        res.off('close', onResponseClose);
        if (job.state !== 'done') extractionScheduler.finish(job);
    }
});


app.get('/healthz', (req, res) => res.json({ ok: true, queue: extractionScheduler.stats(), browserConnected: !!sharedBrowser?.connected }));

// Rota coringa para evitar que o DevTools do Chrome suje o terminal com erro 404
// Rota coringa atualizada para o Express 5 (Trata rotas não encontradas)
app.use((req, res) => {
    res.status(404).send('Not found');
});

if (require.main === module) {
    const shutdownSharedBrowser = () => {
        void closeSharedBrowserSafely().finally(() => process.exit(0));
    };
    process.once('SIGTERM', shutdownSharedBrowser);
    process.once('SIGINT', shutdownSharedBrowser);

    app.listen(PORT, () => {
        console.log(`🚀 Servidor e Programmatic SEO ativos em: http://localhost:${PORT}`);
    });
}

module.exports = {
    app,
    validateShareUrl,
    collectStructuredMessages,
    parsePotentialStructuredBody,
    ExtractionScheduler,
    estimateConversationWork,
    QueuePromotionError
};
