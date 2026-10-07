import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import ts from 'typescript';
import { html } from '../../public/js/ui/components.js';

const ROOT = fileURLToPath(new URL('../../public/js/', import.meta.url));

function* files(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const name = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* files(name);
    else if (entry.name.endsWith('.js')) yield name;
  }
}

function templates(file) {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const found = [];
  function visit(node) {
    if (ts.isTaggedTemplateExpression(node) && node.tag.getText(source) === 'html') {
      const tpl = node.template;
      const spans = ts.isTemplateExpression(tpl) ? tpl.templateSpans : [];
      const strings = [ts.isTemplateExpression(tpl) ? tpl.head.text : tpl.text, ...spans.map((s) => s.literal.text)];
      // Parse the actual template strings; substitute values without running component hooks or side effects.
      const values = spans.map(({ expression }) => {
        if (ts.isCallExpression(expression) && expression.expression.getText(source) === 't'
          && ts.isStringLiteral(expression.arguments[0])) return expression.arguments[0].text;
        return 'probe';
      });
      found.push({ strings, values, text: node.getText(source), line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 });
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return found;
}

function* walk(v) {
  if (Array.isArray(v)) { for (const child of v) yield* walk(child); return; }
  if (!v || typeof v !== 'object') return;
  yield v;
  yield* walk(v.props?.children);
}

test('client html templates parse with the shipped htm parser', () => {
  let count = 0;
  for (const file of files(ROOT)) {
    for (const tpl of templates(file)) {
      assert.doesNotThrow(() => html(tpl.strings, ...tpl.values), `${path.relative(ROOT, file)}:${tpl.line}`);
      count++;
    }
  }
  assert.ok(count > 0);
});

for (const [file, label] of [['ui/shopBar.js', '\u5237\u65b0'], ['screens/lobby.js', '\u5339\u914d\u5269\u4f59']]) {
  test(`${file}: translated label is span text`, () => {
    const tpl = templates(path.join(ROOT, file)).find((x) => x.text.includes(`t('${label}')`));
    assert.ok(tpl);
    const nodes = [...walk(html(tpl.strings, ...tpl.values))];
    assert.ok(nodes.some((v) => v.type === 'span' && [v.props?.children].flat().some((c) => typeof c === 'string' && c.trim() === label)));
  });
}
