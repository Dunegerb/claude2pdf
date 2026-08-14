const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadMerge() {
  let source = fs.readFileSync(path.join(__dirname, '..', 'public', 'parser.js'), 'utf8');
  source = source.replace(
    '    escapeHTML\n  };',
    '    escapeHTML,\n    _mergeProviderMessages: mergeProviderMessages\n  };'
  );
  const context = { window: {}, console };
  vm.runInNewContext(source, context, { filename: 'parser.js' });
  return context.window.Claude2PDF._mergeProviderMessages;
}

function msg(role, text, html = '') {
  return { role, text, html: html || `<p>${text}</p>`, thought: '' };
}

test('prefers the longer structured conversation over a partial hydrated DOM', () => {
  const merge = loadMerge();
  const primary = [
    msg('user', 'Question one'),
    msg('assistant', 'Answer one'),
    msg('user', 'Mexico me envie um texto em espanhol nativo do mexico informal')
  ];
  const fallback = [
    ...primary,
    msg('assistant', 'Claro. Aqui vai um diálogo em espanhol mexicano informal com gírias naturais.'),
    msg('user', 'como os mexicanos nativos conectam palavras para falar mais rapido?'),
    msg('assistant', 'Os mexicanos nativos não falam palavra por palavra. Eles fazem muita sinalefa.')
  ];

  const merged = merge(primary, fallback);
  assert.equal(merged.length, 6);
  assert.equal(merged.at(-1).role, 'assistant');
  assert.match(merged.at(-1).text, /sinalefa/);
});

test('keeps richer DOM HTML while preserving the broader fallback sequence', () => {
  const merge = loadMerge();
  const primary = [
    msg('user', 'Same question', '<p><strong>Same question</strong></p>'),
    msg('assistant', 'Same answer with formatting', '<div><h2>Same answer with formatting</h2><ul><li>detail</li></ul></div>')
  ];
  const fallback = [
    msg('user', 'Same question'),
    msg('assistant', 'Same answer with formatting'),
    msg('user', 'Next question'),
    msg('assistant', 'Next answer')
  ];

  const merged = merge(primary, fallback);
  assert.equal(merged.length, 4);
  assert.match(merged[1].html, /<h2>/);
  assert.equal(merged[3].text, 'Next answer');
});
