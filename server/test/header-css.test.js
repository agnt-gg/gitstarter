'use strict';
// Two CSS regressions that a string search would not have caught, because in
// both cases every rule involved was written correctly and the CASCADE decided
// something else.
//
// The search field lost its colour to `input[type=text]`, which is both more
// specific than a bare `.search` and declared later in the sheet. Unfocused that
// only looked wrong; on focus the field won back its transparent background
// without winning back its colour, so dark text sat on the dark header and
// vanished as you typed — in light mode only, because in dark mode the wrong
// colour happens to be readable.
//
// So these tests resolve the cascade for real: they collect every rule that
// could match the header input, compute specificity, apply source order, and
// assert on the declaration that actually wins.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const HTML = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');

/// Every `selector { declarations }` block in the document, in source order,
/// with the media query it sits inside (if any) recorded rather than flattened.
function rules(css) {
  const found = [];
  // Strip comments first so a brace inside prose cannot be read as a rule.
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const pattern = /(@media[^{]+\{)|([^{}@]+)\{([^{}]*)\}|(\})/g;
  let media = null, depth = 0, match;
  while ((match = pattern.exec(source)) !== null) {
    if (match[1]) { media = match[1].trim(); depth = 1; continue; }
    if (match[4]) { if (depth) { depth = 0; media = null; } continue; }
    if (!match[2]) continue;
    const declarations = match[3];
    for (const selector of match[2].split(',')) {
      const trimmed = selector.trim();
      if (trimmed) found.push({ selector: trimmed, declarations, media, order: found.length });
    }
  }
  return found;
}

/// Does this selector match the header search input?
///
/// Narrow by design: the subject compound may only be built from things that
/// are actually true of `<input class="search" id="q" type="text">` sitting
/// inside `.gh-head`. Anything else is treated as a non-match rather than
/// guessed at.
function matchesHeaderSearch(selector, { focused }) {
  const parts = selector.split(/\s+/).filter(Boolean);
  const subject = parts[parts.length - 1];
  const ancestors = parts.slice(0, -1);
  // The real ancestor chain of the field.
  const available = ['html', 'body', '.gh-head', '.gh-head-in'];
  if (!ancestors.every(a => available.includes(a))) return false;

  const tokens = subject.match(/^input|\.[-\w]+|#[-\w]+|\[[^\]]+\]|::?[-\w()]+/g);
  if (!tokens || tokens.join('') !== subject) return false;
  return tokens.every(token => {
    if (token === 'input') return true;
    if (token === '.search') return true;
    if (token === '#q') return true;
    if (token.startsWith('[')) return /^\[type\s*=\s*"?text"?\]$/.test(token);
    if (token === ':focus') return focused;
    // ::placeholder and friends target a different box; not this element's own
    // colour, so they are not part of this cascade.
    return false;
  });
}

function specificity(selector) {
  const ids = (selector.match(/#[-\w]+/g) || []).length;
  const classes = (selector.match(/\.[-\w]+|\[[^\]]+\]|:(?!:)[-\w]+/g) || []).length;
  const elements = (selector.match(/(^|\s|>)[a-z]+\b/gi) || []).length;
  return [ids, classes, elements];
}

function declaration(block, property) {
  const match = block.match(new RegExp(`(?:^|;)\\s*${property}\\s*:([^;]+)`, 'i'));
  return match ? match[1].trim() : null;
}

/// The declaration that actually wins for one property on the header input.
///
/// Takes the stylesheet as an argument so the same resolver can be pointed at a
/// hypothetical version of it — checking whether a proposed change would have
/// been caught is not something to reason about when it can be measured.
function winning(property, { focused, css = HTML }) {
  const candidates = rules(css)
    .filter(rule => !rule.media)
    .filter(rule => matchesHeaderSearch(rule.selector, { focused }))
    .filter(rule => declaration(rule.declarations, property) !== null);
  assert.ok(candidates.length, `no rule sets ${property} on the header search input`);
  candidates.sort((a, b) => {
    const [ai, ac, ae] = specificity(a.selector);
    const [bi, bc, be] = specificity(b.selector);
    return (ai - bi) || (ac - bc) || (ae - be) || (a.order - b.order);
  });
  const winner = candidates[candidates.length - 1];
  return { value: declaration(winner.declarations, property), selector: winner.selector };
}

module.exports = { rules, specificity, declaration, winning };

test('the header search keeps header colours, focused or not', () => {
  // The bug: `input[type=text]` is (0,1,1) and declared later, so it beat a
  // bare `.search` at (0,1,0) and handed the field `color:var(--fg)` — dark on
  // a dark bar in light mode.
  for (const focused of [false, true]) {
    const colour = winning('color', { focused });
    assert.equal(
      colour.value, 'var(--header-fg)',
      `${focused ? 'focused' : 'unfocused'}, the winning colour comes from \`${colour.selector}\` `
      + `and is ${colour.value}; the header bar is dark in both themes, so this has to be the header colour`,
    );
  }
});

test('the field stays transparent so it reads as part of the header', () => {
  // The same cascade also handed it `background:var(--canvas)`, which is why it
  // showed as a white box in a dark bar before focus.
  assert.equal(winning('background', { focused: false }).value, 'transparent');
  assert.match(winning('background', { focused: true }).value, /^#ffffff/,
    'on focus it lifts slightly, still against the header rather than against the page');
});

test('a focus ring on the header cannot be the thing that hides the text', () => {
  // `input:focus` applies its form-accent ring here too. Whatever wins must be
  // visible against a dark bar, not the page accent.
  const ring = winning('box-shadow', { focused: true });
  assert.match(ring.value, /#ffffff/,
    `the focus ring resolves to ${ring.value} from \`${ring.selector}\`, which is the page accent, not a header colour`);
});

test('the tab bar scrolls sideways only, and clips nothing doing it', () => {
  const nav = rules(HTML).find(rule => rule.selector === '.unav');
  assert.ok(nav, '.unav must be styled');
  assert.equal(declaration(nav.declarations, 'overflow-x'), 'auto', 'tabs may overflow sideways');
  assert.equal(
    declaration(nav.declarations, 'overflow-y'), 'hidden',
    'overflow-y must be stated: setting only overflow-x makes it compute to auto, '
    + 'and one stray pixel then raises a full vertical scrollbar',
  );

  // The tabs deliberately hang 1px below the bar so the active underline meets
  // the header border. That overhang is exactly what used to overflow, so the
  // bar has to take it back in padding or `overflow-y:hidden` clips the
  // underline instead of the scrollbar.
  const button = rules(HTML).find(rule => rule.selector === '.unav button');
  const overhang = Math.abs(parseInt(declaration(button.declarations, 'margin-bottom'), 10));
  const padding = parseInt(declaration(nav.declarations, 'padding-bottom') || '0', 10);
  assert.ok(
    padding >= overhang,
    `tabs hang ${overhang}px below the bar but it only reserves ${padding}px, `
    + 'so hiding the overflow would clip the active underline',
  );
  // And taking that padding back keeps the bar where it was, so the underline
  // still lands on the border below it.
  assert.equal(parseInt(declaration(nav.declarations, 'margin-bottom'), 10), -padding);
});
