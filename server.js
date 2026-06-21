const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');

// Ativa o modo invisível do Puppeteer
puppeteer.use(StealthPlugin());

const app = express();
const PORT = process.env.PORT || 3000;


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
app.use(express.json());

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

async function collectDeepSeekHTML(page, url) {
    return await page.evaluate(async (sourceUrl) => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const items = new Map();

        function getRoot() {
            return document.querySelector('.ds-virtual-list-visible-items');
        }

        function getScrollTarget(root) {
            const candidates = [];
            let current = root;
            while (current) {
                const delta = (current.scrollHeight || 0) - (current.clientHeight || 0);
                const style = window.getComputedStyle ? window.getComputedStyle(current) : null;
                const overflowY = style ? style.overflowY : '';
                if (delta > 20 && /(auto|scroll|overlay)/i.test(overflowY)) candidates.push({ el: current, delta });
                current = current.parentElement;
            }
            [document.scrollingElement, document.documentElement, document.body].filter(Boolean).forEach((el) => {
                candidates.push({ el, delta: (el.scrollHeight || 0) - (el.clientHeight || 0) });
            });
            return candidates.sort((a, b) => b.delta - a.delta)[0]?.el || document.scrollingElement || document.documentElement;
        }

        function cleanClone(node) {
            const clone = node.cloneNode(true);
            clone.querySelectorAll([
                'script', 'style', 'noscript', 'template', 'button', 'input', 'textarea', 'select',
                'iframe', 'canvas', 'audio', 'video', 'svg', '[role="button"]',
                '.ds-think-content', '.ds-button', '.dbe8cf4a'
            ].join(',')).forEach((element) => element.remove());
            return clone;
        }

        function capture() {
            const root = getRoot();
            if (!root) return;

            const nodes = Array.from(root.querySelectorAll('[data-virtual-list-item-key]'));
            nodes.forEach((node, index) => {
                const key = node.getAttribute('data-virtual-list-item-key');
                if (!key || key === '-999') return;

                const assistantContent = node.querySelector('.ds-assistant-message-main-content');
                const userMessage = node.querySelector('.ds-message');
                if (!assistantContent && !userMessage) return;

                const textSource = assistantContent || userMessage;
                const text = (textSource.textContent || '').replace(/\s+/g, ' ').trim();
                if (!text) return;

                const stableKey = key || `${index}:${text.slice(0, 160)}`;
                if (!items.has(stableKey)) items.set(stableKey, cleanClone(node).outerHTML);
            });
        }

        // DeepSeek mounts the virtual-list shell before hydrating the actual
        // conversation turns. Wait for a real item instead of treating the
        // disclaimer item (-999) as conversation content.
        let initialRoot = getRoot();
        for (let attempt = 0; attempt < 50; attempt += 1) {
            const realMessage = initialRoot?.querySelector(
                '[data-virtual-list-item-key]:not([data-virtual-list-item-key="-999"]) .ds-message'
            );
            if (realMessage) break;
            await sleep(160);
            initialRoot = getRoot();
        }
        if (!initialRoot) return '';
        const target = getScrollTarget(initialRoot);
        const setTop = (value) => {
            try {
                if (target === document.body || target === document.documentElement || target === document.scrollingElement) {
                    window.scrollTo(0, value);
                } else {
                    target.scrollTop = value;
                    target.dispatchEvent(new Event('scroll', { bubbles: true }));
                }
            } catch (_) {
                window.scrollTo(0, value);
            }
        };
        const currentTop = () => target.scrollTop || window.scrollY || 0;
        const currentMax = () => Math.max(0, (target.scrollHeight || document.documentElement.scrollHeight || 0) - (target.clientHeight || window.innerHeight || 0));

        setTop(0);
        await sleep(350);
        capture();

        let stagnant = 0;
        for (let step = 0; step < 64; step += 1) {
            const beforeTop = currentTop();
            const beforeCount = items.size;
            const maxTop = currentMax();
            const increment = Math.max(520, Math.floor((target.clientHeight || window.innerHeight || 800) * 0.82));
            setTop(Math.min(maxTop, beforeTop + increment));
            await sleep(120);
            capture();

            const afterTop = currentTop();
            const atBottom = afterTop >= currentMax() - 8 || afterTop === beforeTop;
            const noNewItems = items.size === beforeCount;
            stagnant = (atBottom && noNewItems) ? stagnant + 1 : 0;
            if (stagnant >= 2) break;
        }

        capture();
        setTop(0);

        const ordered = Array.from(items.entries()).sort(([a], [b]) => {
            const numberA = Number(a);
            const numberB = Number(b);
            if (Number.isFinite(numberA) && Number.isFinite(numberB)) return numberA - numberB;
            return String(a).localeCompare(String(b));
        }).map(([, html]) => html).join('\n');

        // An empty virtual-list shell is not a successful extraction. Returning
        // an empty string lets the route fall back to the complete page HTML.
        if (!ordered) return '';

        const title = document.title || '';
        const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute('href') ||
            document.querySelector('meta[property="og:url"]')?.getAttribute('content') || sourceUrl || '';
        const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute('content') || '';
        const escapeAttr = (value) => String(value || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

        return `<!doctype html><html lang="${escapeAttr(document.documentElement.lang || 'en')}"><head>` +
            `<title>${escapeAttr(title)}</title>` +
            `<link rel="canonical" href="${escapeAttr(canonical)}">` +
            `<meta property="og:title" content="${escapeAttr(ogTitle)}">` +
            `</head><body><div class="ds-virtual-list-visible-items">${ordered}</div></body></html>`;
    }, url);
}

// ==========================================
// ROTA DE EXTRAÇÃO (API)
// ==========================================
app.post('/api/extract', limiter, async (req, res) => {
    const { url } = req.body;

    const supportedHosts = new Set([
        'claude.ai',
        'chatgpt.com',
        'gemini.google.com',
        'grok.com',
        'chat.qwen.ai',
        'chat.deepseek.com'
    ]);

    let parsedUrl;
    try {
        parsedUrl = new URL(url);
    } catch (error) {
        return res.status(400).json({ error: "URL inválida. Use um link público de uma plataforma suportada." });
    }

    const hostname = parsedUrl.hostname.toLowerCase();
    const pathname = parsedUrl.pathname;

    if (hostname === 'g.co' && pathname.toLowerCase().includes('/gemini/share/')) {
        return res.status(400).json({ error: "Use the full Gemini share link: https://gemini.google.com/share/..." });
    }

    const providerFromUrl = hostname === 'claude.ai' ? 'claude'
        : hostname === 'chatgpt.com' ? 'chatgpt'
        : hostname === 'gemini.google.com' ? 'gemini'
        : hostname === 'grok.com' ? 'grok'
        : hostname === 'chat.qwen.ai' ? 'qwen'
        : hostname === 'chat.deepseek.com' ? 'deepseek'
        : 'unknown';

    const hasStandardSharePath = /^\/share\/[A-Za-z0-9_-]+\/?$/i.test(pathname);
    const hasQwenSharePath = /^\/s\/[A-Za-z0-9_-]+\/?$/i.test(pathname);
    const isSupportedPath = providerFromUrl === 'qwen' ? hasQwenSharePath : hasStandardSharePath;

    if (
        !url ||
        typeof url !== 'string' ||
        parsedUrl.protocol !== 'https:' ||
        !supportedHosts.has(hostname) ||
        providerFromUrl === 'unknown' ||
        !isSupportedPath
    ) {
        return res.status(400).json({
            error: "Use a supported public share link. Qwen links must use https://chat.qwen.ai/s/... and DeepSeek links must use https://chat.deepseek.com/share/..."
        });
    }

    let browser;
    try {
        console.log(`[+] Iniciando extração para host: ${parsedUrl.hostname}`);
        
        browser = await puppeteer.launch({
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled',
                '--disable-features=IsolateOrigins,site-per-process'
            ]
        });

        const page = await browser.newPage();
        await page.setViewport({ width: 1440, height: 1200, deviceScaleFactor: 1 });

        const provider = providerFromUrl;

        // Otimização conservadora: bloquear CSS/fontes quebrou a hidratação de
        // algumas páginas públicas do ChatGPT/Gemini. Mantemos imagens e mídia
        // bloqueadas, mas permitimos stylesheet/font para preservar o DOM real.
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            const blocked = ['image', 'media'];
            if (blocked.includes(req.resourceType())) {
                req.abort();
            } else {
                req.continue();
            }
        });

        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36');

        // Remove navigator.webdriver flag que o Cloudflare detecta
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        });

        // DeepSeek é uma SPA pesada: precisa de networkidle0 para hidratar.
        // Outros providers carregam mais rápido com domcontentloaded.
        const waitStrategy = provider === 'deepseek' ? 'networkidle0' : 'domcontentloaded';
        await page.goto(url, { waitUntil: waitStrategy, timeout: 45000 });

        // DeepSeek precisa de tempo extra para o React montar a virtual list
        if (provider === 'deepseek') {
            await new Promise(resolve => setTimeout(resolve, 3000));
        }

        // Aguarda conteúdo REAL do chat. Não usamos `main` aqui porque, no Claude,
        // ele aparece antes das respostas da IA serem hidratadas.

        const selectorsByProvider = {
            claude: '[class*="font-user-message"], [class*="font-claude-message"], .prose, [data-test-render="true"]',
            chatgpt: '[data-message-author-role], section[data-turn], [data-testid^="conversation-turn-"]',
            gemini: 'share-turn-viewer, .share-turn-viewer, .query-text, .markdown-main-panel',
            grok: '[data-testid="user-message"], [data-testid="assistant-message"]',
            qwen: '.share-layout-messages .qwen-chat-message',
            deepseek: '.ds-virtual-list-visible-items [data-virtual-list-item-key]:not([data-virtual-list-item-key="-999"]) .ds-message'
        };

        try {
            await page.waitForSelector(selectorsByProvider[provider] || 'body', { timeout: 30000 });
        } catch (e) {
            console.log(`[-] Timeout aguardando conteúdo de ${provider}. Tentando extrair mesmo assim.`);
        }

        // Dá tempo para frameworks client-side finalizarem renderização.
        // ChatGPT é tratado de forma especial: coletamos os turns ao longo do
        // scroll para não perder o começo por virtualização do DOM.
        let html;
        try {
            await page.waitForNetworkIdle({ idleTime: 700, timeout: 10000 }).catch(() => {});

            if (provider === 'chatgpt') {
                html = await collectChatGPTHTML(page, url);
                if (!/data-message-author-role|conversation-turn-|data-turn=/i.test(html)) {
                    html = await page.content();
                }
            } else if (provider === 'qwen') {
                html = await collectQwenHTML(page, url);
                if (!/share-layout-messages|qwen-chat-message/i.test(html)) {
                    html = await page.content();
                }
            } else if (provider === 'deepseek') {
                html = await collectDeepSeekHTML(page, url);
                const hasDeepSeekMessages = /data-virtual-list-item-key=["'](?!-999["'])[^"']+["']/i.test(html || '') &&
                    /ds-message|ds-assistant-message-main-content/i.test(html || '');
                if (!hasDeepSeekMessages) {
                    console.log(`[-] DeepSeek collector retornou vazio. Tentando page.content()...`);
                    html = await page.content();
                    const hasCfChallenge = /cf-turnstile|cf-overlay|challenges\.cloudflare/i.test(html || '');
                    const hasVirtualList = /ds-virtual-list-visible-items/i.test(html || '');
                    console.log(`[-] DeepSeek fallback: cloudflare=${hasCfChallenge}, virtualList=${hasVirtualList}, htmlLen=${(html||'').length}`);
                }
            } else {
                await page.evaluate(async () => {
                    await new Promise((resolve) => {
                        let totalHeight = 0;
                        const distance = 650;
                        const maxHeight = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
                        const timer = setInterval(() => {
                            window.scrollBy(0, distance);
                            totalHeight += distance;
                            if (totalHeight >= maxHeight + distance) {
                                clearInterval(timer);
                                window.scrollTo(0, 0);
                                resolve();
                            }
                        }, 140);
                    });
                });
                await new Promise(resolve => setTimeout(resolve, provider === 'gemini' ? 1600 : 900));
                html = await page.content();
            }
        } catch (e) {
            html = await page.content();
        }

        if (html.includes("Just a moment...") || html.includes("Cloudflare")) {
            throw new Error("O link foi protegido ou não pôde ser extraído automaticamente. Tente novamente com um link público /share/.");
        }

        console.log(`[+] Extração concluída com sucesso.`);
        res.json({ success: true, html: html });

    } catch (error) {
        console.error(`[-] Erro:`, error.message);
        res.status(500).json({ error: "Falha ao extrair. " + error.message });
    } finally {
        if (browser) await browser.close();
    }
});

// Rota coringa para evitar que o DevTools do Chrome suje o terminal com erro 404
// Rota coringa atualizada para o Express 5 (Trata rotas não encontradas)
app.use((req, res) => {
    res.status(404).send('Not found');
});

app.listen(PORT, () => {
    console.log(`🚀 Servidor e Programmatic SEO ativos em: http://localhost:${PORT}`);
});