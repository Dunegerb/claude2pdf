const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const parserPath = path.join(__dirname, '..', 'public', 'parser.js');

function loadClaudeMerge() {
  let source = fs.readFileSync(parserPath, 'utf8');
  source = source.replace(
    '    escapeHTML\n  };',
    '    escapeHTML,\n    _mergeClaudeMessages: mergeClaudeMessages\n  };'
  );
  const context = { window: {}, console };
  vm.runInNewContext(source, context, { filename: 'parser.js' });
  return context.window.Claude2PDF._mergeClaudeMessages;
}

function msg(role, text, html) {
  return { role, text, html: html || `<p>${text}</p>`, thought: '' };
}

test('Claude keeps visible rich DOM over longer internal tool/network traces', () => {
  const mergeClaude = loadClaudeMerge();
  const visible = [
    msg('user', 'gere um texto grande sobre algo esoterico'),
    msg(
      'assistant',
      'Searched the web Vou escrever sobre o Zurvanismo — uma corrente teológica do Irã pré-islâmico. Criar o ensaio longo sobre Zurvanismo em formato markdown',
      '<div class="c2p-claude-tool-status">Searched the web</div><p>Vou escrever sobre o <strong>Zurvanismo</strong> — uma corrente teológica do Irã pré-islâmico.</p><div class="c2p-claude-muted">Criar o ensaio longo sobre Zurvanismo em formato markdown</div>'
    )
  ];
  const fallback = [
    visible[0],
    msg(
      'assistant',
      'Searching the web Searching the web Searching the web Vou escrever sobre o **Zurvanismo** — uma corrente teológica do Irã pré-islâmico. Criar o ensaio longo sobre Zurvanismo em formato markdown File created successfully: /mnt/user-data/outputs/zurvanismo.md'
    )
  ];

  const merged = mergeClaude(visible, fallback);
  assert.equal(merged.length, 2);
  assert.match(merged[1].html, /<strong>Zurvanismo<\/strong>/);
  assert.match(merged[1].html, /c2p-claude-tool-status/);
  assert.doesNotMatch(merged[1].html, /\/mnt\/user-data/);
});

test('Claude visual CSS is fully provider-scoped', () => {
  const source = fs.readFileSync(parserPath, 'utf8');
  assert.match(source, /\.pdf-template-root\.provider-claude \.assistant-copy/);
  assert.match(source, /\.pdf-template-root\.provider-claude \.c2p-claude-tool-status/);
  assert.match(source, /safe\.provider === 'claude' \? ' provider-claude' : ''/);
});

test('Claude exact shared-chat typography and spacing remain provider-scoped', () => {
  const source = fs.readFileSync(parserPath, 'utf8');
  assert.match(source, /\.pdf-template-root\.provider-claude \.assistant-copy \{[\s\S]*font-size: 16px;[\s\S]*line-height: 1\.65rem;/);
  assert.match(source, /\.pdf-template-root\.provider-claude \.assistant-copy h2 \{[^}]*font-size: 22px;/);
  assert.match(source, /\.pdf-template-root\.provider-claude \.assistant-copy h3 \{[^}]*font-size: 18px;/);
  assert.match(source, /padding-left: 32px;/);
  assert.match(source, /border-bottom: \.5px solid rgba\(17,17,15,\.18\)/);
});

test('Claude preserves task-list state and current syntax-highlight palette', () => {
  const source = fs.readFileSync(parserPath, 'utf8');
  assert.match(source, /input\[type=\\\"checkbox\\\"\]/);
  assert.match(source, /c2p-task-checked/);
  assert.match(source, /c2p-syntax-keyword/);
  assert.match(source, /rgb\(204,123,244\)/);
  assert.match(source, /rgb\(112,184,255\)/);
  assert.match(source, /rgb\(94,237,237\)/);
});


test('Claude rich rendered DOM wins over equivalent raw Markdown network fallback', () => {
  const mergeClaude = loadClaudeMerge();
  const visible = [
    msg('user', 'gere com texto com tudo isso por favor'),
    msg(
      'assistant',
      'Título 1 Negrito Itálico item um item dois Código inline Citação Coluna A Coluna B valor valor',
      '<div><h2>Título 1</h2><p><strong>Negrito</strong> <em>Itálico</em></p><ul><li>item um</li><li>item dois</li></ul><p><code>Código inline</code></p><blockquote>Citação</blockquote><table><thead><tr><th>Coluna A</th><th>Coluna B</th></tr></thead><tbody><tr><td>valor</td><td>valor</td></tr></tbody></table></div>'
    )
  ];
  const fallback = [
    msg('user', 'gere com texto com tudo isso por favor'),
    msg(
      'assistant',
      '## Título 1 **Negrito** *Itálico* - item um - item dois `Código inline` > Citação | Coluna A | Coluna B | | valor | valor |'
    )
  ];

  const merged = mergeClaude(visible, fallback);
  assert.equal(merged.length, 2);
  assert.match(merged[1].html, /<h2>Título 1<\/h2>/);
  assert.match(merged[1].html, /<strong>Negrito<\/strong>/);
  assert.match(merged[1].html, /<table>/);
  assert.doesNotMatch(merged[1].html, /\*\*Negrito\*\*/);
});
