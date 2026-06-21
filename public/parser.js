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

  function dedupeTextKey(value) {
    return String(value || '')
      .normalize('NFKC')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/\s+/g, ' ')
      .replace(/[\u00A0]/g, ' ')
      .trim()
      .toLowerCase();
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
      .replace(/\s*\|\s*(Shared )?(ChatGPT|Claude|Gemini|Grok|Qwen|DeepSeek).*$/i, '')
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
    const urlSource = String(url || '').toLowerCase();
    if (urlSource.includes('chat.qwen.ai')) return 'qwen';
    if (urlSource.includes('chat.deepseek.com')) return 'deepseek';
    if (urlSource.includes('gemini.google.com')) return 'gemini';
    if (urlSource.includes('grok.com')) return 'grok';
    if (urlSource.includes('chatgpt.com')) return 'chatgpt';
    if (urlSource.includes('claude.ai')) return 'claude';

    const source = String(htmlText || '').slice(0, 60000).toLowerCase();
    if (source.includes('chat.qwen.ai') || source.includes('qwen studio')) return 'qwen';
    if (source.includes('chat.deepseek.com') || source.includes('ds-markdown')) return 'deepseek';
    if (source.includes('share-viewer') || source.includes('bardchatui')) return 'gemini';
    if (source.includes('cdn.grok.com') || source.includes('xai grok')) return 'grok';
    if (source.includes('data-message-author-role') || source.includes('conversation-turn-')) return 'chatgpt';
    if (source.includes('anthropic') || source.includes('data-test-render')) return 'claude';
    return 'claude';
  }

  function normalizeConversationRole(value) {
    const role = String(value || '').toLowerCase().replace(/[^a-z]/g, '');
    if (!role) return '';
    if (/(user|human|question|prompt|client|visitor)/.test(role)) return 'user';
    if (/(assistant|bot|model|answer|response|qwen|deepseek)/.test(role)) return 'assistant';
    return '';
  }

  function nodeRoleHint(node, provider) {
    if (!node) return '';
    const readHints = (element) => [
      element.getAttribute && element.getAttribute('data-message-author-role'),
      element.getAttribute && element.getAttribute('data-message-role'),
      element.getAttribute && element.getAttribute('data-role'),
      element.getAttribute && element.getAttribute('data-author-role'),
      element.getAttribute && element.getAttribute('data-author'),
      element.getAttribute && element.getAttribute('data-testid'),
      element.getAttribute && element.getAttribute('aria-label'),
      element.id,
      typeof element.className === 'string' ? element.className : ''
    ].filter(Boolean).join(' ');

    let role = normalizeConversationRole(readHints(node));
    if (role) return role;

    let current = node.parentElement;
    for (let depth = 0; current && depth < 4; depth += 1, current = current.parentElement) {
      role = normalizeConversationRole(readHints(current));
      if (role) return role;
    }

    if (provider === 'deepseek' && node.matches && node.matches('.ds-markdown, [class*="markdown-body"]')) return 'assistant';
    if (provider === 'qwen' && node.matches && node.matches('.qwen-markdown, [class*="qwen-markdown"], [class*="markdown-body"]')) return 'assistant';
    return '';
  }

  function providerNoise(text, provider) {
    const value = String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!value) return true;
    const common = [
      'sign in', 'log in', 'download app', 'privacy policy', 'terms of service',
      'copy link', 'share conversation', 'report conversation', 'new chat'
    ];
    const qwen = [
      'go to qwen', 'official app provided by qwen', 'get the app',
      'current system does not support', 'qwen is actively working to ensure compatibility',
      'designed for mobile devices'
    ];
    const deepseek = [
      'verifying you are human', 'security check', 'performance & security by cloudflare',
      'deepseek can make mistakes'
    ];
    return [...common, ...(provider === 'qwen' ? qwen : []), ...(provider === 'deepseek' ? deepseek : [])]
      .some(noise => value === noise || value.startsWith(`${noise} `));
  }

  function bestProviderContentNode(node, role, provider) {
    if (!node) return null;
    const selectors = role === 'assistant'
      ? (provider === 'deepseek'
        ? '.ds-markdown, [class*="ds-markdown"], [class*="markdown-body"], .markdown, .prose, [class*="markdown"], [class*="message-content"], [class*="content"]'
        : '.qwen-markdown, [class*="qwen-markdown"], [class*="markdown-body"], .markdown, .prose, [class*="markdown"], [class*="message-content"], [class*="content"]')
      : '[class*="message-content"], [class*="content"], [class*="bubble"], [class*="text"], p';

    const wholeText = textOf(node);
    const nested = Array.from(node.querySelectorAll ? node.querySelectorAll(selectors) : [])
      .filter(candidate => {
        const text = textOf(candidate);
        return text && !providerNoise(text, provider) && text.length >= Math.max(1, Math.floor(wholeText.length * 0.55));
      })
      .sort((a, b) => textOf(a).length - textOf(b).length);
    return nested[0] || node;
  }

  function collectProviderDOMMessages(doc, provider) {
    const root = doc.querySelector('main') || doc.body;
    const selector = [
      '[data-message-author-role]', '[data-message-role]', '[data-role]', '[data-author-role]', '[data-author]',
      '[data-testid="user-message"]', '[data-testid="assistant-message"]',
      '[data-testid*="user-message"]', '[data-testid*="assistant-message"]',
      '.user-message', '.assistant-message', '[class*="UserMessage"]', '[class*="AssistantMessage"]',
      '[class*="user-message"]', '[class*="assistant-message"]',
      '.ds-markdown', '[class*="ds-markdown"]', '.qwen-markdown', '[class*="qwen-markdown"]'
    ].join(',');

    const candidates = Array.from(root.querySelectorAll(selector)).map((node, index) => ({
      node,
      index,
      role: nodeRoleHint(node, provider)
    })).filter(item => item.role);

    if (candidates.length < 2) {
      Array.from(root.querySelectorAll('[class*="message"], [class*="chat-item"], [class*="conversation-item"], [class*="bubble"]'))
        .forEach((node, index) => {
          const role = nodeRoleHint(node, provider);
          if (role) candidates.push({ node, index: candidates.length + index, role });
        });
    }

    candidates.sort((a, b) => {
      if (a.node === b.node) return 0;
      const position = a.node.compareDocumentPosition(b.node);
      if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return a.index - b.index;
    });

    const messages = [];
    const seen = new Set();
    candidates.forEach(({ node, role }) => {
      const content = bestProviderContentNode(node, role, provider);
      const text = textOf(content);
      if (!text || providerNoise(text, provider)) return;
      const key = `${role}:${dedupeTextKey(text)}`;
      if (seen.has(key)) return;
      seen.add(key);
      messages.push(makeMessage(role, content));
    });
    return messages;
  }

  function textFromStructuredValue(value) {
    if (typeof value === 'string') return value.trim();
    if (Array.isArray(value)) return value.map(textFromStructuredValue).filter(Boolean).join('\n').trim();
    if (!value || typeof value !== 'object') return '';
    const directKeys = ['text', 'content', 'message', 'answer', 'response', 'output', 'query', 'prompt', 'value'];
    for (const key of directKeys) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      const text = textFromStructuredValue(value[key]);
      if (text) return text;
    }
    if (value.parts) return textFromStructuredValue(value.parts);
    if (value.children) return textFromStructuredValue(value.children);
    return '';
  }

  function collectProviderScriptMessages(doc, htmlText, provider) {
    const messages = [];
    const seenMessages = new Set();
    const seenObjects = new WeakSet();

    function add(roleValue, contentValue) {
      const role = normalizeConversationRole(roleValue);
      const text = textFromStructuredValue(contentValue).replace(/\u0000/g, '').trim();
      if (!role || !text || providerNoise(text, provider) || text.length > 250000) return;
      const key = `${role}:${dedupeTextKey(text)}`;
      if (seenMessages.has(key)) return;
      seenMessages.add(key);
      messages.push(makeMessage(role, `<p>${escapeHTML(text)}</p>`));
    }

    function walk(value, depth = 0) {
      if (!value || depth > 18) return;
      if (Array.isArray(value)) {
        value.forEach(item => walk(item, depth + 1));
        return;
      }
      if (typeof value !== 'object') return;
      if (seenObjects.has(value)) return;
      seenObjects.add(value);

      const roleValue = value.role || value.authorRole || value.messageRole || value.sender || value.author?.role || value.author?.type;
      const contentValue = value.content ?? value.text ?? value.message ?? value.answer ?? value.response ?? value.output;
      if (roleValue && contentValue != null) add(roleValue, contentValue);
      Object.values(value).forEach(child => walk(child, depth + 1));
    }

    Array.from(doc.querySelectorAll('script')).forEach((script) => {
      const raw = (script.textContent || '').trim();
      if (!raw || raw.length > 8000000) return;
      if (script.type === 'application/json' || /^[{[]/.test(raw)) {
        try { walk(JSON.parse(raw)); } catch (_) {}
        return;
      }
      const firstBrace = raw.indexOf('{');
      const lastBrace = raw.lastIndexOf('}');
      if (firstBrace >= 0 && lastBrace > firstBrace) {
        try { walk(JSON.parse(raw.slice(firstBrace, lastBrace + 1))); } catch (_) {}
      }
    });

    if (messages.some(message => message.role === 'user') && messages.some(message => message.role === 'assistant')) {
      return messages;
    }

    const rawHTML = String(htmlText || '');
    const patterns = [
      /["']role["']\s*:\s*["'](user|human|assistant|bot|model)["'][^{}]{0,1800}?["'](?:content|text|message|answer|response)["']\s*:\s*["']((?:\\.|[^"'\\])*)["']/gi,
      /["'](?:content|text|message|answer|response)["']\s*:\s*["']((?:\\.|[^"'\\])*)["'][^{}]{0,1800}?["']role["']\s*:\s*["'](user|human|assistant|bot|model)["']/gi
    ];
    patterns.forEach((pattern, patternIndex) => {
      let match;
      let count = 0;
      while ((match = pattern.exec(rawHTML)) && count < 500) {
        count += 1;
        const role = patternIndex === 0 ? match[1] : match[2];
        const encoded = patternIndex === 0 ? match[2] : match[1];
        let decoded = encoded;
        try { decoded = JSON.parse(`"${encoded.replace(/"/g, '\\"')}"`); } catch (_) {
          decoded = encoded.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
        }
        add(role, decoded);
      }
    });

    return messages;
  }

  function mergeProviderMessages(primary, fallback) {
    if (primary.length >= 2 && primary.some(message => message.role === 'user') && primary.some(message => message.role === 'assistant')) {
      return primary;
    }
    const merged = [];
    const seen = new Set();
    [...primary, ...fallback].forEach((message) => {
      const key = `${message.role}:${dedupeTextKey(message.text)}`;
      if (!message.text || seen.has(key)) return;
      seen.add(key);
      merged.push(message);
    });
    return merged;
  }

  function parseClaudeHTML(htmlText, sourceUrl = '') {
    const doc = parseDocument(htmlText);
    const root = doc.querySelector('main') || doc.body;
    const messages = [];

    function isClaudeNoise(text) {
      const value = String(text || '').replace(/\s+/g, ' ').trim();
      if (!value) return true;
      return [
        'This is a copy of a chat',
        'This is a copy of a Claude conversation',
        'Content may include',
        'Claude can make mistakes',
        'Accept all cookies',
        'Privacy Policy',
        'Terms of Service',
        'Try Claude',
        'Open in Claude'
      ].some(noise => value.toLowerCase().includes(noise.toLowerCase()));
    }

    function isInsideNoise(node) {
      return !!(node && node.closest && node.closest([
        'script', 'style', 'noscript', 'template', 'nav', 'header', 'footer', 'aside', 'form',
        'button', '[role="button"]', '[aria-hidden="true"]', '.sr-only', '.hidden'
      ].join(',')));
    }

    function roleForClaudeNode(node) {
      if (!node) return '';
      const className = String(node.className || '');
      const closestUser = node.closest && node.closest('[class*="font-user-message"], [data-testid="user-message"], [data-message-author-role="user"]');
      const closestAssistant = node.closest && node.closest('[class*="font-claude-message"], [data-testid="assistant-message"], [data-message-author-role="assistant"]');
      if (closestUser || /font-user-message|user-message/i.test(className)) return 'user';
      if (closestAssistant || /font-claude-message|claude-message|assistant-message/i.test(className)) return 'assistant';
      if (node.matches && node.matches('.prose, [data-test-render="true"], .markdown, [class*="markdown"]')) return 'assistant';
      return '';
    }

    function addClaudeCandidate(role, node, options = {}) {
      if (!role || !node || isInsideNoise(node)) return false;
      const text = textOf(node);
      if (isClaudeNoise(text)) return false;
      if (text.length < 1) return false;

      // Prefer the smallest visible content root. Claude often nests identical
      // assistant content in both a role wrapper and a .prose/data-test-render node.
      const contentNode = (() => {
        if (role === 'assistant') {
          return node.querySelector && (
            node.matches?.('[data-test-render="true"], .prose, [class*="font-claude-message"], [class*="markdown"]') ? node : null
          ) || (node.querySelector && (
            node.querySelector('[data-test-render="true"]') ||
            node.querySelector('.prose') ||
            node.querySelector('[class*="font-claude-message"]') ||
            node.querySelector('[class*="markdown"]')
          )) || node;
        }
        return node.querySelector && (
          node.matches?.('[class*="font-user-message"], .whitespace-pre-wrap') ? node : null
        ) || (node.querySelector && (
          node.querySelector('[class*="font-user-message"]') ||
          node.querySelector('.whitespace-pre-wrap')
        )) || node;
      })();

      const finalText = textOf(contentNode);
      if (isClaudeNoise(finalText)) return false;

      const message = makeMessage(role, contentNode);
      const key = dedupeTextKey(message.text || finalText);
      if (!key) return false;

      const duplicateIndex = messages.findIndex((entry) => {
        if (entry.role !== role) return false;
        const existingKey = entry.key || dedupeTextKey(entry.message?.text || '');
        if (!existingKey) return false;

        // Exact/near exact duplicated text.
        if (existingKey === key) return true;
        if (key.length > 40 && existingKey.length > 40 && (existingKey.includes(key) || key.includes(existingKey))) return true;

        // Same DOM subtree captured through nested Claude wrappers.
        const existingNode = entry.contentNode;
        if (existingNode && contentNode && existingNode !== contentNode) {
          if (existingNode.contains?.(contentNode) || contentNode.contains?.(existingNode)) return true;
        }
        return false;
      });

      if (duplicateIndex !== -1) {
        const existing = messages[duplicateIndex];
        const existingTextLength = (existing.message?.text || '').length;
        const newTextLength = (message.text || '').length;

        // If the previous capture was a larger wrapper and this one is the cleaner
        // markdown/content node, replace it. Otherwise keep the first occurrence.
        if (newTextLength > 0 && newTextLength <= existingTextLength && existing.contentNode?.contains?.(contentNode)) {
          messages[duplicateIndex] = {
            role,
            node: contentNode,
            contentNode,
            orderNode: existing.orderNode || node,
            key,
            message
          };
        }
        return false;
      }

      messages.push({
        role,
        node: contentNode,
        contentNode,
        orderNode: options.orderNode || node,
        key,
        message
      });
      return true;
    }

    // 1) Current Claude shared pages: user and assistant text usually carry these font classes.
    Array.from(root.querySelectorAll('[class*="font-user-message"], [class*="font-claude-message"]')).forEach((node) => {
      addClaudeCandidate(roleForClaudeNode(node), node);
    });

    const hasExplicitUser = messages.some(m => m.role === 'user');
    const hasExplicitAssistant = messages.some(m => m.role === 'assistant');

    // 2) Older/newer Claude variants: assistant markdown is often plain .prose or data-test-render.
    // Use this only when the explicit Claude assistant selector did not already work;
    // otherwise the same response is captured twice.
    if (!hasExplicitAssistant) {
      Array.from(root.querySelectorAll('.prose, [data-test-render="true"], [class*="markdown"]')).forEach((node) => {
        if (node.closest('[class*="font-user-message"]')) return;
        addClaudeCandidate('assistant', node);
      });
    }

    // 3) Shared pages sometimes expose role attributes after hydration.
    // Only use this as a gap-filler so it cannot duplicate explicit Claude captures.
    if (!hasExplicitUser || !hasExplicitAssistant) {
      Array.from(root.querySelectorAll('[data-message-author-role], [data-turn]')).forEach((node) => {
        const rawRole = node.getAttribute('data-message-author-role') || node.getAttribute('data-turn') || '';
        const role = /user/i.test(rawRole) ? 'user' : (/assistant|claude/i.test(rawRole) ? 'assistant' : '');
        if (!role) return;
        if (role === 'user' && hasExplicitUser) return;
        if (role === 'assistant' && hasExplicitAssistant) return;
        addClaudeCandidate(role, node);
      });
    }

    // 4) Conservative legacy fallback from the original project. Use only when no explicit Claude messages were found.
    if (!messages.length) {
      const working = (root || doc.body).cloneNode(true);
      removeNoise(working);
      working.querySelectorAll('.prose, [data-test-render="true"]').forEach((node) => {
        addClaudeCandidate('assistant', node);
      });
      working.querySelectorAll('.font-user-message, [class*="font-user-message"]').forEach((node) => {
        addClaudeCandidate('user', node);
      });
    }

    const orderedMessages = messages
      .filter((entry, index, list) => {
        const key = entry.key || dedupeTextKey(entry.message?.text || '');
        if (!key) return false;
        return list.findIndex(other => other.role === entry.role && (other.key || dedupeTextKey(other.message?.text || '')) === key) === index;
      })
      .sort((a, b) => {
        if (a.orderNode === b.orderNode) return 0;
        return a.orderNode.compareDocumentPosition(b.orderNode) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
      })
      .map(entry => entry.message);

    return finalizeConversation({
      provider: 'claude',
      title: stripCommonTitleNoise(getMeta(doc, 'meta[property="og:title"]') || doc.title || textOf(doc.querySelector('h1'))),
      date: '',
      url: sourceUrl || getMeta(doc, 'link[rel="canonical"]', 'href'),
      messages: orderedMessages
    });
  }

  function parseChatGPTHTML(htmlText, sourceUrl = '') {
    const doc = parseDocument(htmlText);
    const root = doc.querySelector('main') || doc.body;
    const messages = [];
    const seen = new Set();

    function isChatGPTNoise(text) {
      const value = String(text || '').replace(/\s+/g, ' ').trim();
      if (!value) return true;
      const lower = value.toLowerCase();
      return [
        'this is a copy of a shared chatgpt conversation',
        'report conversation',
        'error loading app failed to fetch template',
        'failed to fetch template retry',
        'chatgpt can make mistakes',
        'terms of use',
        'privacy policy'
      ].some(noise => lower.includes(noise));
    }

    function add(role, nodeOrHTML, extra = {}) {
      if (!role || !nodeOrHTML) return false;
      const message = makeMessage(role, nodeOrHTML, extra);
      if (isChatGPTNoise(message.text)) return false;
      const key = `${role}:${dedupeTextKey(message.text)}`;
      if (!dedupeTextKey(message.text) || seen.has(key)) return false;
      seen.add(key);
      messages.push(message);
      return true;
    }

    function bestNode(nodes) {
      const clean = Array.from(nodes || []).filter(Boolean).filter(node => !isChatGPTNoise(textOf(node)));
      if (!clean.length) return null;
      return clean.sort((a, b) => textOf(b).length - textOf(a).length)[0];
    }

    const turnSections = Array.from(root.querySelectorAll('section[data-turn], [data-testid^="conversation-turn-"]'));

    turnSections.forEach((section) => {
      const roleAttr = section.getAttribute('data-turn') || '';
      const explicitRoleNode = section.querySelector('[data-message-author-role]');
      const roleValue = roleAttr || (explicitRoleNode && explicitRoleNode.getAttribute('data-message-author-role')) || '';
      const role = /user/i.test(roleValue) ? 'user' : (/assistant/i.test(roleValue) ? 'assistant' : '');
      if (!role) return;

      if (role === 'user') {
        const content = bestNode([
          ...section.querySelectorAll('[data-message-author-role="user"] .whitespace-pre-wrap'),
          ...section.querySelectorAll('.user-message-bubble-color .whitespace-pre-wrap'),
          ...section.querySelectorAll('.user-message-bubble-color > div'),
          ...section.querySelectorAll('[data-message-author-role="user"]')
        ]) || section;
        add('user', content);
        return;
      }

      const thoughtNode = Array.from(section.querySelectorAll('button, [class*="thought"], [class*="reason"]'))
        .find(node => /thought for/i.test(textOf(node)));
      const thought = thoughtNode ? textOf(thoughtNode).replace(/\s+/g, ' ').trim() : '';

      // ChatGPT can render transient assistant snippets and the final message in the
      // same turn. Prefer data-turn-start-message when present, otherwise take the
      // longest markdown block inside the assistant role node.
      const assistantRoleNodes = Array.from(section.querySelectorAll('[data-message-author-role="assistant"]'));
      const startMessageNodes = assistantRoleNodes.filter(node => node.getAttribute('data-turn-start-message') === 'true');
      const pool = (startMessageNodes.length ? startMessageNodes : assistantRoleNodes).flatMap((node) => [
        ...node.querySelectorAll('.markdown.prose, .markdown-new-styling, .markdown'),
        node
      ]);
      const content = bestNode(pool) || bestNode(section.querySelectorAll('.markdown.prose, .markdown-new-styling, .markdown'));
      if (content) add('assistant', content, { thought });
    });

    if (!messages.length) {
      const roleNodes = Array.from(root.querySelectorAll('[data-message-author-role]'));
      roleNodes.forEach((node) => {
        const attr = node.getAttribute('data-message-author-role') || '';
        const role = /user/i.test(attr) ? 'user' : (/assistant/i.test(attr) ? 'assistant' : '');
        if (!role) return;
        const content = role === 'assistant'
          ? bestNode(node.querySelectorAll('.markdown.prose, .markdown-new-styling, .markdown')) || node
          : bestNode(node.querySelectorAll('.whitespace-pre-wrap, .user-message-bubble-color > div')) || node;
        add(role, content);
      });
    }

    // Last-resort fallback for partially serialized shared pages where the visible
    // DOM is present in the raw HTML string but not selectable after parsing.
    if (!messages.length && /data-message-author-role=/i.test(htmlText)) {
      const sectionsRaw = String(htmlText).split(/<section\b/i).slice(1).map(chunk => '<section' + chunk.split(/<\/section>/i)[0] + '</section>');
      sectionsRaw.forEach((sectionHTML) => {
        const roleMatch = sectionHTML.match(/data-turn=["'](user|assistant)["']|data-message-author-role=["'](user|assistant)["']/i);
        const role = roleMatch ? (roleMatch[1] || roleMatch[2] || '').toLowerCase() : '';
        if (!role) return;
        const scratch = parseDocument(sectionHTML);
        if (role === 'user') {
          const content = bestNode(scratch.querySelectorAll('.whitespace-pre-wrap, .user-message-bubble-color > div, [data-message-author-role="user"]')) || scratch.body;
          add('user', content);
        } else {
          const content = bestNode(scratch.querySelectorAll('.markdown.prose, .markdown-new-styling, .markdown, [data-message-author-role="assistant"]')) || scratch.body;
          const thoughtNode = Array.from(scratch.querySelectorAll('button')).find(node => /thought for/i.test(textOf(node)));
          add('assistant', content, { thought: thoughtNode ? textOf(thoughtNode) : '' });
        }
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
    const root = doc.querySelector('share-viewer') || doc.querySelector('.share-landing-page_content') || doc.body;
    const messages = [];
    const seen = new Set();

    function isGeminiNoise(text) {
      const value = String(text || '').replace(/\s+/g, ' ').trim();
      if (!value) return true;
      const lower = value.toLowerCase();
      return [
        'google privacy policy',
        'google terms of service',
        'your privacy & gemini apps',
        'gemini may display inaccurate info',
        'sign in',
        'copy prompt',
        'report',
        'opens in a new window'
      ].some(noise => lower === noise || lower.includes(noise));
    }

    function add(role, nodeOrHTML) {
      if (!role || !nodeOrHTML) return false;
      const message = makeMessage(role, nodeOrHTML);
      if (isGeminiNoise(message.text)) return false;
      const key = `${role}:${dedupeTextKey(message.text)}`;
      if (!dedupeTextKey(message.text) || seen.has(key)) return false;
      seen.add(key);
      messages.push(message);
      return true;
    }

    function bestNode(nodes) {
      const clean = Array.from(nodes || []).filter(Boolean).filter(node => !isGeminiNoise(textOf(node)));
      if (!clean.length) return null;
      return clean.sort((a, b) => textOf(b).length - textOf(a).length)[0];
    }

    const turns = Array.from(root.querySelectorAll('share-turn-viewer, .share-turn-viewer'));

    turns.forEach((turn) => {
      const userContent = bestNode([
        ...turn.querySelectorAll('.query-text-line'),
        ...turn.querySelectorAll('.query-text p'),
        ...turn.querySelectorAll('.query-text'),
        ...turn.querySelectorAll('[data-test-id="luminous-collapsed-bubble"]')
      ]);
      if (userContent) add('user', userContent);

      const assistantContent = bestNode([
        ...turn.querySelectorAll('message-content .markdown-main-panel'),
        ...turn.querySelectorAll('.markdown-main-panel'),
        ...turn.querySelectorAll('[inline-copy-host]'),
        ...turn.querySelectorAll('structured-content-container .markdown'),
        ...turn.querySelectorAll('response-container message-content')
      ]);
      if (assistantContent) add('assistant', assistantContent);
    });

    if (!messages.length) {
      const userNodes = Array.from(root.querySelectorAll('.query-text-line, .query-text p, .query-text'));
      const assistantNodes = Array.from(root.querySelectorAll('message-content .markdown-main-panel, .markdown-main-panel, [inline-copy-host]'));
      userNodes.forEach(node => add('user', node));
      assistantNodes.forEach(node => add('assistant', node));
    }

    // Gemini share pages sometimes serialize the rendered HTML in Angular/custom
    // elements but lose custom-element selection in malformed pasted markup. This
    // fallback reparses each raw share-turn-viewer block independently.
    if (!messages.length && /share-turn-viewer/i.test(htmlText)) {
      const rawTurns = String(htmlText).split(/<share-turn-viewer\b/i).slice(1).map(chunk => '<share-turn-viewer' + chunk.split(/<\/share-turn-viewer>/i)[0] + '</share-turn-viewer>');
      rawTurns.forEach((turnHTML) => {
        const scratch = parseDocument(turnHTML);
        const userContent = bestNode(scratch.querySelectorAll('.query-text-line, .query-text p, .query-text, [data-test-id="luminous-collapsed-bubble"]'));
        const assistantContent = bestNode(scratch.querySelectorAll('message-content .markdown-main-panel, .markdown-main-panel, [inline-copy-host], structured-content-container .markdown'));
        if (userContent) add('user', userContent);
        if (assistantContent) add('assistant', assistantContent);
      });
    }

    return finalizeConversation({
      provider: 'gemini',
      title: textOf(doc.querySelector('.headline strong')) || stripCommonTitleNoise(doc.title) || getMeta(doc, 'meta[property="og:title"]'),
      date: textOf(doc.querySelector('.publish-time')),
      url: sourceUrl || getMeta(doc, 'link[rel="canonical"]', 'href') || getMeta(doc, 'a.share-link', 'href'),
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

  function collectQwenShareMessages(doc) {
    const root = doc.querySelector('.share-layout-messages');
    if (!root) return [];

    const messages = [];
    const seen = new Set();
    const turns = Array.from(root.querySelectorAll('.qwen-chat-message'));

    turns.forEach((turn) => {
      const className = String(turn.className || '');
      const role = /qwen-chat-message-user/i.test(className)
        ? 'user'
        : /qwen-chat-message-assistant/i.test(className)
          ? 'assistant'
          : '';
      if (!role) return;

      let content = null;
      let thought = '';

      if (role === 'user') {
        content = turn.querySelector('.user-message-content') ||
          turn.querySelector('.chat-user-message') ||
          turn.querySelector('.chat-user-message-container') ||
          turn;
      } else {
        const thoughtNode = turn.querySelector('.qwen-chat-thinking-status-card-title-text');
        thought = textOf(thoughtNode);
        content = turn.querySelector('.response-message-content.phase-answer .custom-qwen-markdown') ||
          turn.querySelector('.response-message-content.phase-answer .qwen-markdown') ||
          turn.querySelector('.response-message-content.phase-answer') ||
          turn.querySelector('.custom-qwen-markdown') ||
          turn.querySelector('.qwen-markdown') ||
          turn;
      }

      const message = makeMessage(role, content, { thought });
      const key = `${role}:${dedupeTextKey(message.text)}`;
      if (!message.text || providerNoise(message.text, 'qwen') || seen.has(key)) return;
      seen.add(key);
      messages.push(message);
    });

    return messages;
  }

  function collectDeepSeekShareMessages(doc) {
    const root = doc.querySelector('.ds-virtual-list-visible-items');
    if (!root) return [];

    const messages = [];
    const seen = new Set();
    const items = Array.from(root.querySelectorAll('[data-virtual-list-item-key]'))
      .filter(item => item.getAttribute('data-virtual-list-item-key') !== '-999');

    items.forEach((item) => {
      const assistantContent = item.querySelector('.ds-assistant-message-main-content');
      let role = '';
      let content = null;
      let thought = '';

      if (assistantContent) {
        role = 'assistant';
        content = assistantContent;
        const thoughtNode = Array.from(item.querySelectorAll('span, div')).find((node) => {
          const value = textOf(node);
          return value.length > 0 && value.length < 80 && /^(Thought for\b|Thought completed\b)/i.test(value);
        });
        thought = textOf(thoughtNode);
      } else {
        const userMessage = item.querySelector('.ds-message');
        if (!userMessage) return;
        role = 'user';
        content = Array.from(userMessage.children).find((child) => {
          const value = textOf(child);
          return value && !child.matches?.('.ds-flex, [role="button"], button') &&
            !child.querySelector?.('.ds-assistant-message-main-content');
        }) || userMessage;
      }

      const message = makeMessage(role, content, { thought });
      const key = `${role}:${dedupeTextKey(message.text)}`;
      if (!message.text || providerNoise(message.text, 'deepseek') || seen.has(key)) return;
      seen.add(key);
      messages.push(message);
    });

    return messages;
  }

  function parseQwenHTML(htmlText, sourceUrl = '') {
    const doc = parseDocument(htmlText);
    const exactMessages = collectQwenShareMessages(doc);
    const messages = exactMessages.length
      ? exactMessages
      : mergeProviderMessages(
        collectProviderDOMMessages(doc, 'qwen'),
        collectProviderScriptMessages(doc, htmlText, 'qwen')
      );
    const title = [
      textOf(doc.querySelector('.share-layout-title')),
      getMeta(doc, 'meta[property="og:title"]'),
      getMeta(doc, 'meta[name="twitter:title"]'),
      textOf(doc.querySelector('h1')),
      stripCommonTitleNoise(doc.title)
    ].find(value => value && !/^(qwen|qwen studio)$/i.test(value.trim())) || '';

    return finalizeConversation({
      provider: 'qwen',
      title,
      date: textOf(doc.querySelector('.share-layout-date')) || textOf(doc.querySelector('time, [class*="date"], [class*="time"]')),
      url: sourceUrl || getMeta(doc, 'link[rel="canonical"]', 'href'),
      messages
    });
  }

  function parseDeepSeekHTML(htmlText, sourceUrl = '') {
    const doc = parseDocument(htmlText);
    const exactMessages = collectDeepSeekShareMessages(doc);
    const messages = exactMessages.length
      ? exactMessages
      : mergeProviderMessages(
        collectProviderDOMMessages(doc, 'deepseek'),
        collectProviderScriptMessages(doc, htmlText, 'deepseek')
      );
    const title = [
      getMeta(doc, 'meta[property="og:title"]'),
      getMeta(doc, 'meta[name="twitter:title"]'),
      textOf(doc.querySelector('h1')),
      stripCommonTitleNoise(doc.title)
    ].find(value => value && !/^(deepseek|shared conversation - deepseek|deepseek\s*-\s*into the unknown)$/i.test(value.trim())) || '';

    return finalizeConversation({
      provider: 'deepseek',
      title,
      date: textOf(doc.querySelector('time, [class*="date"], [class*="time"]')),
      url: sourceUrl || getMeta(doc, 'link[rel="canonical"]', 'href') || getMeta(doc, 'meta[property="og:url"]'),
      messages
    });
  }

  function parseAIConversationHTML(htmlText, sourceUrl = '') {
    const provider = detectProvider(htmlText, sourceUrl);
    switch (provider) {
      case 'qwen': return parseQwenHTML(htmlText, sourceUrl);
      case 'deepseek': return parseDeepSeekHTML(htmlText, sourceUrl);
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
    parseQwenHTML,
    parseDeepSeekHTML,
    renderPDFTemplate,
    renderPDFStyles,
    renderStandalonePDFPage,
    escapeHTML
  };

  window.parseClaudeHTML = parseClaudeHTML;
  window.parseChatGPTHTML = parseChatGPTHTML;
  window.parseGeminiHTML = parseGeminiHTML;
  window.parseGrokHTML = parseGrokHTML;
  window.parseQwenHTML = parseQwenHTML;
  window.parseDeepSeekHTML = parseDeepSeekHTML;
})();
