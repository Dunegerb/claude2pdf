(function () {
  'use strict';

  const STORAGE_KEYS = {
    sourceUrl: 'claude2pdf:sourceUrl',
    conversation: 'claude2pdf:conversation',
    error: 'claude2pdf:error'
  };

  const DEFAULT_BRAND = 'made by.: claude2pdf.up.railway.app';

  function parseDocument(htmlText) {
    return new DOMParser().parseFromString(String(htmlText || ''), 'text/html');
  }

  function textOf(node) {
    return (node && node.textContent ? node.textContent : '').replace(/\s+/g, ' ').trim();
  }

  function htmlOf(node) {
    return node ? node.innerHTML.trim() : '';
  }

  function escapeHTML(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function stripCommonTitleNoise(title) {
    return String(title || '')
      .replace(/\s*\|\s*(Shared )?(ChatGPT|Claude|Gemini|Grok).*$/i, '')
      .replace(/^Check out this chat$/i, '')
      .trim();
  }

  function getMeta(doc, selector, attr = 'content') {
    const el = doc.querySelector(selector);
    return el ? (el.getAttribute(attr) || '').trim() : '';
  }

  function normalizeDateLabel(value) {
    const raw = String(value || '').replace(/\s+/g, ' ').trim();
    if (raw) return raw;
    return new Date().toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
  }

  function removeNoise(root) {
    if (!root) return root;
    root.querySelectorAll([
      'script', 'style', 'noscript', 'template', 'button', 'input', 'textarea', 'select',
      'nav', 'footer', 'aside', 'form', 'iframe', 'canvas', 'audio', 'video',
      '.sr-only', '.cdk-visually-hidden', '[aria-hidden="true"]', '.hidden',
      '.action-buttons', '.actions', '.luminous-actions-container', '.link-action-buttons',
      '.response-container-header', '.response-container-footer', '.inline-media-container',
      '.file-preview-container', '.query-file-carousel', '.order-first', '.sticky'
    ].join(',')).forEach(el => el.remove());
    return root;
  }

  function sanitizeFragment(nodeOrHTML, options = {}) {
    const doc = document.implementation.createHTMLDocument('sanitize');
    const wrapper = doc.createElement('div');

    if (typeof nodeOrHTML === 'string') {
      wrapper.innerHTML = nodeOrHTML;
    } else if (nodeOrHTML) {
      wrapper.appendChild(nodeOrHTML.cloneNode(true));
    }

    removeNoise(wrapper);

    wrapper.querySelectorAll('*').forEach((el) => {
      const tag = el.tagName.toLowerCase();

      if (tag === 'svg' || tag === 'path' || tag === 'img' || tag === 'picture' || tag === 'source') {
        el.remove();
        return;
      }

      Array.from(el.attributes).forEach((attr) => {
        const name = attr.name.toLowerCase();
        if (name.startsWith('on') || name === 'style' || name === 'class' || name === 'id' || name.startsWith('data-') || name.startsWith('aria-') || name.startsWith('_ng') || name === 'jslog' || name === 'node') {
          el.removeAttribute(attr.name);
          return;
        }
        if (tag === 'a' && name === 'href') {
          const href = attr.value || '';
          if (/^https?:\/\//i.test(href) || href.startsWith('#')) {
            el.setAttribute('rel', 'noopener noreferrer');
            el.setAttribute('target', '_blank');
          } else {
            el.removeAttribute('href');
          }
          return;
        }
        if (!(tag === 'a' && name === 'href')) {
          el.removeAttribute(attr.name);
        }
      });

      if (tag === 'br') return;

      const allowed = new Set([
        'p', 'div', 'span', 'strong', 'b', 'em', 'i', 'u', 's', 'code', 'pre', 'blockquote',
        'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'thead', 'tbody',
        'tr', 'th', 'td', 'hr', 'a', 'br'
      ]);

      if (!allowed.has(tag)) {
        el.replaceWith(...Array.from(el.childNodes));
      }
    });

    wrapper.querySelectorAll('span').forEach((span) => {
      span.replaceWith(...Array.from(span.childNodes));
    });

    const html = wrapper.innerHTML
      .replace(/<div>\s*<\/div>/gi, '')
      .replace(/<p>\s*<\/p>/gi, '')
      .trim();

    if (!html && options.fallbackText) {
      return `<p>${escapeHTML(options.fallbackText)}</p>`;
    }
    return html;
  }

  function makeMessage(role, nodeOrHTML, extra = {}) {
    const rawText = typeof nodeOrHTML === 'string' ? nodeOrHTML.replace(/<[^>]+>/g, ' ') : textOf(nodeOrHTML);
    const html = sanitizeFragment(nodeOrHTML, { fallbackText: rawText });
    const textBucket = document.createElement('div');
    textBucket.innerHTML = html;
    const cleanText = (textBucket.textContent || rawText || '').replace(/\s+/g, ' ').trim();
    return {
      role,
      html,
      text: cleanText,
      thought: extra.thought || ''
    };
  }

  function finalizeConversation(base) {
    const messages = (base.messages || []).filter((message) => {
      const text = (message.text || '').trim();
      const html = (message.html || '').replace(/<[^>]+>/g, '').trim();
      return text || html;
    });

    if (!messages.length) {
      throw new Error('No conversation messages were found in this HTML.');
    }

    const firstUserText = (messages.find(m => m.role === 'user') || messages[0]).text || '';
    const title = stripCommonTitleNoise(base.title) || (firstUserText.length > 78 ? `${firstUserText.slice(0, 75)}...` : firstUserText) || 'AI Conversation';

    return {
      provider: base.provider || 'ai',
      title,
      date: normalizeDateLabel(base.date),
      url: base.url || '',
      messages
    };
  }

  function detectProvider(htmlText, url = '') {
    const source = `${url}\n${String(htmlText || '').slice(0, 60000)}`.toLowerCase();
    if (source.includes('gemini.google.com') || source.includes('share-viewer') || source.includes('bardchatui')) return 'gemini';
    if (source.includes('grok.com') || source.includes('cdn.grok.com') || source.includes('xai grok')) return 'grok';
    if (source.includes('chatgpt.com') || source.includes('data-message-author-role') || source.includes('conversation-turn-')) return 'chatgpt';
    if (source.includes('claude.ai') || source.includes('anthropic') || source.includes('data-test-render')) return 'claude';
    return 'claude';
  }

  function parseClaudeHTML(htmlText, sourceUrl = '') {
    const doc = parseDocument(htmlText);
    const root = doc.querySelector('main') || doc.body;
    const messages = [];

    const turnSelectors = [
      '[data-testid^="conversation-turn"]',
      '[data-testid*="conversation-turn"]',
      '[data-turn]',
      '[data-message-author-role]'
    ].join(',');

    const turns = Array.from(root.querySelectorAll(turnSelectors));
    if (turns.length) {
      const seen = new Set();
      turns.forEach((turn) => {
        const roleAttr = turn.getAttribute('data-turn') || turn.getAttribute('data-message-author-role') || '';
        let role = /user/i.test(roleAttr) ? 'user' : (/assistant|claude/i.test(roleAttr) ? 'assistant' : '');
        const innerRole = turn.querySelector('[data-message-author-role]');
        if (!role && innerRole) {
          const attr = innerRole.getAttribute('data-message-author-role') || '';
          role = /user/i.test(attr) ? 'user' : (/assistant|claude/i.test(attr) ? 'assistant' : '');
        }
        if (!role) return;
        const content = role === 'assistant'
          ? (turn.querySelector('.prose') || turn.querySelector('[data-test-render="true"]') || innerRole || turn)
          : (turn.querySelector('.font-user-message') || innerRole || turn);
        if (!content || seen.has(content)) return;
        seen.add(content);
        messages.push(makeMessage(role, content));
      });
    }

    if (!messages.length) {
      const working = (root || doc.body).cloneNode(true);
      removeNoise(working);
      working.querySelectorAll('.prose, [data-test-render="true"]').forEach((node) => {
        messages.push(makeMessage('assistant', node));
      });

      const userCandidates = Array.from(working.querySelectorAll('.flex.flex-col, .font-user-message, [class*="user"]'));
      userCandidates.forEach((node) => {
        const text = textOf(node);
        if (!text || text.length < 1) return;
        if (text.includes('This is a copy') || text.includes('Content may include')) return;
        if (node.querySelector('.prose, [data-test-render="true"]')) return;
        if (messages.some(m => m.text === text)) return;
        messages.unshift(makeMessage('user', node));
      });
    }

    return finalizeConversation({
      provider: 'claude',
      title: stripCommonTitleNoise(doc.title) || getMeta(doc, 'meta[property="og:title"]'),
      date: '',
      url: sourceUrl || getMeta(doc, 'link[rel="canonical"]', 'href'),
      messages
    });
  }

  function parseChatGPTHTML(htmlText, sourceUrl = '') {
    const doc = parseDocument(htmlText);
    const messages = [];
    const sections = Array.from(doc.querySelectorAll('section[data-turn], [data-testid^="conversation-turn-"]'));

    sections.forEach((section) => {
      const roleAttr = section.getAttribute('data-turn') || '';
      const roleNode = section.querySelector('[data-message-author-role]');
      const roleValue = roleAttr || (roleNode && roleNode.getAttribute('data-message-author-role')) || '';
      const role = /user/i.test(roleValue) ? 'user' : (/assistant/i.test(roleValue) ? 'assistant' : '');
      if (!role) return;

      if (role === 'user') {
        const content = section.querySelector('[data-message-author-role="user"] .whitespace-pre-wrap') ||
          section.querySelector('.user-message-bubble-color > div') ||
          section.querySelector('[data-message-author-role="user"]') || section;
        messages.push(makeMessage('user', content));
      } else {
        const content = section.querySelector('[data-message-author-role="assistant"] .markdown') ||
          section.querySelector('.markdown.prose') ||
          section.querySelector('.markdown') ||
          section.querySelector('[data-message-author-role="assistant"]') || section;
        messages.push(makeMessage('assistant', content));
      }
    });

    if (!messages.length) {
      Array.from(doc.querySelectorAll('[data-message-author-role]')).forEach((node) => {
        const attr = node.getAttribute('data-message-author-role') || '';
        const role = /user/i.test(attr) ? 'user' : (/assistant/i.test(attr) ? 'assistant' : '');
        if (!role) return;
        const content = role === 'assistant' ? (node.querySelector('.markdown') || node) : (node.querySelector('.whitespace-pre-wrap') || node);
        messages.push(makeMessage(role, content));
      });
    }

    return finalizeConversation({
      provider: 'chatgpt',
      title: stripCommonTitleNoise(doc.title) || getMeta(doc, 'meta[property="og:title"]'),
      date: '',
      url: sourceUrl || getMeta(doc, 'link[rel="canonical"]', 'href'),
      messages
    });
  }

  function parseGeminiHTML(htmlText, sourceUrl = '') {
    const doc = parseDocument(htmlText);
    const messages = [];
    const turns = Array.from(doc.querySelectorAll('share-turn-viewer, .share-turn-viewer'));

    turns.forEach((turn) => {
      const userContent = turn.querySelector('.query-text') || turn.querySelector('.query-text-line') || turn.querySelector('user-query');
      if (userContent) messages.push(makeMessage('user', userContent));

      const assistantContent = turn.querySelector('message-content .markdown-main-panel') ||
        turn.querySelector('.markdown-main-panel') ||
        turn.querySelector('structured-content-container .markdown') ||
        turn.querySelector('response-container message-content');
      if (assistantContent) messages.push(makeMessage('assistant', assistantContent));
    });

    if (!messages.length) {
      Array.from(doc.querySelectorAll('.query-text, .query-text-line, .markdown-main-panel')).forEach((node) => {
        const isAssistant = node.classList.contains('markdown-main-panel') || !!node.closest('message-content, structured-content-container');
        messages.push(makeMessage(isAssistant ? 'assistant' : 'user', node));
      });
    }

    return finalizeConversation({
      provider: 'gemini',
      title: textOf(doc.querySelector('.headline strong')) || stripCommonTitleNoise(doc.title) || getMeta(doc, 'meta[property="og:title"]'),
      date: textOf(doc.querySelector('.publish-time')),
      url: sourceUrl || getMeta(doc, 'link[rel="canonical"]', 'href'),
      messages
    });
  }

  function parseGrokHTML(htmlText, sourceUrl = '') {
    const doc = parseDocument(htmlText);
    const messages = [];
    const nodes = Array.from(doc.querySelectorAll('[data-testid="user-message"], [data-testid="assistant-message"]'));

    nodes.forEach((node) => {
      const isUser = node.getAttribute('data-testid') === 'user-message';
      let thought = '';
      if (!isUser) {
        const thoughtNode = node.querySelector('.thinking-container');
        thought = textOf(thoughtNode);
        if (thoughtNode) thoughtNode.remove();
      }
      const content = node.querySelector('.response-content-markdown') || node.querySelector('.markdown') || node;
      messages.push(makeMessage(isUser ? 'user' : 'assistant', content, { thought }));
    });

    return finalizeConversation({
      provider: 'grok',
      title: stripCommonTitleNoise(doc.title) || getMeta(doc, 'meta[property="og:title"]') || getMeta(doc, 'meta[name="twitter:title"]'),
      date: '',
      url: sourceUrl || getMeta(doc, 'link[rel="canonical"]', 'href'),
      messages
    });
  }

  function parseAIConversationHTML(htmlText, sourceUrl = '') {
    const provider = detectProvider(htmlText, sourceUrl);
    switch (provider) {
      case 'chatgpt': return parseChatGPTHTML(htmlText, sourceUrl);
      case 'gemini': return parseGeminiHTML(htmlText, sourceUrl);
      case 'grok': return parseGrokHTML(htmlText, sourceUrl);
      case 'claude':
      default: return parseClaudeHTML(htmlText, sourceUrl);
    }
  }

  const THOUGHT_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M8.5 15.5c-1.9-1.2-3-3.1-3-5.3A6.5 6.5 0 0 1 12 3.7a6.5 6.5 0 0 1 6.5 6.5c0 2.2-1.1 4.1-3 5.3-.7.4-.9.9-.9 1.5H9.4c0-.6-.2-1.1-.9-1.5Z"/></svg>';

  const ACTIONS = '<div class="actions" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="10" height="10" rx="2"/><path d="M6 16H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1"/></svg><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.1.1l2-2a5 5 0 0 0-7-7l-1.2 1.2"/><path d="M14 11a5 5 0 0 0-7.1-.1l-2 2a5 5 0 0 0 7 7l1.2-1.2"/></svg><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M7 10v11"/><path d="M15 5.2 14 10h5.6a2 2 0 0 1 2 2.3l-1.2 7a2 2 0 0 1-2 1.7H7"/><path d="M7 10H4.7A1.7 1.7 0 0 0 3 11.7v7.6A1.7 1.7 0 0 0 4.7 21H7"/><path d="M14 10V5.8A2.8 2.8 0 0 0 11.2 3L8 10"/></svg><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M17 14V3"/><path d="M9 18.8 10 14H4.4a2 2 0 0 1-2-2.3l1.2-7a2 2 0 0 1 2-1.7H17"/><path d="M17 14h2.3a1.7 1.7 0 0 1 1.7 1.7v7.6A1.7 1.7 0 0 1 19.3 25H17" transform="translate(0 -4)"/><path d="M10 14v4.2A2.8 2.8 0 0 0 12.8 21L16 14"/></svg><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 0 0-14.5-4.5L3 9"/><path d="M3 4v5h5"/><path d="M4 13a8 8 0 0 0 14.5 4.5L21 15"/><path d="M21 20v-5h-5"/></svg><svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg></div>';

  const PDF_TEMPLATE_CSS = `
    :root { --paper: #ffffff; --ink: #0d0d0d; --soft-ink: #5f6368; --bubble: #f4f4f4; --hairline: rgba(13, 13, 13, .08); --page-w: 210mm; --page-h: 297mm; --pad-x: 26mm; --pad-y: 20mm; --sans: Arial, Helvetica, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    .pdf-template-root { margin: 0; min-height: 100%; background: #f4f3f1; color: var(--ink); font-family: var(--sans); -webkit-font-smoothing: antialiased; text-rendering: geometricPrecision; }
    .pdf-template-root .stack { padding: 28px 0 56px; }
    .pdf-template-root .sheet { width: var(--page-w); min-height: var(--page-h); margin: 0 auto; padding: var(--pad-y) var(--pad-x); background: var(--paper); box-shadow: 0 22px 60px rgba(20, 20, 20, .12); overflow: visible; }
    .pdf-template-root .conversation-meta { display: block; margin-bottom: 24mm; color: #777; font-size: 12px; line-height: 1.35; letter-spacing: .01em; }
    .pdf-template-root .conversation-meta .title { max-width: 136mm; color: #141414; font-size: 24px; line-height: 1.13; letter-spacing: -.038em; font-weight: 500; }
    .pdf-template-root .conversation-meta .subtitle { display: block; margin-top: 8px; color: #868686; font-size: 12.5px; line-height: 1.35; letter-spacing: .005em; }
    .pdf-template-root .chat { width: 100%; }
    .pdf-template-root .message { width: 100%; margin: 0 0 28px; break-inside: avoid; page-break-inside: avoid; }
    .pdf-template-root .message.user { display: flex; justify-content: flex-end; }
    .pdf-template-root .message.user:first-of-type { margin-bottom: 12mm; }
    .pdf-template-root .bubble { display: inline-block; max-width: 118mm; padding: 15px 16px 16px; background: var(--bubble); border: 1px solid rgba(0,0,0,.018); border-radius: 22px 22px 8px 22px; color: #050505; font: 400 14px/1.45 var(--sans); letter-spacing: -.012em; white-space: pre-wrap; }
    .pdf-template-root .bubble.small { min-width: 45px; min-height: 42px; padding: 12px 16px 11px; border-radius: 22px 22px 8px 22px; line-height: 18px; text-align: center; white-space: pre-wrap; }
    .pdf-template-root .assistant-copy { max-width: 151mm; color: #000; background: transparent; font: 400 14px/1.45 var(--sans); letter-spacing: -.008em; }
    .pdf-template-root .assistant-copy p { margin: 0 0 10px; }
    .pdf-template-root .assistant-copy h1, .pdf-template-root .assistant-copy h2, .pdf-template-root .assistant-copy h3 { margin: 18px 0 9px; line-height: 1.2; letter-spacing: -.02em; }
    .pdf-template-root .assistant-copy ul, .pdf-template-root .assistant-copy ol { margin: 0 0 12px; padding-left: 22px; }
    .pdf-template-root .assistant-copy li { margin: 4px 0; }
    .pdf-template-root .assistant-copy pre { max-width: 100%; overflow-wrap: anywhere; white-space: pre-wrap; background: #f5f5f5; border: 1px solid rgba(0,0,0,.06); border-radius: 12px; padding: 12px; font: 12px/1.45 "SF Mono", SFMono-Regular, Consolas, Menlo, monospace; break-inside: avoid; }
    .pdf-template-root .assistant-copy code { font: 12px/1.35 "SF Mono", SFMono-Regular, Consolas, Menlo, monospace; background: rgba(0,0,0,.05); border-radius: 4px; padding: 1px 4px; }
    .pdf-template-root .assistant-copy pre code { background: transparent; padding: 0; }
    .pdf-template-root .assistant-copy table { width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 12px; break-inside: avoid; }
    .pdf-template-root .assistant-copy th, .pdf-template-root .assistant-copy td { border-bottom: 1px solid rgba(0,0,0,.1); padding: 7px 5px; text-align: left; vertical-align: top; }
    .pdf-template-root .thought { display: inline-flex; align-items: center; gap: 6px; margin-bottom: 14px; color: var(--soft-ink); font: 400 14px/20px var(--sans); }
    .pdf-template-root .thought svg { width: 13px; height: 13px; stroke-width: 1.65; flex: none; transform: translateY(-1px); }
    .pdf-template-root .actions { display: flex; align-items: center; gap: 14px; margin-top: 13px; color: #6f747a; height: 18px; }
    .pdf-template-root .actions svg { width: 16px; height: 16px; stroke-width: 1.55; opacity: .92; flex: none; }
    @media print { @page { size: A4; margin: 0; } html, body { width: 210mm; background: #fff; } .pdf-template-root { background: #fff; } .pdf-template-root .stack { padding: 0; } .pdf-template-root .sheet { width: 210mm; min-height: 297mm; margin: 0; box-shadow: none; -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
  `;

  function renderMessages(conversation) {
    return conversation.messages.map((message) => {
      if (message.role === 'user') {
        const text = message.text || message.html.replace(/<[^>]+>/g, ' ').trim();
        const isSmall = text.length <= 16 && !/[\n\r]/.test(text);
        return `<div class="message user"><div class="bubble${isSmall ? ' small' : ''}">${escapeHTML(text)}</div></div>`;
      }
      const thought = message.thought ? `<div class="thought">${THOUGHT_ICON}<span>${escapeHTML(message.thought)}</span></div>` : '';
      return `<div class="message assistant"><div class="assistant-copy">${thought}${sanitizeFragment(message.html, { fallbackText: message.text })}${ACTIONS}</div></div>`;
    }).join('\n');
  }

  function renderPDFTemplate(conversation) {
    const safe = finalizeConversation(conversation);
    return `<div class="pdf-template-root"><main class="stack"><section class="sheet"><header class="conversation-meta"><div><div class="title">${escapeHTML(safe.title)}</div><div class="subtitle">${escapeHTML(safe.date)} · ${escapeHTML(safe.provider.toUpperCase())}</div></div></header><div class="chat">${renderMessages(safe)}</div></section></main></div>`;
  }

  function renderPDFStyles() {
    return `<style>${PDF_TEMPLATE_CSS}</style>`;
  }

  function renderStandalonePDFPage(conversation) {
    return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHTML(conversation.title || 'AI Conversation')}</title>${renderPDFStyles()}<style>body{margin:0;}</style></head><body>${renderPDFTemplate(conversation)}</body></html>`;
  }

  window.Claude2PDF = {
    STORAGE_KEYS,
    detectProvider,
    parseAIConversationHTML,
    parseClaudeHTML,
    parseChatGPTHTML,
    parseGeminiHTML,
    parseGrokHTML,
    renderPDFTemplate,
    renderPDFStyles,
    renderStandalonePDFPage,
    escapeHTML
  };

  window.parseClaudeHTML = parseClaudeHTML;
  window.parseChatGPTHTML = parseChatGPTHTML;
  window.parseGeminiHTML = parseGeminiHTML;
  window.parseGrokHTML = parseGrokHTML;
})();
