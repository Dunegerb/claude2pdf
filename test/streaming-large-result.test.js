const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const serverSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const loadingSource = fs.readFileSync(path.join(root, 'public', 'loading.html'), 'utf8');

test('large streamed HTML is split into bounded NDJSON chunks with backpressure', () => {
  assert.match(serverSource, /STREAM_HTML_CHUNK_SIZE/);
  assert.match(serverSource, /type: 'result_start'/);
  assert.match(serverSource, /type: 'html_chunk'/);
  assert.match(serverSource, /type: 'result_end'/);
  assert.match(serverSource, /res\.once\('drain'/);
});

test('loader reconstructs chunked HTML while keeping legacy result support', () => {
  assert.match(loadingSource, /event\.type === 'result_start'/);
  assert.match(loadingSource, /event\.type === 'html_chunk'/);
  assert.match(loadingSource, /event\.type === 'result_end'/);
  assert.match(loadingSource, /htmlChunks\.join\(''\)/);
  assert.match(loadingSource, /event\.type === 'result'/);
});

test('loader consumes complete NDJSON lines incrementally instead of splitting the entire giant buffer', () => {
  assert.match(loadingSource, /buffer\.indexOf\('\\n'\)/);
  assert.doesNotMatch(loadingSource, /const lines = buffer\.split\('\\n'\)/);
});
