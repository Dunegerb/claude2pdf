const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const serverSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

function sliceBetween(startMarker, endMarker) {
  const start = serverSource.indexOf(startMarker);
  assert.notEqual(start, -1, `missing ${startMarker}`);
  const end = serverSource.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing ${endMarker}`);
  return serverSource.slice(start, end);
}

test('all non-Claude providers use the bounded chunked collector', () => {
  assert.match(serverSource, /async function collectChunkedProviderHTML\(/);
  assert.match(serverSource, /collectChunkedProviderHTML\(page, 'chatgpt'/);
  assert.match(serverSource, /collectChunkedProviderHTML\(page, 'gemini'/);
  assert.match(serverSource, /collectChunkedProviderHTML\(page, 'grok'/);
  assert.match(serverSource, /collectChunkedProviderHTML\(page, 'qwen'/);
});

test('generic long-conversation collector bounds DOM cloning and final CDP payloads', () => {
  const collector = sliceBetween('async function collectChunkedProviderHTML', 'async function collectChatGPTHTML');
  assert.match(collector, /PROVIDER_CAPTURE_BATCH_SIZE/);
  assert.match(collector, /PROVIDER_COLLECTION_BUDGET_MS/);
  assert.match(collector, /captureBatch/);
  assert.match(collector, /readFinalChunk/);
  assert.match(collector, /PROVIDER_FINAL_CHUNK_CHARS/);
  assert.doesNotMatch(collector, /\.innerText/);
});

test('provider collectors preserve parser-compatible output contracts', () => {
  const collector = sliceBetween('async function collectChunkedProviderHTML', 'async function collectChatGPTHTML');
  assert.match(collector, /c2p-collected-chatgpt/);
  assert.match(collector, /<share-viewer>/);
  assert.match(collector, /share-layout-messages/);
  assert.match(collector, /c2p-collected-grok/);
  assert.match(collector, /data-testid="user-message"/);
  assert.match(collector, /data-testid="assistant-message"/);
});

test('Grok no longer relies only on generic scroll plus page.content', () => {
  const collectPage = sliceBetween('async function collectPageHTML', '// ==========================================\n// ROTA DE EXTRAÇÃO');
  assert.match(collectPage, /provider === 'grok'[\s\S]*collectGrokHTML\(page, url, \{ expectedMessages \}\)/);
});

test('protocol timeout never falls through to a second full page.content call', () => {
  const collectPage = sliceBetween('async function collectPageHTML', '// ==========================================\n// ROTA DE EXTRAÇÃO');
  assert.match(collectPage, /if \(isProtocolTimeoutError\(error\)\)/);
  assert.match(collectPage, /if \(expectedMessages >= 2\)/);
  assert.match(collectPage, /c2p-\$\{provider\}-structured-fallback/);
  assert.match(collectPage, /throw error/);
  assert.doesNotMatch(collectPage, /await\s+page\.content\(\)/);
});

test('ChatGPT collector uses short in-browser CDP deadlines and a light retry path', () => {
  const collector = sliceBetween('async function collectChunkedProviderHTML', 'async function collectChatGPTHTML');
  assert.match(collector, /Runtime\.evaluate/);
  assert.match(collector, /PROVIDER_COLLECTOR_CALL_TIMEOUT_MS/);
  assert.match(collector, /CHATGPT_CAPTURE_BATCH_SIZE/);
  assert.match(collector, /captureBatchLight/);
  assert.match(collector, /serializeChatGPTTurn/);
  assert.doesNotMatch(collector, /document\.querySelectorAll\(['\"]#thread button, main button/);
});
