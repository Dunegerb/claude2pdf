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


async function collectChatGPTConversationHTML(page, sourceUrl) {
    const collected = await page.evaluate(async (sourceUrl) => {
        const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
        const normalizeText = (value) => String(value || '')
            .replace(/[\u200B-\u200D\uFEFF]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
        const hashText = (value) => {
            let hash = 0;
            const text = normalizeText(value);
            for (let i = 0; i < text.length; i += 1) {
                hash = ((hash << 5) - hash) + text.charCodeAt(i);
                hash |= 0;
            }
            return Math.abs(hash).toString(36);
        };
        const isNoise = (text) => {
            const value = normalizeText(text).toLowerCase();
            if (!value) return true;
            return [
                'this is a copy of a shared chatgpt conversation',
                'report conversation',
                'error loading app failed to fetch template',
                'failed to fetch template retry',
                'chatgpt can make mistakes',
                'terms of use',
                'privacy policy'
            ].some(noise => value.includes(noise));
        };
        const scrollElement = () => {
            const candidates = [
                document.scrollingElement,
                document.documentElement,
                document.body,
                ...Array.from(document.querySelectorAll('main, [class*="scroll"], [class*="overflow"], [data-testid]'))
            ].filter(Boolean);

            return candidates
                .filter(el => (el.scrollHeight || 0) > (el.clientHeight || 0) + 80)
                .sort((a, b) => ((b.scrollHeight || 0) - (b.clientHeight || 0)) - ((a.scrollHeight || 0) - (a.clientHeight || 0)))[0]
                || document.scrollingElement
                || document.documentElement
                || document.body;
        };
        const turns = new Map();
        const order = [];

        function getRole(section) {
            const raw = section.getAttribute('data-turn') ||
                section.querySelector('[data-message-author-role]')?.getAttribute('data-message-author-role') ||
                '';
            if (/user/i.test(raw)) return 'user';
            if (/assistant/i.test(raw)) return 'assistant';
            return '';
        }

        function getTurnCandidates() {
            const nodes = Array.from(document.querySelectorAll([
                'section[data-turn]',
                'section[data-testid^="conversation-turn-"]',
                '[data-testid^="conversation-turn-"][data-turn]'
            ].join(',')));

            // Some ChatGPT builds expose only message-role nodes while the section wrapper
            // is virtualized. Promote each role node to its nearest useful container.
            Array.from(document.querySelectorAll('[data-message-author-role]')).forEach((messageNode) => {
                const container = messageNode.closest('section[data-turn], section[data-testid^="conversation-turn-"]') || messageNode;
                if (!nodes.includes(container)) nodes.push(container);
            });
            return nodes;
        }

        function captureVisibleTurns() {
            getTurnCandidates().forEach((node) => {
                const role = getRole(node);
                if (!role) return;
                const text = normalizeText(node.textContent);
                if (isNoise(text)) return;

                const key = node.getAttribute('data-turn-id') ||
                    node.getAttribute('data-turn-id-container') ||
                    node.getAttribute('data-testid') ||
                    node.querySelector('[data-message-id]')?.getAttribute('data-message-id') ||
                    `${role}:${hashText(text)}`;

                const html = node.outerHTML || '';
                if (!html) return;

                if (!turns.has(key)) {
                    turns.set(key, { html, textLength: text.length });
                    order.push(key);
                    return;
                }

                // If the same turn is re-rendered later with richer markdown, keep the richer copy.
                const previous = turns.get(key);
                if (text.length > previous.textLength || html.length > previous.html.length) {
                    turns.set(key, { html, textLength: text.length });
                }
            });
        }

        async function jumpToTop() {
            const scroller = scrollElement();
            if (scroller && scroller.scrollTo) scroller.scrollTo(0, 0);
            if (scroller) scroller.scrollTop = 0;
            window.scrollTo(0, 0);
            document.documentElement.scrollTop = 0;
            document.body.scrollTop = 0;
            await sleep(900);
            captureVisibleTurns();

            // A second top jump is intentional. ChatGPT shared pages sometimes restore
            // an internal scroll position shortly after hydration.
            const scrollerAgain = scrollElement();
            if (scrollerAgain && scrollerAgain.scrollTo) scrollerAgain.scrollTo(0, 0);
            if (scrollerAgain) scrollerAgain.scrollTop = 0;
            window.scrollTo(0, 0);
            document.documentElement.scrollTop = 0;
            document.body.scrollTop = 0;
            await sleep(700);
            captureVisibleTurns();
        }

        await jumpToTop();

        let lastScrollTop = -1;
        let stableSteps = 0;
        const maxSteps = 180;

        for (let step = 0; step < maxSteps; step += 1) {
            const scroller = scrollElement();
            const viewport = window.innerHeight || document.documentElement.clientHeight || 800;
            const distance = Math.max(420, Math.floor(viewport * 0.62));

            captureVisibleTurns();
            if (scroller && scroller !== document.documentElement && scroller !== document.body && scroller !== document.scrollingElement && scroller.scrollBy) {
                scroller.scrollBy(0, distance);
            } else {
                window.scrollBy(0, distance);
            }
            await sleep(520);
            captureVisibleTurns();

            const currentTop = scroller.scrollTop || window.scrollY || 0;
            const maxTop = Math.max(0, (scroller.scrollHeight || document.body.scrollHeight || 0) - viewport);

            if (Math.abs(currentTop - lastScrollTop) < 4) stableSteps += 1;
            else stableSteps = 0;
            lastScrollTop = currentTop;

            if (currentTop >= maxTop - 8 || stableSteps >= 5) break;
        }

        await sleep(650);
        captureVisibleTurns();
        const finalScroller = scrollElement();
        if (finalScroller && finalScroller.scrollTo) finalScroller.scrollTo(0, 0);
        if (finalScroller) finalScroller.scrollTop = 0;
        window.scrollTo(0, 0);

        const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute('href') || sourceUrl || '';
        const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute('content') || '';
        const title = document.title || ogTitle || 'ChatGPT Conversation';
        const collectedHTML = order.map(key => turns.get(key)?.html || '').filter(Boolean).join('\n');

        return `<!doctype html>
<html lang="${document.documentElement.getAttribute('lang') || 'en'}">
<head>
  <meta charset="utf-8">
  <title>${title.replace(/</g, '&lt;')}</title>
  <meta property="og:site_name" content="ChatGPT">
  <meta property="og:title" content="${String(ogTitle || title).replace(/"/g, '&quot;')}">
  <link rel="canonical" href="${String(canonical).replace(/"/g, '&quot;')}">
</head>
<body>
  <main id="c2p-collected-chatgpt" data-provider="chatgpt" data-collected-turns="${order.length}">
    ${collectedHTML}
  </main>
</body>
</html>`;
    }, sourceUrl);

    return collected;
}

// ==========================================
// ROTA DE EXTRAÇÃO (API)
// ==========================================
app.post('/api/extract', limiter, async (req, res) => {
    const { url } = req.body;

    const supportedHosts = [
        'claude.ai',
        'chatgpt.com',
        'gemini.google.com',
        'grok.com'
    ];

    let parsedUrl;
    try {
        parsedUrl = new URL(url);
    } catch (error) {
        return res.status(400).json({ error: "URL inválida. Use um link público de Claude, ChatGPT, Gemini ou Grok." });
    }

    const isSupportedHost = supportedHosts.includes(parsedUrl.hostname);
    const isSupportedPath = parsedUrl.pathname.includes('/share/');

    if (!url || typeof url !== 'string' || parsedUrl.protocol !== 'https:' || !isSupportedHost || !isSupportedPath) {
        return res.status(400).json({ error: "URL inválida. Use links públicos /share/ de Claude, ChatGPT, Gemini ou Grok." });
    }

    let browser;
    try {
        console.log(`[+] Iniciando extração para: ${url}`);
        
        browser = await puppeteer.launch({
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled'
            ]
        });

        const page = await browser.newPage();

        const provider = parsedUrl.hostname.includes('claude.ai') ? 'claude'
            : parsedUrl.hostname.includes('chatgpt.com') ? 'chatgpt'
            : parsedUrl.hostname.includes('gemini.google.com') ? 'gemini'
            : parsedUrl.hostname.includes('grok.com') ? 'grok'
            : 'unknown';

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

        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        // Acessa a página
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

        // Aguarda conteúdo REAL do chat. Não usamos `main` aqui porque, no Claude,
        // ele aparece antes das respostas da IA serem hidratadas.

        const selectorsByProvider = {
            claude: '[class*="font-user-message"], [class*="font-claude-message"], .prose, [data-test-render="true"]',
            chatgpt: '[data-message-author-role], section[data-turn], [data-testid^="conversation-turn-"]',
            gemini: 'share-turn-viewer, .share-turn-viewer, .query-text, .markdown-main-panel',
            grok: '[data-testid="user-message"], [data-testid="assistant-message"]'
        };

        try {
            await page.waitForSelector(selectorsByProvider[provider] || 'body', { timeout: 30000 });
        } catch (e) {
            console.log(`[-] Timeout aguardando conteúdo de ${provider}. Tentando extrair mesmo assim.`);
        }

        // Dá tempo para frameworks client-side finalizarem renderização.
        // ChatGPT usa virtualização de conversa: se fizermos um único page.content()
        // após rolar até o fim, o começo da conversa pode sair do DOM. Por isso,
        // coletamos os turnos incrementalmente, do topo para o fim, antes de devolver o HTML.
        let html;
        try {
            await page.waitForNetworkIdle({ idleTime: 700, timeout: 10000 }).catch(() => {});

            if (provider === 'chatgpt') {
                html = await collectChatGPTConversationHTML(page, url);
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
            if (provider === 'chatgpt') {
                console.log(`[-] Coleta incremental do ChatGPT falhou. Usando page.content(). Motivo: ${e.message}`);
            }
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