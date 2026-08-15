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
