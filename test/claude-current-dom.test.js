const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PROVIDER_CONFIG } = require('../lib/extraction-utils');

const root = path.join(__dirname, '..');
const fixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'claude-current-share-2026.html'), 'utf8');
const serverSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const parserSource = fs.readFileSync(path.join(root, 'public', 'parser.js'), 'utf8');

test('Claude Aug 2026 fixture exposes current public-share DOM contract', () => {
  assert.match(fixture, /data-testid="user-message"/);
  assert.match(fixture, /font-claude-response/);
  assert.match(fixture, /standard-markdown/);
  assert.match(fixture, /<strong\b/);
  assert.match(fixture, /<ul\b/);
  assert.match(fixture, /<pre\b/);
  assert.match(fixture, /<table\b/);
  assert.match(fixture, /<blockquote\b/);
});

test('Claude provider evidence selectors cover the current public-share DOM', () => {
  const selectors = PROVIDER_CONFIG.claude.selectors;
  assert.match(selectors.user, /data-testid="user-message"/);
  assert.match(selectors.assistant, /font-claude-response/);
  assert.match(selectors.assistant, /standard-markdown/);
  assert.match(selectors.assistant, /progressive-markdown/);
});

test('server has a dedicated rich Claude collector before generic page.content fallback', () => {
  assert.match(serverSource, /async function collectClaudeHTML\(/);
  assert.match(serverSource, /data-c2p-claude-turn/);
  assert.match(serverSource, /provider === 'claude'[\s\S]*collectClaudeHTML\(page, url\)/);
  assert.match(serverSource, /font-claude-response\|font-claude-message\|standard-markdown\|progressive-markdown/);
});

test('Claude parser recognizes dedicated collector and current live DOM selectors', () => {
  assert.match(parserSource, /\[data-c2p-claude-turn\]/);
  assert.match(parserSource, /\[data-testid="user-message"\][^\n]*font-claude-response/);
  assert.match(parserSource, /standard-markdown, \.progressive-markdown/);
  assert.match(parserSource, /font-claude-response\|font-claude-message\|claude-message\|assistant-message/);
});
