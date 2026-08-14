const test = require('node:test');
const assert = require('node:assert/strict');
const { validateShareUrl, collectStructuredMessages, parsePotentialStructuredBody } = require('../lib/extraction-utils');

test('accepts standard Claude public share links', () => {
  const result = validateShareUrl('https://claude.ai/share/8f33c54d-5a8c-468a-9bd1-8491ee2f9882');
  assert.equal(result.provider, 'claude');
  assert.equal(result.error, undefined);
});

test('accepts Grok tokens containing URL-encoded characters', () => {
  const result = validateShareUrl('https://grok.com/share/abcNQ%3D%3D_xyz');
  assert.equal(result.provider, 'grok');
  assert.equal(result.error, undefined);
});

test('accepts Qwen /s/ links', () => {
  const result = validateShareUrl('https://chat.qwen.ai/s/abc_DEF-123');
  assert.equal(result.provider, 'qwen');
  assert.equal(result.error, undefined);
});

test('rejects the wrong Qwen path', () => {
  const result = validateShareUrl('https://chat.qwen.ai/share/abc');
  assert.match(result.error, /https:\/\/chat\.qwen\.ai\/s\//);
});

test('rejects lookalike hosts and non-HTTPS URLs', () => {
  assert.ok(validateShareUrl('https://claude.ai.evil.example/share/abc').error);
  assert.ok(validateShareUrl('http://claude.ai/share/abc').error);
});

test('rejects credentials in public URLs', () => {
  assert.ok(validateShareUrl('https://user:pass@claude.ai/share/abc').error);
});

test('parses SSE payloads and extracts user/assistant messages', () => {
  const parsed = parsePotentialStructuredBody([
    'data: {"role":"user","content":"Hello"}',
    'data: {"role":"assistant","content":[{"type":"text","text":"Hi there"}]}',
    'data: [DONE]'
  ].join('\n'));
  const messages = collectStructuredMessages(parsed);
  assert.deepEqual(messages, [
    { role: 'user', text: 'Hello' },
    { role: 'assistant', text: 'Hi there' }
  ]);
});

test('extracts structured messages embedded in JSON script tags', () => {
  const { collectEmbeddedStructuredMessages } = require('../lib/extraction-utils');
  const html = '<html><body><script type="application/json">' +
    JSON.stringify({ messages: [
      { sender: 'human', content: 'Embedded question' },
      { sender: 'assistant', content: { text: 'Embedded answer' } }
    ] }) +
    '</script></body></html>';
  assert.deepEqual(collectEmbeddedStructuredMessages(html), [
    { role: 'user', text: 'Embedded question' },
    { role: 'assistant', text: 'Embedded answer' }
  ]);
});
