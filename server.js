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

        // Otimização: Bloqueia recursos inúteis para focar só no texto
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
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
        const provider = parsedUrl.hostname.includes('claude.ai') ? 'claude'
            : parsedUrl.hostname.includes('chatgpt.com') ? 'chatgpt'
            : parsedUrl.hostname.includes('gemini.google.com') ? 'gemini'
            : parsedUrl.hostname.includes('grok.com') ? 'grok'
            : 'unknown';

        const selectorsByProvider = {
            claude: '[class*="font-user-message"], [class*="font-claude-message"], .prose, [data-test-render="true"]',
            chatgpt: '[data-message-author-role], section[data-turn], [data-testid^="conversation-turn-"]',
            gemini: 'share-turn-viewer, .share-turn-viewer, .query-text, .markdown-main-panel',
            grok: '[data-testid="user-message"], [data-testid="assistant-message"]'
        };

        try {
            await page.waitForSelector(selectorsByProvider[provider] || 'body', { timeout: 22000 });
        } catch (e) {
            console.log(`[-] Timeout aguardando conteúdo de ${provider}. Tentando extrair mesmo assim.`);
        }

        // Dá tempo para frameworks client-side finalizarem renderização e força lazy content.
        try {
            await page.evaluate(async () => {
                await new Promise((resolve) => {
                    let totalHeight = 0;
                    const distance = 700;
                    const timer = setInterval(() => {
                        window.scrollBy(0, distance);
                        totalHeight += distance;
                        if (totalHeight >= document.body.scrollHeight) {
                            clearInterval(timer);
                            window.scrollTo(0, 0);
                            resolve();
                        }
                    }, 120);
                });
            });
            await new Promise(resolve => setTimeout(resolve, 900));
        } catch (e) {}

        const html = await page.content();

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