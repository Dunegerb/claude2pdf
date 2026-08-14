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

test('parses Google anti-XSSI JSON payloads', () => {
  const parsed = parsePotentialStructuredBody(")]}'\n" + JSON.stringify({ messages: [
    { role: 'user', content: 'Gemini question' },
    { role: 'assistant', content: 'Gemini answer' }
  ] }));
  assert.deepEqual(collectStructuredMessages(parsed), [
    { role: 'user', text: 'Gemini question' },
    { role: 'assistant', text: 'Gemini answer' }
  ]);
});

test('parses React/Next numeric-prefixed structured stream lines', () => {
  const parsed = parsePotentialStructuredBody([
    '1:' + JSON.stringify({ role: 'user', content: 'Long chat question' }),
    '2:' + JSON.stringify({ role: 'assistant', content: 'Long chat answer' })
  ].join('\n'));
  assert.deepEqual(collectStructuredMessages(parsed), [
    { role: 'user', text: 'Long chat question' },
    { role: 'assistant', text: 'Long chat answer' }
  ]);
});

test('accepts current Gemini public short-link formats', () => {
  assert.equal(validateShareUrl('https://g.co/gemini/share/abcXYZ123').provider, 'gemini');
  assert.equal(validateShareUrl('https://share.gemini.google/KkLTrnbeU5Uy').provider, 'gemini');
});

test('does not allow arbitrary g.co redirects', () => {
  assert.ok(validateShareUrl('https://g.co/some-other-redirect').error);
});
