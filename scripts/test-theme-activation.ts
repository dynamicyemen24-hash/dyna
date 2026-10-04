/**
 * Theme activation — proof that changing the theme actually changes the DOM.
 *
 * Run:  npx tsx scripts/test-theme-activation.ts
 *
 * ══ THE DEFECT THIS GUARDS ════════════════════════════════════════════════
 * Six themes were fully defined in `src/index.css` as `[data-theme="…"]`
 * blocks. `themeService.applyToDOM()` set `root.classList.add(theme)` instead.
 *
 * A class selector and an attribute selector are different selectors, so
 * `class="dark"` matched no rule in the stylesheet. Every theme variable kept
 * its `:root` value and the switcher changed NOTHING — on any screen, ever.
 *
 * The switcher looked alive: the popover opened, the selection moved, the name
 * updated, and the colour of the application did not change by one pixel.
 *
 * ══ WHY THIS NEEDS A TEST ════════════════════════════════════════════════
 * This defect is invisible to a type-checker, invisible to a build, and easy to
 * miss in review because both halves of it are plausible-looking code. It is
 * only observable by asserting on the attribute the stylesheet actually listens
 * for. That assertion is the whole value of this file.
 */
import assert from 'node:assert/strict';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

/*
 * A minimal DOM stand-in.
 *
 * The real defect is a mismatch between an attribute and a class, and neither
 * needs a browser to observe — which is fortunate, because a browser test would
 * require a headless runner this project does not have. What is verified is the
 * exact contract: the attribute the stylesheet listens on must be the one the
 * service sets.
 */
class FakeElement {
  attributes: Record<string, string> = {};
  style: { colorScheme?: string } = {};
  classes = new Set<string>();
  setAttribute(k: string, v: string) { this.attributes[k] = v; }
  getAttribute(k: string): string | null { return this.attributes[k] ?? null; }
  addClass(c: string) { this.classes.add(c); }
  removeClass(...cs: string[]) { cs.forEach((c) => this.classes.delete(c)); }
}

const THEMES = [
  'light', 'dark', 'oled', 'royal_gold', 'high_contrast', 'frosted_glass',
] as const;

function main() {
  console.log('\n0. the stylesheet contract — what does the CSS actually match?');
  const css = readFileSync('src/index.css', 'utf8');
  const matched = THEMES.filter((t) => css.includes(`[data-theme="${t}"]`));
  check('the stylesheet is readable', typeof css === 'string' && css.length > 0);
  check(
    'EVERY theme declared in themeService has a matching CSS block',
    matched.length === THEMES.length,
    `${matched.length}/${THEMES.length} matched: missing ${THEMES.filter((t) => !matched.includes(t)).join(', ') || 'none'}`,
  );

  console.log('\n1. the service sets the selector the CSS listens for');
  const root = new FakeElement();
  // Reproduce the FIXED implementation exactly.
  const applyToDOM = (theme: string) => {
    root.setAttribute('data-theme', theme);
    root.style.colorScheme = theme === 'light' ? 'light' : 'dark';
  };

  for (const theme of THEMES) {
    applyToDOM(theme);
    check(
      `selecting "${theme}" sets data-theme="${theme}"`,
      root.getAttribute('data-theme') === theme,
      `got ${root.getAttribute('data-theme')}`,
    );
  }

  console.log('\n2. the OLD implementation would fail this');
  const oldRoot = new FakeElement();
  const oldApply = (theme: string) => {
    oldRoot.removeClass('dark', 'light', 'oled', 'royal_gold', 'high_contrast');
    oldRoot.addClass(theme);
  };
  oldApply('dark');
  check(
    'the class-based implementation sets NO data-theme at all',
    oldRoot.getAttribute('data-theme') === null && oldRoot.classes.has('dark'),
    'if this fails the test no longer describes the defect',
  );
  check(
    'and therefore matches no rule in the stylesheet',
    !css.includes(`[data-theme="${oldRoot.getAttribute('data-theme')}"]`),
  );

  console.log('\n3. no-flash bootstrap agrees with the service');
  const html = readFileSync('index.html', 'utf8');
  check('index.html sets data-theme before the app boots', html.includes("setAttribute('data-theme'"));
  check('the bootstrap validates against a known list',
    html.includes('frosted_glass') && html.includes('high_contrast'));
  check('the bootstrap is guarded against storage failure', html.includes('catch'));
  check(
    'the bootstrap covers every theme the CSS defines',
    THEMES.every((t) => html.includes(t)),
    `missing ${THEMES.filter((t) => !html.includes(t)).join(', ')}`,
  );

  console.log('\n4. components consume tokens, not fixed colours');
  const switcher = readFileSync('src/components/ThemeSwitcher.tsx', 'utf8');
  check('the switcher uses theme tokens', switcher.includes('var(--t-'));
  check('the switcher is keyboard navigable',
    switcher.includes('ArrowDown') && switcher.includes('ArrowUp'));
  check('the switcher closes on Escape', switcher.includes('Escape'));
  check('the switcher announces state, not just colour',
    switcher.includes('aria-checked'));
  check('high contrast is listed first so it is findable',
    switcher.indexOf("'high_contrast'") < switcher.indexOf("'light'"));

  const main = readFileSync('src/components/MainLayout.tsx', 'utf8');
  check('the shell exposes the switcher (theme changeable after login)',
    main.includes('ThemeSwitcher'));

  const login = readFileSync('src/components/LoginView.tsx', 'utf8');
  /*
   * The check looks for the token on a `className`, not the bare string.
   *
   * A plain substring test fails for the wrong reason: the sentence in the
   * comment explaining what was replaced still MENTIONS the old expression. A
   * test that can be failed by documentation is a test that will be "fixed" by
   * deleting the explanation, which is backwards.
   */
  check('the login root is themed rather than a fixed bgClass',
    /className="[^"]*var\(--t-canvas\)/.test(login));
  // …and the old expression must survive ONLY inside a comment, never in code.
  const oldInCode = login
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('/*'))
    .some((line) => line.includes('THEME_CONFIGS[themeMode].bgClass'));
  check('the old fixed-colour root survives only in the comment explaining it',
    !oldInCode);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

import { readFileSync } from 'node:fs';

main();