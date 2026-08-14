const express = require('express');
const cors = require('cors');
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

// Ativa o modo invisível do Puppeteer
puppeteer.use(StealthPlugin());

const app = express();
const PORT = process.env.PORT || 3000;
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
app.use(cors());
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

async function collectChatGPTHTML(page, url) {
    // ChatGPT shared conversations may virtualize older turns. If we call
    // page.content() only after scrolling, the first turns can disappear from
    // the live DOM. This collector snapshots visible turns while moving from
    // top to bottom and then builds a stable synthetic HTML document.
    return await page.evaluate(async (sourceUrl) => {
        const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

        function getScrollTarget() {
            const candidates = [document.scrollingElement, document.documentElement, document.body, ...Array.from(document.querySelectorAll('main, [class*="overflow-y-auto"], [class*="scroll"], [data-testid]'))];
            return candidates
                .filter(Boolean)
                .map((el) => ({ el, delta: (el.scrollHeight || 0) - (el.clientHeight || 0) }))
                .sort((a, b) => b.delta - a.delta)[0]?.el || document.scrollingElement || document.documentElement;
        }

        function cleanClone(node) {
            const clone = node.cloneNode(true);
            clone.querySelectorAll([
                'script', 'style', 'noscript', 'template', 'button', 'input', 'textarea', 'select',
                'nav', 'footer', 'aside', 'form', 'iframe', 'canvas', 'audio', 'video',
                '[aria-hidden="true"]', '.sr-only', '.hidden', '.sticky', '.order-first',
                '[class*="actions"]', '[class*="copy"]', '[class*="popover"]', '[class*="tooltip"]'
            ].join(',')).forEach(el => el.remove());
            return clone;
        }

        function turnKey(node) {
            return node.getAttribute('data-turn-id') ||
                node.getAttribute('data-turn-id-container') ||
                node.getAttribute('data-testid') ||
                `${node.getAttribute('data-turn') || ''}:${(node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 180)}`;
        }

        const turns = new Map();
        const capture = () => {
            document.querySelectorAll('section[data-turn], [data-testid^="conversation-turn-"]').forEach((node) => {
                const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
                if (!text) return;
                const key = turnKey(node);
                if (!key || turns.has(key)) return;
                turns.set(key, cleanClone(node).outerHTML);
            });
        };

        const target = getScrollTarget();
        const maxSteps = 72;
        const stepSize = Math.max(420, Math.floor((window.innerHeight || 900) * 0.72));
        let stagnant = 0;
        let lastTop = -1;
        let lastCount = -1;

        try { target.scrollTo ? target.scrollTo(0, 0) : window.scrollTo(0, 0); } catch (_) { window.scrollTo(0, 0); }
        await sleep(700);
        capture();

        for (let i = 0; i < maxSteps; i += 1) {
            const beforeTop = target.scrollTop || window.scrollY || 0;
            const beforeCount = turns.size;
            try {
                target.scrollBy ? target.scrollBy(0, stepSize) : window.scrollBy(0, stepSize);
            } catch (_) {
                window.scrollBy(0, stepSize);
            }
            await sleep(240);
            capture();

            const afterTop = target.scrollTop || window.scrollY || 0;
            const maxTop = Math.max(0, (target.scrollHeight || document.documentElement.scrollHeight || 0) - (target.clientHeight || window.innerHeight || 0));
            const atBottom = afterTop >= maxTop - 8 || afterTop === beforeTop;
            const noNewTurns = turns.size === beforeCount;
            const samePosition = afterTop === lastTop && turns.size === lastCount;

            if ((atBottom && noNewTurns) || samePosition) stagnant += 1;
            else stagnant = 0;

            lastTop = afterTop;
            lastCount = turns.size;

            if (stagnant >= 3) break;
        }

        capture();
        try { target.scrollTo ? target.scrollTo(0, 0) : window.scrollTo(0, 0); } catch (_) { window.scrollTo(0, 0); }

        const title = document.title || '';
        const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute('href') || sourceUrl || '';
        const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute('content') || '';
        const ogDescription = document.querySelector('meta[property="og:description"]')?.getAttribute('content') || '';

        return `<!doctype html><html lang="${document.documentElement.lang || 'en'}"><head>` +
            `<title>${title.replace(/</g, '&lt;')}</title>` +
            `<link rel="canonical" href="${canonical.replace(/"/g, '&quot;')}">` +
            `<meta property="og:title" content="${ogTitle.replace(/"/g, '&quot;')}">` +
            `<meta property="og:description" content="${ogDescription.replace(/"/g, '&quot;')}">` +
            `</head><body><main id="c2p-collected-chatgpt" data-provider="chatgpt">${Array.from(turns.values()).join('\n')}</main></body></html>`;
    }, url);
}

async function collectQwenHTML(page, url) {
    return await page.evaluate((sourceUrl) => {
        const root = document.querySelector('.share-layout-messages');
        if (!root) return '';

        const clone = root.cloneNode(true);
        clone.querySelectorAll([
            'script', 'style', 'noscript', 'template', 'button', 'input', 'textarea', 'select',
            'iframe', 'canvas', 'audio', 'video', 'svg', '[role="button"]',
            '.message-hoc-container', '.user-message-footer', '.response-message-footer'
        ].join(',')).forEach((node) => node.remove());

        const title = document.querySelector('.share-layout-title')?.textContent?.trim() || document.title || '';
        const date = document.querySelector('.share-layout-date')?.textContent?.trim() || '';
        const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute('href') || sourceUrl || '';
        const escapeAttr = (value) => String(value || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

        return `<!doctype html><html lang="${escapeAttr(document.documentElement.lang || 'en')}"><head>` +
            `<title>${escapeAttr(title)}</title>` +
            `<link rel="canonical" href="${escapeAttr(canonical)}">` +
            `</head><body><div class="share-layout-title">${escapeAttr(title)}</div>` +
            `<div class="share-layout-date">${escapeAttr(date)}</div>${clone.outerHTML}</body></html>`;
    }, url);
}


// ==========================================
// EXTRACTION HELPERS
// ==========================================
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function safeUrlForLog(value) {
    try {
        const url = new URL(value);
        return `${url.origin}${url.pathname}`.slice(0, 240);
    } catch (_) {
        return String(value || '').slice(0, 240);
    }
}

function createNetworkCapture(page, requestId) {
    const payloads = [];
    const pending = new Set();
    const failedApiResponses = [];
    let capturedBytes = 0;
    const MAX_TOTAL_BYTES = 2_500_000;
    const MAX_RESPONSE_BYTES = 900_000;

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
            if (payloads.length > 20) payloads.shift();
        })().catch((error) => {
            if (process.env.DEBUG_EXTRACTION === '1') {
                console.log(`[${requestId}] response capture error: ${error.message}`);
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
        const visibleText = (node) => (node?.innerText || node?.textContent || '').replace(/\s+/g, ' ').trim();
        const unique = (selector) => {
            if (!selector) return [];
            const seen = new Set();
            return Array.from(document.querySelectorAll(selector)).filter((node) => {
                const text = visibleText(node);
                if (!text || seen.has(text)) return false;
                seen.add(text);
                return true;
            });
        };
        const users = unique(userSelector);
        const assistants = unique(assistantSelector);
        return {
            users: users.length,
            assistants: assistants.length,
            textLength: [...users, ...assistants].reduce((sum, node) => sum + visibleText(node).length, 0),
            bodyText: (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 3000),
            title: document.title || '',
            url: location.href
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

async function waitForConversation(page, provider, timeout) {
    const selectors = PROVIDER_CONFIG[provider]?.selectors || {};
    const selector = [selectors.user, selectors.assistant].filter(Boolean).join(', ');
    if (!selector) return false;
    try {
        await page.waitForSelector(selector, { timeout });
        return true;
    } catch (_) {
        return false;
    }
}

async function collectPageHTML(page, provider, url) {
    try {
        await page.waitForNetworkIdle({ idleTime: 650, timeout: 7000 }).catch(() => {});

        if (provider === 'chatgpt') {
            let html = await collectChatGPTHTML(page, url);
            if (!/data-message-author-role|conversation-turn-|data-turn=/i.test(html)) html = await page.content();
            return html;
        }

        if (provider === 'qwen') {
            let html = await collectQwenHTML(page, url);
            if (!/share-layout-messages|qwen-chat-message/i.test(html)) html = await page.content();
            return html;
        }

        await page.evaluate(async () => {
            await new Promise((resolve) => {
                let totalHeight = 0;
                const distance = Math.max(500, Math.floor((window.innerHeight || 900) * 0.7));
                const maxHeight = Math.max(document.body?.scrollHeight || 0, document.documentElement?.scrollHeight || 0);
                const timer = setInterval(() => {
                    window.scrollBy(0, distance);
                    totalHeight += distance;
                    if (totalHeight >= maxHeight + distance) {
                        clearInterval(timer);
                        window.scrollTo(0, 0);
                        resolve();
                    }
                }, 120);
                setTimeout(() => {
                    clearInterval(timer);
                    window.scrollTo(0, 0);
                    resolve();
                }, 5000);
            });
        });
        await delay(provider === 'gemini' ? 1200 : 700);
        return await page.content();
    } catch (_) {
        return await page.content();
    }
}

// ==========================================
// ROTA DE EXTRAÇÃO (API)
// ==========================================
app.post('/api/extract', limiter, async (req, res) => {
    const requestId = crypto.randomUUID().slice(0, 8);
    const validation = validateShareUrl(req.body?.url);
    if (validation.error) {
        return res.status(400).json({ success: false, code: 'INVALID_SHARE_URL', error: validation.error, requestId });
    }

    const { url, provider } = validation;
    let browser;
    let remoteBrowser = false;

    try {
        console.log(`[${requestId}] extracting ${provider} share from ${validation.parsedUrl.hostname}`);

        const launchArgs = [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage'
        ];
        if (process.env.EXTRACTION_PROXY_SERVER) {
            launchArgs.push(`--proxy-server=${process.env.EXTRACTION_PROXY_SERVER}`);
        }

        if (process.env.BROWSER_WS_ENDPOINT) {
            remoteBrowser = true;
            browser = await puppeteer.connect({ browserWSEndpoint: process.env.BROWSER_WS_ENDPOINT });
        } else {
            browser = await puppeteer.launch({
                headless: true,
                args: launchArgs
            });
        }

        const page = await browser.newPage();
        if (process.env.EXTRACTION_PROXY_USERNAME && process.env.EXTRACTION_PROXY_PASSWORD) {
            await page.authenticate({
                username: process.env.EXTRACTION_PROXY_USERNAME,
                password: process.env.EXTRACTION_PROXY_PASSWORD
            });
        }
        page.setDefaultNavigationTimeout(30000);
        page.setDefaultTimeout(20000);
        await page.setViewport({ width: 1440, height: 1200, deviceScaleFactor: 1 });
        await page.setCacheEnabled(false);

        // Keep the browser version internally consistent instead of advertising a
        // hard-coded Chrome build that can disagree with Puppeteer's Chromium.
        const browserUA = await browser.userAgent();
        await page.setUserAgent(browserUA.replace(/HeadlessChrome\//i, 'Chrome/'));
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9'
        });

        // Blocking only heavy media keeps JS, CSS, fonts and API requests intact.
        await page.setRequestInterception(true);
        page.on('request', (request) => {
            const operation = ['image', 'media'].includes(request.resourceType())
                ? request.abort()
                : request.continue();
            operation.catch(() => {});
        });

        const networkCapture = createNetworkCapture(page, requestId);
        const pageErrors = [];
        page.on('pageerror', (error) => {
            pageErrors.push(error.message);
            if (pageErrors.length > 8) pageErrors.shift();
        });
        if (process.env.DEBUG_EXTRACTION === '1') {
            page.on('console', message => console.log(`[${requestId}] browser:${message.type()} ${message.text().slice(0, 500)}`));
        }

        let navigationResponse;
        try {
            navigationResponse = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        } catch (error) {
            throw new ExtractionError(`The ${provider} share page did not finish loading.`, {
                status: 504,
                code: 'NAVIGATION_TIMEOUT'
            });
        }

        await waitForConversation(page, provider, 16000);
        await networkCapture.flush();
        let evidence = await inspectConversationDOM(page, provider);
        let networkMessages = collectStructuredMessages(networkCapture.payloads);
        let embeddedMessages = [];
        if (!hasUsableDomEvidence(evidence) && !hasUsableNetworkEvidence(networkMessages)) {
            embeddedMessages = collectEmbeddedStructuredMessages(await page.content());
        }
        let fallbackMessages = collectStructuredMessages([networkMessages, embeddedMessages]);
        let status = navigationResponse?.status() || 0;
        let state = (!hasUsableDomEvidence(evidence) && !hasUsableNetworkEvidence(fallbackMessages))
            ? detectBlockedOrUnavailable({ status, evidence, failedApiResponses: networkCapture.failedApiResponses })
            : '';

        // One conservative retry helps with transient hydration failures without
        // turning every request into a long-running browser job.
        if (!hasUsableDomEvidence(evidence) && !hasUsableNetworkEvidence(fallbackMessages) && !state) {
            console.log(`[${requestId}] no conversation evidence after first load; retrying hydration once`);
            try {
                navigationResponse = await page.reload({ waitUntil: 'domcontentloaded', timeout: 25000 }) || navigationResponse;
                await waitForConversation(page, provider, 9000);
                await networkCapture.flush();
                evidence = await inspectConversationDOM(page, provider);
                networkMessages = collectStructuredMessages(networkCapture.payloads);
                embeddedMessages = collectEmbeddedStructuredMessages(await page.content());
                fallbackMessages = collectStructuredMessages([networkMessages, embeddedMessages]);
                status = navigationResponse?.status() || status;
                state = (!hasUsableDomEvidence(evidence) && !hasUsableNetworkEvidence(fallbackMessages))
                    ? detectBlockedOrUnavailable({ status, evidence, failedApiResponses: networkCapture.failedApiResponses })
                    : '';
            } catch (_) {
                // The detailed evidence below is more useful than a reload error.
            }
        }

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

        if (!hasUsableDomEvidence(evidence) && !hasUsableNetworkEvidence(fallbackMessages)) {
            console.warn(`[${requestId}] no messages: status=${status} final=${safeUrlForLog(evidence?.url)} title=${JSON.stringify(evidence?.title || '')} apiFailures=${JSON.stringify(networkCapture.failedApiResponses)} pageErrors=${JSON.stringify(pageErrors)}`);
            throw new ExtractionError(
                `The public ${provider} page opened, but its conversation data was not delivered to the extractor. The provider may have changed its page structure or blocked datacenter browsers.`,
                { status: 502, code: 'CONVERSATION_NOT_DELIVERED' }
            );
        }

        let html = await collectPageHTML(page, provider, url);
        await networkCapture.flush();
        networkMessages = collectStructuredMessages(networkCapture.payloads);
        embeddedMessages = collectEmbeddedStructuredMessages(html);
        fallbackMessages = collectStructuredMessages([networkMessages, embeddedMessages]);
        html = appendNetworkFallback(html, provider, fallbackMessages);

        // Final server-side guard: never report success for a shell/login page that
        // contains no conversation evidence. The browser parser can still choose
        // the richer DOM path when it is present.
        if (!hasUsableDomEvidence(evidence) && !hasUsableNetworkEvidence(fallbackMessages)) {
            throw new ExtractionError('No conversation messages were found after extraction.', {
                status: 502,
                code: 'EMPTY_EXTRACTION'
            });
        }

        console.log(`[${requestId}] extraction succeeded provider=${provider} dom=${evidence.users}/${evidence.assistants} fallbackMessages=${fallbackMessages.length}`);
        return res.json({
            success: true,
            provider,
            html,
            diagnostics: {
                requestId,
                source: hasUsableDomEvidence(evidence) ? 'dom' : 'structured-fallback'
            }
        });
    } catch (error) {
        const status = error instanceof ExtractionError ? error.status : 500;
        const code = error instanceof ExtractionError ? error.code : 'EXTRACTION_FAILED';
        console.error(`[${requestId}] ${code}: ${error.message}`);
        return res.status(status).json({
            success: false,
            code,
            requestId,
            error: error instanceof ExtractionError
                ? error.message
                : 'The conversation could not be extracted due to an unexpected server error.'
        });
    } finally {
        if (browser) {
            try {
                if (remoteBrowser) browser.disconnect();
                else await browser.close();
            } catch (_) {}
        }
    }
});


app.get('/healthz', (req, res) => res.json({ ok: true }));

// Rota coringa para evitar que o DevTools do Chrome suje o terminal com erro 404
// Rota coringa atualizada para o Express 5 (Trata rotas não encontradas)
app.use((req, res) => {
    res.status(404).send('Not found');
});

if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`🚀 Servidor e Programmatic SEO ativos em: http://localhost:${PORT}`);
    });
}

module.exports = {
    app,
    validateShareUrl,
    collectStructuredMessages,
    parsePotentialStructuredBody
};
