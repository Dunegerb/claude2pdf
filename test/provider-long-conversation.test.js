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
  assert.match(collector, /1400000/);
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

test('protocol-timeout structured fallback applies to every provider', () => {
  const collectPage = sliceBetween('async function collectPageHTML', '// ==========================================\n// ROTA DE EXTRAÇÃO');
  assert.match(collectPage, /expectedMessages >= 2 && isProtocolTimeoutError\(error\)/);
  assert.match(collectPage, /c2p-\$\{provider\}-structured-fallback/);
  assert.doesNotMatch(collectPage, /provider === 'claude' && expectedMessages >= 2/);
});
