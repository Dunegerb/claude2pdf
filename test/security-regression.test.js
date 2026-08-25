const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const serverSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('extractor does not re-enable permissive CORS', () => {
  assert.equal(packageJson.dependencies?.cors, undefined);
  assert.doesNotMatch(serverSource, /require\(['"]cors['"]\)/);
  assert.doesNotMatch(serverSource, /app\.use\(cors\(/);
  assert.match(serverSource, /rejectCrossOriginBrowserRequests/);
  assert.match(serverSource, /sec-fetch-site/);
});

test('conversation-bearing responses remain explicitly non-cacheable', () => {
  assert.match(serverSource, /Cache-Control': 'no-store, private, max-age=0/);
  assert.match(serverSource, /CDN-Cache-Control': 'no-store'/);
  assert.match(serverSource, /Surrogate-Control': 'no-store'/);
  assert.match(serverSource, /Cross-Origin-Resource-Policy': 'same-origin'/);
});

test('server diagnostics do not log share paths, page titles, or browser console text', () => {
  assert.match(serverSource, /return new URL\(value\)\.origin/);
  assert.doesNotMatch(serverSource, /title=\$\{JSON\.stringify\(evidence/);
  assert.doesNotMatch(serverSource, /message\.text\(\)\.slice/);
  assert.match(serverSource, /browser:\$\{message\.type\(\)\}/);
});
