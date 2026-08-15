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
    // ChatGPT virtualizes long conversations. A single page.content() snapshot can
    // therefore contain only the currently mounted slice. Walk the real scroll root,
    // keep snapshots of every turn we see, and update a turn when hydration later
    // replaces a placeholder/partial response with richer content.
    return await page.evaluate(async (sourceUrl) => {
        const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
        const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();

        function getScrollTarget() {
            const explicit = document.querySelector('[data-scroll-root]');
            if (explicit) return explicit;
            const candidates = [document.scrollingElement, document.documentElement, document.body,
                ...Array.from(document.querySelectorAll('main, [class*="overflow-y-auto"], [class*="overflow-y-scroll"], [class*="scroll"]'))];
            return candidates
                .filter(Boolean)
                .map((el) => ({ el, delta: (el.scrollHeight || 0) - (el.clientHeight || 0) }))
                .sort((a, b) => b.delta - a.delta)[0]?.el || document.scrollingElement || document.documentElement;
        }

        function cleanClone(node) {
            const clone = node.cloneNode(true);
            clone.querySelectorAll([
                'script', 'style', 'noscript', 'template', 'input', 'textarea', 'select',
                'nav', 'footer', 'aside', 'form', 'iframe', 'canvas', 'audio', 'video',
                '[aria-hidden="true"]', '.sr-only', '.hidden',
                '[class*="copy-button"]', '[class*="popover"]', '[class*="tooltip"]',
                '[data-testid*="action"]', '[data-testid*="copy"]'
            ].join(',')).forEach(el => el.remove());
            Array.from(clone.querySelectorAll('button')).forEach((button) => {
                if (!/thought for/i.test(normalize(button.textContent))) button.remove();
            });
            return clone;
        }

        function roleFor(node) {
            const explicit = node.getAttribute('data-turn') || node.getAttribute('data-message-author-role') ||
                node.querySelector('[data-message-author-role]')?.getAttribute('data-message-author-role') || '';
            if (/user/i.test(explicit)) return 'user';
            if (/assistant/i.test(explicit)) return 'assistant';
            return '';
        }

        function orderFor(node, fallback) {
            const values = [
                node.getAttribute('data-turn-index'),
                node.getAttribute('data-index'),
                node.getAttribute('data-testid'),
                node.id
            ].filter(Boolean).join(' ');
            const match = values.match(/conversation-turn-(\d+)|(?:turn|message)[-_]?(\d+)/i);
            const numeric = match ? Number(match[1] || match[2]) : NaN;
            return Number.isFinite(numeric) ? numeric : fallback;
        }

        function turnKey(node, role, fallback) {
            return node.getAttribute('data-turn-id') ||
                node.getAttribute('data-turn-id-container') ||
                node.getAttribute('data-testid') ||
                node.id ||
                `${role}:${normalize(node.textContent).slice(0, 260)}:${fallback}`;
        }

        const turns = new Map();
        let sequence = 0;
        let totalTextLength = 0;

        function turnNodes() {
            const explicit = Array.from(document.querySelectorAll([
                'section[data-turn]', 'article[data-turn]',
                '[data-testid^="conversation-turn-"]'
            ].join(',')));
            if (explicit.length) return [...new Set(explicit)];

            // Fallback for UI variants that expose only role wrappers.
            return Array.from(document.querySelectorAll('[data-message-author-role]')).filter((node) => {
                const parentRole = node.parentElement?.closest?.('[data-message-author-role]');
                return !parentRole;
            });
        }

        function capture() {
            let changed = 0;
            turnNodes().forEach((node) => {
                const role = roleFor(node);
                const text = normalize(node.textContent);
                if (!role || !text) return;

                const observed = sequence++;
                const key = turnKey(node, role, observed);
                const clone = cleanClone(node);
                const html = clone.outerHTML;
                const textLength = text.length;
                const existing = turns.get(key);

                if (!existing) {
                    turns.set(key, { html, role, textLength, htmlLength: html.length, order: orderFor(node, observed), firstSeen: observed });
                    totalTextLength += textLength;
                    changed += 1;
                    return;
                }

                // Hydration/streaming can make an already-seen turn substantially richer.
                if (textLength > existing.textLength || html.length > existing.htmlLength * 1.08) {
                    totalTextLength += Math.max(0, textLength - existing.textLength);
                    existing.html = html;
                    existing.textLength = Math.max(existing.textLength, textLength);
                    existing.htmlLength = Math.max(existing.htmlLength, html.length);
                    changed += 1;
                }
            });
            return { count: turns.size, textLength: totalTextLength, changed };
        }

        function clickExpansionButtons() {
            const buttons = Array.from(document.querySelectorAll('#thread button, main button'));
            let clicked = 0;
            buttons.forEach((button) => {
                const label = normalize(`${button.getAttribute('aria-label') || ''} ${button.textContent || ''}`);
                if (!/(show more|see more|load more|continue reading|expand response|expand text)/i.test(label)) return;
                if (/log in|sign up|continue chat|continue conversation/i.test(label)) return;
                try { button.click(); clicked += 1; } catch (_) {}
            });
            return clicked;
        }

        const target = getScrollTarget();
        const viewport = Math.max(650, target.clientHeight || window.innerHeight || 900);
        const stepSize = Math.max(520, Math.floor(viewport * 0.82));
        const maxSteps = 120;
        let stableBottomCycles = 0;
        let previousSignature = '';

        try { target.scrollTo?.(0, 0); } catch (_) { window.scrollTo(0, 0); }
        await sleep(900);
        clickExpansionButtons();
        capture();

        for (let i = 0; i < maxSteps; i += 1) {
            if (i % 4 === 0) clickExpansionButtons();
            const beforeTop = target.scrollTop || window.scrollY || 0;
            const beforeHeight = target.scrollHeight || document.documentElement.scrollHeight || 0;

            try { target.scrollBy?.(0, stepSize); } catch (_) { window.scrollBy(0, stepSize); }
            await sleep(360);
            let metrics = capture();

            let afterTop = target.scrollTop || window.scrollY || 0;
            let afterHeight = target.scrollHeight || document.documentElement.scrollHeight || 0;
            let maxTop = Math.max(0, afterHeight - (target.clientHeight || window.innerHeight || 0));
            let atBottom = afterTop >= maxTop - 16 || (afterTop === beforeTop && afterHeight <= beforeHeight);

            if (atBottom) {
                // Lazy hydration at the bottom often takes longer than one animation frame.
                await sleep(900);
                clickExpansionButtons();
                metrics = capture();

                try {
                    target.scrollBy?.(0, -Math.min(320, Math.floor(stepSize / 3)));
                    await sleep(180);
                    target.scrollTo?.(0, target.scrollHeight || 0);
                } catch (_) {
                    window.scrollBy(0, -260);
                    await sleep(180);
                    window.scrollTo(0, document.documentElement.scrollHeight || 0);
                }
                await sleep(520);
                metrics = capture();

                afterTop = target.scrollTop || window.scrollY || 0;
                afterHeight = target.scrollHeight || document.documentElement.scrollHeight || 0;
                maxTop = Math.max(0, afterHeight - (target.clientHeight || window.innerHeight || 0));
                const signature = `${metrics.count}:${metrics.textLength}:${afterHeight}:${Math.round(afterTop)}`;
                if (signature === previousSignature && afterTop >= maxTop - 20) stableBottomCycles += 1;
                else stableBottomCycles = 0;
                previousSignature = signature;
                if (stableBottomCycles >= 4) break;
            } else {
                stableBottomCycles = 0;
                previousSignature = `${metrics.count}:${metrics.textLength}:${afterHeight}:${Math.round(afterTop)}`;
            }
        }

        // One reverse pass catches virtualized turns that may have been replaced while
        // later content was loading and lets us refresh richer copies of earlier turns.
        const bottom = Math.max(0, (target.scrollHeight || document.documentElement.scrollHeight || 0) - (target.clientHeight || window.innerHeight || 0));
        for (let pos = bottom; pos > 0; pos -= Math.floor(stepSize * 1.15)) {
            try { target.scrollTo?.(0, Math.max(0, pos)); } catch (_) { window.scrollTo(0, Math.max(0, pos)); }
            await sleep(150);
            capture();
        }
        try { target.scrollTo?.(0, 0); } catch (_) { window.scrollTo(0, 0); }
        await sleep(300);
        clickExpansionButtons();
        capture();

        // Revisit the bottom once more: a last assistant response can mount only after
        // the page has completed the previous lazy-load cycle.
        try { target.scrollTo?.(0, target.scrollHeight || 0); } catch (_) { window.scrollTo(0, document.documentElement.scrollHeight || 0); }
        await sleep(900);
        clickExpansionButtons();
        capture();

        const title = document.title || '';
        const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute('href') || sourceUrl || '';
        const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute('content') || '';
        const ogDescription = document.querySelector('meta[property="og:description"]')?.getAttribute('content') || '';
        const escapeAttr = (value) => String(value || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

        const orderedTurns = Array.from(turns.values())
            .sort((a, b) => a.order === b.order ? a.firstSeen - b.firstSeen : a.order - b.order)
            .map(item => item.html);

        return `<!doctype html><html lang="${escapeAttr(document.documentElement.lang || 'en')}"><head>` +
            `<title>${escapeAttr(title)}</title>` +
            `<link rel="canonical" href="${escapeAttr(canonical)}">` +
            `<meta property="og:title" content="${escapeAttr(ogTitle)}">` +
            `<meta property="og:description" content="${escapeAttr(ogDescription)}">` +
            `</head><body><main id="c2p-collected-chatgpt" data-provider="chatgpt" data-collected-turns="${orderedTurns.length}">${orderedTurns.join('\n')}</main></body></html>`;
    }, url);
}

async function collectClaudeHTML(page, url) {
    // Claude's current public-share DOM exposes user turns as data-testid="user-message"
    // and assistant turns as .font-claude-response containing .standard-markdown /
    // .progressive-markdown. Capture those rendered nodes directly so network/script
    // Markdown remains a last-resort fallback rather than replacing semantic HTML.
    return await page.evaluate(async (sourceUrl) => {
        const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
        const normalize = (value) => String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
        const escapeAttr = (value) => String(value || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

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
            if (node.matches?.('.font-claude-response, [class*="font-claude-message"], [data-testid="assistant-message"], [data-message-author-role="assistant"]')) return 'assistant';
            return '';
        }

        function contentFor(node, role) {
            if (role === 'assistant') {
                // Keep the outer Claude response root when available: tool-status rows can
                // sit beside the markdown body. parser.js will sanitize UI chrome later.
                if (node.matches?.('.font-claude-response, [class*="font-claude-message"]')) return node;
                return node.closest?.('.font-claude-response, [class*="font-claude-message"]') ||
                    node.querySelector?.('.standard-markdown, .progressive-markdown, [class*="markdown"]') || node;
            }
            return node;
        }

        function turnNodes() {
            const users = Array.from(document.querySelectorAll(
                '[data-testid="user-message"], [class*="font-user-message"], [data-message-author-role="user"]'
            ));
            const assistants = Array.from(document.querySelectorAll(
                '.font-claude-response, [class*="font-claude-message"], [data-testid="assistant-message"], [data-message-author-role="assistant"]'
            )).filter((node) => {
                // Do not capture nested wrappers for the same response twice.
                const parent = node.parentElement?.closest?.('.font-claude-response, [class*="font-claude-message"]');
                return !parent;
            });
            return [...new Set([...users, ...assistants])].sort((a, b) => {
                if (a === b) return 0;
                return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
            });
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

        const turns = new Map();
        let sequence = 0;

        function capture() {
            const occurrences = new Map();
            let changed = 0;
            turnNodes().forEach((node, domIndex) => {
                const role = roleFor(node);
                const content = contentFor(node, role);
                const text = normalize(content?.innerText || content?.textContent || '');
                if (!role || !text) return;

                const base = `${role}:${text.slice(0, 12000)}`;
                const occurrence = occurrences.get(base) || 0;
                occurrences.set(base, occurrence + 1);
                const key = `${base}:${occurrence}`;

                const clone = cleanClone(content);
                const html = clone.outerHTML;
                const richness = semanticRichness(content);
                const existing = turns.get(key);
                const order = existing?.order ?? sequence++;

                if (!existing || richness > existing.richness || html.length > existing.html.length * 1.08) {
                    turns.set(key, { role, text, html, richness, order, domIndex });
                    changed += 1;
                }
            });
            return changed;
        }

        const target = getScrollTarget();
        const viewport = Math.max(650, target.clientHeight || window.innerHeight || 900);
        const step = Math.max(480, Math.floor(viewport * 0.78));
        let previousSignature = '';
        let stableBottom = 0;

        try { target.scrollTo?.(0, 0); } catch (_) { window.scrollTo(0, 0); }
        await sleep(450);
        capture();

        for (let i = 0; i < 100; i += 1) {
            const beforeTop = target.scrollTop || window.scrollY || 0;
            try { target.scrollBy?.(0, step); } catch (_) { window.scrollBy(0, step); }
            await sleep(220);
            capture();

            const top = target.scrollTop || window.scrollY || 0;
            const height = target.scrollHeight || document.documentElement.scrollHeight || 0;
            const client = target.clientHeight || window.innerHeight || 0;
            const maxTop = Math.max(0, height - client);
            const signature = `${turns.size}:${height}:${Math.round(top)}`;
            const atBottom = top >= maxTop - 16 || top === beforeTop;

            if (atBottom && signature === previousSignature) stableBottom += 1;
            else stableBottom = 0;
            previousSignature = signature;
            if (stableBottom >= 3) break;
        }

        // Reverse pass covers pages that virtualize earlier rows while scrolling down.
        const bottom = Math.max(0, (target.scrollHeight || 0) - (target.clientHeight || window.innerHeight || 0));
        for (let pos = bottom; pos > 0; pos -= Math.floor(step * 1.15)) {
            try { target.scrollTo?.(0, Math.max(0, pos)); } catch (_) { window.scrollTo(0, Math.max(0, pos)); }
            await sleep(140);
            capture();
        }
        try { target.scrollTo?.(0, 0); } catch (_) { window.scrollTo(0, 0); }
        await sleep(180);
        capture();

        const ordered = Array.from(turns.values())
            .sort((a, b) => a.order - b.order)
            .map((turn, index) =>
                `<section data-c2p-claude-turn="${index}" data-message-author-role="${turn.role}" data-c2p-richness="${turn.richness}">` +
                `<div class="c2p-claude-content">${turn.html}</div></section>`
            );

        if (!ordered.length) return '';
        const title = document.querySelector('meta[property="og:title"]')?.getAttribute('content') || document.title || '';
        const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute('href') || sourceUrl || '';
        return `<!doctype html><html lang="${escapeAttr(document.documentElement.lang || 'en')}"><head>` +
            `<title>${escapeAttr(title)}</title><link rel="canonical" href="${escapeAttr(canonical)}">` +
            `<meta property="og:title" content="${escapeAttr(title)}"></head>` +
            `<body><main id="c2p-collected-claude" data-provider="claude" data-collected-turns="${ordered.length}">${ordered.join('\n')}</main></body></html>`;
    }, url);
}

async function collectGeminiHTML(page, url) {
    // Gemini's public share route hydrates Angular custom elements asynchronously.
    // Wait for complete user/assistant pairs and snapshot only the share viewer so a
    // slow app shell or sign-in chrome cannot make a valid public chat look empty.
    return await page.evaluate(async (sourceUrl) => {
        const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
        const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const scrollTarget = document.scrollingElement || document.documentElement;

        function expandPrompts() {
            Array.from(document.querySelectorAll('[data-test-id="luminous-expand-button"], button[aria-label="Expand"]')).forEach((button) => {
                try { button.click(); } catch (_) {}
            });
        }

        function metrics() {
            const turns = Array.from(document.querySelectorAll('share-viewer share-turn-viewer, .share-viewer share-turn-viewer'));
            let users = 0;
            let assistants = 0;
            let textLength = 0;
            turns.forEach((turn) => {
                const user = turn.querySelector('user-query .query-text, user-query-content .query-text, .query-text');
                const assistant = turn.querySelector('response-container message-content .markdown-main-panel, response-container .markdown-main-panel, message-content .markdown-main-panel, .markdown-main-panel');
                const userText = normalize(user?.textContent);
                const assistantText = normalize(assistant?.textContent);
                if (userText) { users += 1; textLength += userText.length; }
                if (assistantText) { assistants += 1; textLength += assistantText.length; }
            });
            return { turns: turns.length, users, assistants, textLength, height: scrollTarget.scrollHeight || 0 };
        }

        let stable = 0;
        let previous = '';
        for (let i = 0; i < 42; i += 1) {
            expandPrompts();
            const m = metrics();
            const signature = `${m.turns}:${m.users}:${m.assistants}:${m.textLength}:${m.height}`;
            if (m.users > 0 && m.assistants > 0 && signature === previous) stable += 1;
            else stable = 0;
            previous = signature;
            if (stable >= 3) break;

            if (i % 3 === 0) {
                try { scrollTarget.scrollTo?.(0, scrollTarget.scrollHeight || 0); } catch (_) { window.scrollTo(0, document.documentElement.scrollHeight || 0); }
            }
            await sleep(550);
        }

        expandPrompts();
        await sleep(350);
        const root = document.querySelector('share-viewer') || document.querySelector('.share-landing-page_content');
        if (!root) return '';

        const clone = root.cloneNode(true);
        clone.querySelectorAll([
            'script', 'style', 'noscript', 'template', 'button', 'input', 'textarea', 'select',
            'iframe', 'canvas', 'audio', 'video', '.luminous-actions-container', '.link-action-buttons',
            '.response-container-header', '.response-container-footer', '.share-viewer_legal-links', '.share-viewer_footer',
            '[data-test-id="prompt-copy-button"]', '[data-test-id="report-link"]'
        ].join(',')).forEach((node) => node.remove());

        const title = document.querySelector('share-viewer .headline strong, .share-viewer .headline strong')?.textContent?.trim() || document.title || '';
        const date = document.querySelector('share-viewer .publish-time, .share-viewer .publish-time')?.textContent?.trim() || '';
        const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute('href') || sourceUrl || '';
        const escapeAttr = (value) => String(value || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

        return `<!doctype html><html lang="${escapeAttr(document.documentElement.lang || 'en')}"><head>` +
            `<title>${escapeAttr(title)}</title><link rel="canonical" href="${escapeAttr(canonical)}"></head>` +
            `<body><div class="publish-time">${escapeAttr(date)}</div><main id="c2p-collected-gemini" data-provider="gemini">${clone.outerHTML}</main></body></html>`;
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
    const deadline = Date.now() + Math.max(1000, timeout || 0);
    let stable = 0;
    let previous = '';

    while (Date.now() < deadline) {
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

async function collectPageHTML(page, provider, url) {
    try {
        await page.waitForNetworkIdle({ idleTime: 650, timeout: 7000 }).catch(() => {});

        if (provider === 'chatgpt') {
            let html = await collectChatGPTHTML(page, url);
            if (!/data-message-author-role|conversation-turn-|data-turn=/i.test(html)) html = await page.content();
            return html;
        }

        if (provider === 'claude') {
            let html = await collectClaudeHTML(page, url);
            if (!/data-c2p-claude-turn|font-claude-response|standard-markdown|progressive-markdown/i.test(html)) html = await page.content();
            return html;
        }

        if (provider === 'gemini') {
            let html = await collectGeminiHTML(page, url);
            if (!/share-turn-viewer|markdown-main-panel|query-text/i.test(html)) html = await page.content();
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

        // Keep images available: some shared Gemini/ChatGPT responses only finish
        // mounting after image-backed content resolves. We block video/audio only.
        await page.setRequestInterception(true);
        page.on('request', (request) => {
            const operation = request.resourceType() === 'media'
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

        await waitForConversation(page, provider, provider === 'gemini' ? 26000 : 18000);
        await networkCapture.flush();

        let evidence = await inspectConversationDOM(page, provider);
        let networkMessages = collectStructuredMessages(networkCapture.payloads);
        let embeddedMessages = [];
        let fallbackMessages = collectStructuredMessages(networkMessages);
        let html = '';
        let htmlEvidence = { users: 0, assistants: 0, textLength: 0 };
        let status = navigationResponse?.status() || 0;

        // Do not reject a page just because the first live-DOM poll was early.
        // Provider-specific collectors can trigger lazy hydration and produce a
        // stable snapshot even when the shell initially exposes only one side.
        if (!hasUsableDomEvidence(evidence) && !hasUsableNetworkEvidence(fallbackMessages)) {
            html = await collectPageHTML(page, provider, url);
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

        // One retry is still useful for a transient provider hydration failure, but
        // on retry we always run the provider collector before declaring failure.
        if (!hasConversationEvidence && !state) {
            console.log(`[${requestId}] no complete conversation evidence after first load; retrying hydration once`);
            try {
                navigationResponse = await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }) || navigationResponse;
                await waitForConversation(page, provider, provider === 'gemini' ? 18000 : 11000);
                await networkCapture.flush();
                evidence = await inspectConversationDOM(page, provider);
                networkMessages = collectStructuredMessages(networkCapture.payloads);

                html = await collectPageHTML(page, provider, url);
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

        if (!hasConversationEvidence) {
            console.warn(`[${requestId}] no messages: status=${status} final=${safeUrlForLog(evidence?.url)} title=${JSON.stringify(evidence?.title || '')} dom=${evidence?.users || 0}/${evidence?.assistants || 0} collected=${htmlEvidence.users}/${htmlEvidence.assistants} apiFailures=${JSON.stringify(networkCapture.failedApiResponses)} pageErrors=${JSON.stringify(pageErrors)}`);
            throw new ExtractionError(
                `The public ${provider} page opened, but its conversation data was not delivered to the extractor. The provider may have changed its page structure or blocked datacenter browsers.`,
                { status: 502, code: 'CONVERSATION_NOT_DELIVERED' }
            );
        }

        if (!html) html = await collectPageHTML(page, provider, url);
        htmlEvidence = inspectCollectedHTMLEvidence(html, provider);
        await networkCapture.flush();
        networkMessages = collectStructuredMessages(networkCapture.payloads);
        embeddedMessages = collectEmbeddedStructuredMessages(html);
        fallbackMessages = collectStructuredMessages([networkMessages, embeddedMessages]);
        html = appendNetworkFallback(html, provider, fallbackMessages);

        // Final guard accepts any independently useful extraction path. This is
        // especially important for Gemini, where the custom-element snapshot may
        // be valid even if the earlier live-DOM poll happened during hydration.
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
        console.log(`[${requestId}] extraction succeeded provider=${provider} dom=${evidence.users}/${evidence.assistants} collected=${htmlEvidence.users}/${htmlEvidence.assistants} fallbackMessages=${fallbackMessages.length}`);
        return res.json({
            success: true,
            provider,
            html,
            diagnostics: {
                requestId,
                source,
                domMessages: { users: evidence.users || 0, assistants: evidence.assistants || 0 },
                collectedMessages: { users: htmlEvidence.users || 0, assistants: htmlEvidence.assistants || 0 },
                structuredMessages: fallbackMessages.length
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
