const PROVIDER_CONFIG = {
  claude: {
    host: 'claude.ai',
    pathPrefix: '/share/',
    selectors: {
      user: '[class*="font-user-message"], [data-testid="user-message"], [data-message-author-role="user"]',
      assistant: '[class*="font-claude-message"], [data-testid="assistant-message"], [data-message-author-role="assistant"], [data-test-render="true"], .prose'
    }
  },
  chatgpt: {
    host: 'chatgpt.com',
    pathPrefix: '/share/',
    selectors: {
      user: '[data-message-author-role="user"], section[data-turn="user"], [data-testid^="conversation-turn-"][data-turn="user"]',
      assistant: '[data-message-author-role="assistant"], section[data-turn="assistant"], [data-testid^="conversation-turn-"][data-turn="assistant"]'
    }
  },
  gemini: {
    host: 'gemini.google.com',
    pathPrefix: '/share/',
    selectors: {
      user: 'share-turn-viewer .query-text, .share-turn-viewer .query-text, .query-text-line',
      assistant: 'share-turn-viewer .markdown-main-panel, .share-turn-viewer .markdown-main-panel, message-content .markdown-main-panel'
    }
  },
  grok: {
    host: 'grok.com',
    pathPrefix: '/share/',
    selectors: {
      user: '[data-testid="user-message"]',
      assistant: '[data-testid="assistant-message"]'
    }
  },
  qwen: {
    host: 'chat.qwen.ai',
    pathPrefix: '/s/',
    selectors: {
      user: '.share-layout-messages .qwen-chat-message-user, .share-layout-messages [data-message-author-role="user"]',
      assistant: '.share-layout-messages .qwen-chat-message-assistant, .share-layout-messages [data-message-author-role="assistant"]'
    }
  }
};

const HOST_TO_PROVIDER = Object.fromEntries(
  Object.entries(PROVIDER_CONFIG).map(([provider, config]) => [config.host, provider])
);

class ExtractionError extends Error {
  constructor(message, { status = 502, code = 'EXTRACTION_FAILED' } = {}) {
    super(message);
    this.name = 'ExtractionError';
    this.status = status;
    this.code = code;
  }
}

function validateShareUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    return { error: 'Paste a public share link first.' };
  }

  const value = rawUrl.trim();
  if (value.length > 4096) {
    return { error: 'The share URL is too long.' };
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(value);
  } catch (_) {
    return { error: 'Paste a valid public share URL.' };
  }

  if (parsedUrl.protocol !== 'https:' || parsedUrl.username || parsedUrl.password) {
    return { error: 'Only HTTPS public share links are supported.' };
  }

  const hostname = parsedUrl.hostname.toLowerCase();
  const pathname = parsedUrl.pathname;

  if (hostname === 'g.co' && pathname.toLowerCase().startsWith('/gemini/share/')) {
    return { error: 'Use the full Gemini share link: https://gemini.google.com/share/...' };
  }

  const provider = HOST_TO_PROVIDER[hostname];
  if (!provider) {
    return { error: 'Use a public share link from Claude, ChatGPT, Gemini, Grok, or Qwen.' };
  }

  const prefix = PROVIDER_CONFIG[provider].pathPrefix;
  const lowerPath = pathname.toLowerCase();
  if (!lowerPath.startsWith(prefix) || pathname.slice(prefix.length).replace(/\//g, '').trim().length === 0) {
    const format = provider === 'qwen' ? 'https://chat.qwen.ai/s/...' : `https://${hostname}/share/...`;
    return { error: `Use the public share-link format ${format}` };
  }

  return { url: parsedUrl.toString(), parsedUrl, provider };
}

function normalizeStructuredRole(value) {
  const role = String(value || '').toLowerCase().replace(/[^a-z]/g, '');
  if (/(user|human|question|prompt|client|visitor)/.test(role)) return 'user';
  if (/(assistant|bot|model|answer|response|claude|qwen)/.test(role)) return 'assistant';
  return '';
}

function structuredText(value, depth = 0) {
  if (depth > 10 || value == null) return '';
  if (typeof value === 'string') return value.replace(/\u0000/g, '').trim();
  if (typeof value === 'number' || typeof value === 'boolean') return '';
  if (Array.isArray(value)) {
    return value.map(item => structuredText(item, depth + 1)).filter(Boolean).join('\n').trim();
  }
  if (typeof value !== 'object') return '';

  const keys = ['text', 'content', 'message', 'answer', 'response', 'output', 'query', 'prompt', 'value', 'parts'];
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const text = structuredText(value[key], depth + 1);
    if (text) return text;
  }
  return '';
}

function parsePotentialStructuredBody(body) {
  const text = String(body || '').trim();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch (_) {}

  const events = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^data:\s*(.+)$/i);
    if (!match || match[1] === '[DONE]') continue;
    try { events.push(JSON.parse(match[1])); } catch (_) {}
  }
  return events.length ? events : null;
}

function collectStructuredMessages(values) {
  const messages = [];
  const seen = new Set();
  const seenObjects = new WeakSet();
  let visited = 0;

  function add(roleValue, contentValue) {
    const role = normalizeStructuredRole(roleValue);
    const text = structuredText(contentValue);
    if (!role || !text || text.length > 250000) return;
    const key = `${role}:${text.replace(/\s+/g, ' ').trim().slice(0, 12000)}`;
    if (seen.has(key)) return;
    seen.add(key);
    messages.push({ role, text });
  }

  function walk(value, depth = 0) {
    if (value == null || depth > 20 || visited > 50000) return;
    visited += 1;

    if (typeof value === 'string') {
      if (value.length <= 1000000 && /^[\s]*[{[]/.test(value)) {
        const nested = parsePotentialStructuredBody(value);
        if (nested) walk(nested, depth + 1);
      }
      return;
    }
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

  (Array.isArray(values) ? values : [values]).forEach(value => walk(value));
  return messages;
}

function collectEmbeddedStructuredMessages(html) {
  const values = [];
  const source = String(html || '');
  const scriptPattern = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  let totalBytes = 0;
  let count = 0;

  while ((match = scriptPattern.exec(source)) && count < 80 && totalBytes < 5_000_000) {
    count += 1;
    const body = String(match[1] || '').trim();
    if (!body || body.length > 1_000_000) continue;
    totalBytes += body.length;

    const parsed = parsePotentialStructuredBody(body);
    if (parsed) values.push(parsed);
  }

  return collectStructuredMessages(values);
}

function escapeHTML(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function appendNetworkFallback(html, provider, messages) {
  if (!messages.length) return html;
  const markup = `<main id="c2p-network-fallback" data-provider="${escapeHTML(provider)}" hidden>` +
    messages.map((message, index) => {
      const content = escapeHTML(message.text).replace(/\n/g, '<br>');
      return `<section data-c2p-network-message="${index}" data-message-author-role="${message.role}"><div class="c2p-network-content">${content}</div></section>`;
    }).join('') +
    '</main>';

  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, `${markup}</body>`);
  return `${html}${markup}`;
}

module.exports = {
  PROVIDER_CONFIG,
  ExtractionError,
  validateShareUrl,
  parsePotentialStructuredBody,
  collectStructuredMessages,
  collectEmbeddedStructuredMessages,
  appendNetworkFallback
};
