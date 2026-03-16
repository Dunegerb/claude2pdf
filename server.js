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
        return res.status(404).sendFile(path.join(__dirname, 'public', 'index.html'));
    }
    res.render('programmatic-seo-page', { data: pageData });
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

    if (!url || typeof url !== 'string' || !url.startsWith('https://claude.ai/share/')) {
        return res.status(400).json({ error: "URL inválida. Use apenas links públicos do Claude." });
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

        // Aguarda a div contendo o chat aparecer (passando do Cloudflare)
        try {
            await page.waitForSelector('.prose, main', { timeout: 15000 });
        } catch (e) {
            console.log("[-] Timeout aguardando as classes. Tentando extrair mesmo assim.");
        }

        const html = await page.content();

        if (html.includes("Just a moment...") || html.includes("Cloudflare")) {
            throw new Error("O link foi protegido pelo Cloudflare e não pôde ser extraído automaticamente. Use o modo Failsafe colando o HTML da página.");
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