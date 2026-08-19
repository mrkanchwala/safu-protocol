// Browser smoke gate for website/ — Step 10.0 of the T2 D3 sub-plan.
//
// WHY THIS EXISTS, given 137 unit tests already pass.
// Those tests prove modules parse and pure functions behave. They do not prove
// the page BOOTS. Phase 2c's bug 4 is the direct evidence: `new sdk().Contract(x)`
// parses as `(new sdk()).Contract(x)`, every stubbed test passed, and it only
// surfaced against the real SDK in a real browser. Step 9 added a script loader,
// two connectors, a second adapter, four script tags and a runtime <script>
// injection — none of which a stub exercises.
//
// WHAT THIS GATE DOES *NOT* PROVE — do not read a pass as broader than it is:
//   1. The nginx CSP. The local server sends no headers, so only the meta CSP is
//      exercised here. nginx is the PRIMARY policy and the browser enforces the
//      INTERSECTION of the two, so a Stellar RPC call can pass here and be blocked
//      in production. That is the known ship blocker and it stays open.
//   2. Signing. Headless Chromium has no MetaMask and no Freighter, so the connect
//      and sign paths are unreachable. This covers boot, render, chain switch and
//      lazy-load — not a signed transaction.
//
// Run via tests/website/run-smoke.sh (it starts and stops the static server).

import { pathToFileURL } from 'node:url';

// NODE_PATH does NOT apply to ESM resolution — only to CommonJS require(). So a
// playwright living outside this repo (the npx cache, or ~/.safu-smoke-deps) is
// reached by absolute file URL instead. run-smoke.sh sets PW_MODULE; a bare
// `playwright` still works if one is ever installed normally.
// playwright is CommonJS. Imported by absolute file URL, Node's cjs-module-lexer
// does not always surface its named exports, so fall through to `.default`.
const _pw = await import(
  process.env.PW_MODULE ? pathToFileURL(process.env.PW_MODULE).href : 'playwright'
);
const chromium = _pw.chromium ?? _pw.default?.chromium;
if (!chromium) throw new Error('playwright resolved but exposes no chromium export');

const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:8899';

let passed = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  ok    ${name}`);
  } else {
    failures.push({ name, detail });
    console.log(`  FAIL  ${name}`);
    if (detail) console.log(`        ${detail}`);
  }
}

function section(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`);
}

// The 17 modules index.html loads. whitepaper.js is the 18th and is not on this
// page — it is covered by the whitepaper.html load at the end.
const INDEX_MODULES = [
  'config', 'abi', 'state', 'loader', 'adapter-evm', 'adapter-stellar', 'chain',
  'ui', 'chain-ui', 'init', 'connector-evm', 'connector-stellar', 'wallet',
  'stake', 'claim', 'stream', 'events',
];

// Every global the 17 modules are supposed to register. A module that 404s or
// throws mid-evaluation leaves its global undefined, so this is the real
// "did it evaluate" test — more direct than counting script tags.
const EXPECTED_GLOBALS = [
  'CONFIG', 'SAFU_ABI',
  'SAFU.state', 'SAFU.loadScript', 'SAFU.ui', 'SAFU.chain', 'SAFU.adapter',
  'SAFU.setChain', 'SAFU.chainUI', 'SAFU.init', 'SAFU.wallet',
  'SAFU.adapters.evm', 'SAFU.adapters.stellar',
  'SAFU.connectors.evm', 'SAFU.connectors.stellar',
  'SAFU.stake', 'SAFU.claim', 'SAFU.stream',
];

// LOCALHOST-ONLY ARTIFACTS — suppressed, with the reason, never silently.
//
// The page reads the live API at https://safustaking.com/api/v1/rpc. Served from
// 127.0.0.1 that is a CROSS-ORIGIN request and the API sends no
// Access-Control-Allow-Origin, so the browser blocks it at preflight. In
// production the page IS safustaking.com, so the same request is same-origin and
// no CORS check applies at all. Verified 2026-08-19 against the live headers.
//
// This is the harness's own origin showing through, not a defect in the build.
// It is suppressed ONLY when the URL is the live API and the page origin is not
// safustaking.com — a CORS error against any other host still fails the gate.
function isLocalhostCorsArtifact(text) {
  if (BASE.includes('safustaking.com')) return false;
  const t = String(text);
  const touchesLiveApi = t.includes('safustaking.com');
  const isCors = /CORS policy|Access-Control-Allow-Origin/.test(t);
  const isItsFollowOn = /Failed to load resource: net::ERR_FAILED/.test(t);
  return (touchesLiveApi && isCors) || isItsFollowOn;
}

// Recorders shared by both page loads.
function instrument(page, bag) {
  page.on('console', m => {
    if (m.type() !== 'error') return;
    if (isLocalhostCorsArtifact(m.text())) { bag.suppressed.push(m.text()); return; }
    bag.consoleErrors.push(m.text());
  });
  page.on('pageerror', e => bag.pageErrors.push(e.message));
  page.on('request', r => bag.requests.push(r.url()));
  page.on('requestfailed', r =>
    bag.requestFailures.push(`${r.url()} — ${r.failure()?.errorText || 'unknown'}`));
  page.on('response', r => {
    if (r.status() >= 400) bag.badResponses.push(`${r.status()} ${r.url()}`);
  });
}

function newBag() {
  return {
    consoleErrors: [], pageErrors: [], requests: [],
    requestFailures: [], badResponses: [], suppressed: [],
  };
}

// A request to the live API or a CDN failing is a network condition, not a
// defect in this build. Only same-origin assets are held to a hard 200.
function isOwnAsset(url) {
  return url.startsWith(BASE);
}

// CSP violations are captured in-page as well as via console text. The two
// channels do not always both fire, and a missed violation here is precisely
// the class of bug that ships silently.
const CSP_INIT = `
  window.__cspViolations = [];
  document.addEventListener('securitypolicyviolation', e => {
    window.__cspViolations.push(
      e.violatedDirective + ' :: ' + (e.blockedURI || '(inline)')
    );
  });
`;

const run = async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  await ctx.addInitScript(CSP_INIT);
  const page = await ctx.newPage();
  const bag = newBag();
  instrument(page, bag);

  // ── 1. boot ────────────────────────────────────────────────────────────
  section('1. page boot');
  const resp = await page.goto(`${BASE}/index.html`, { waitUntil: 'load' });
  check('index.html returns 200', resp && resp.status() === 200,
    `got ${resp && resp.status()}`);

  // chain-ui and init both render on DOMContentLoaded; init's reads are async.
  // Waiting on network idle would hang on the live RPC, so settle on a fixed
  // beat and then assert only config-driven values (never live numbers).
  await page.waitForTimeout(2500);

  check('no page errors (uncaught exceptions)', bag.pageErrors.length === 0,
    bag.pageErrors.join(' | '));
  check('no console errors', bag.consoleErrors.length === 0,
    bag.consoleErrors.join(' | '));

  const ownBad = bag.badResponses.filter(isOwnAsset);
  check('every same-origin asset returns < 400', ownBad.length === 0,
    ownBad.join(' | '));

  const ownFailed = bag.requestFailures.filter(isOwnAsset);
  check('no same-origin request failures', ownFailed.length === 0,
    ownFailed.join(' | '));

  const csp1 = await page.evaluate(() => window.__cspViolations);
  check('no CSP violations (meta policy)', csp1.length === 0, csp1.join(' | '));

  // ── 2. modules evaluated ───────────────────────────────────────────────
  section('2. modules evaluated');
  for (const m of INDEX_MODULES) {
    const hit = bag.requests.some(u => u.includes(`/js/${m}.js`));
    check(`fetched js/${m}.js`, hit);
  }

  const missing = await page.evaluate(names =>
    names.filter(path =>
      path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), window) === undefined
    ), EXPECTED_GLOBALS);
  check(`all ${EXPECTED_GLOBALS.length} globals registered`, missing.length === 0,
    `missing: ${missing.join(', ')}`);

  // ── 3. ethereum default render ─────────────────────────────────────────
  section('3. ethereum (default chain) render');
  const eth = await page.evaluate(() => {
    const t = id => document.getElementById(id)?.textContent.trim() ?? null;
    // Assert the RENDERED outcome, not the mechanism that is supposed to
    // produce it — classList.contains('d-none') only proves the class was
    // added, not that the element actually disappeared. A CSS specificity
    // clash (sec-panel's `display:flex` at equal specificity, later in
    // source order) let sec-symbolic-panel render at 535px tall on Stellar
    // while every classList-based check still reported it hidden.
    const hidden = id => {
      const el = document.getElementById(id);
      return el ? getComputedStyle(el).display === 'none' : null;
    };
    return {
      activeChain: window.SAFU.chain().id,
      catchRate: t('stat-catch-rate'),
      coverage: t('stat-coverage'),
      lock: t('stat-lock'),
      range: t('stat-stake-range'),
      symbolic: t('sec-symbolic-score'),
      chainTag: t('sec-chain-tag'),
      lang: t('sec-contract-lang'),
      catchHidden: hidden('stat-cell-catch-rate'),
      aboutCatchHidden: hidden('about-card-catch-rate'),
      symbolicHidden: hidden('sec-symbolic-panel'),
      auditTableHidden: hidden('sec-audit-table'),
      invariantHidden: hidden('guarantee-invariant'),
      mevNoteHidden: hidden('sec-mev-chain-note'),
      walletsLine: t('step-desc-connect'),
      inputMin: document.getElementById('input-amount')?.min ?? null,
      inputMax: document.getElementById('input-amount')?.max ?? null,
      osLabel: JSON.parse(document.getElementById('ld-webapp').textContent).operatingSystem,
      pickerButtons: [...document.querySelectorAll('#chain-picker .chain-btn')].map(b => ({
        text: b.textContent.trim(), active: b.classList.contains('active'), disabled: b.disabled,
      })),
      testnetBandHidden: hidden('testnet-band'),
    };
  });

  check('active chain is ethereum', eth.activeChain === 'ethereum', eth.activeChain);
  check('catch rate reads 100%', eth.catchRate === '100%', eth.catchRate);
  check('coverage reads UP TO 15:1', eth.coverage === 'UP TO 15:1', eth.coverage);
  check('lock reads NO LOCK', eth.lock === 'NO LOCK', eth.lock);
  check('stake range reads 0.01–0.75 ETH', eth.range === '0.01–0.75 ETH', eth.range);
  check('input bounds are 0.01 / 0.75', eth.inputMin === '0.01' && eth.inputMax === '0.75',
    `${eth.inputMin} / ${eth.inputMax}`);
  check('symbolic panel visible, reads 10 / 10',
    eth.symbolicHidden === false && eth.symbolic === '10 / 10',
    `hidden=${eth.symbolicHidden} score=${eth.symbolic}`);
  check('catch-rate cell + about card visible',
    eth.catchHidden === false && eth.aboutCatchHidden === false,
    `cell=${eth.catchHidden} about=${eth.aboutCatchHidden}`);
  check('audit severity table visible', eth.auditTableHidden === false, `${eth.auditTableHidden}`);
  check('solvency-invariant guarantee card visible', eth.invariantHidden === false, `${eth.invariantHidden}`);
  check('MEV/mempool note visible on Ethereum', eth.mevNoteHidden === false, `${eth.mevNoteHidden}`);
  check('wallet list mentions MetaMask on Ethereum', /MetaMask/.test(eth.walletsLine || ''), eth.walletsLine);
  check('contract lang line is Solidity', /Solidity/.test(eth.lang || ''), eth.lang);
  // Mainnet carries no qualifier — networkLabel is null by design.
  check('chain tag reads · ETH', eth.chainTag === '· ETH', JSON.stringify(eth.chainTag));
  // JSON-LD is joined over CHAIN_ORDER so it cannot assert a single-chain claim.
  check('JSON-LD lists both chains',
    /Ethereum Mainnet/.test(eth.osLabel) && /Stellar Testnet/.test(eth.osLabel), eth.osLabel);
  check('chain picker lists 2 buttons, ethereum active+disabled, stellar clickable',
    eth.pickerButtons.length === 2 && eth.pickerButtons[0].active === true &&
    eth.pickerButtons[0].disabled === true && eth.pickerButtons[1].disabled === false,
    JSON.stringify(eth.pickerButtons));
  check('testnet band hidden on Ethereum (networkLabel is null)', eth.testnetBandHidden === true,
    `${eth.testnetBandHidden}`);

  // ── 4. lazy-load, before ───────────────────────────────────────────────
  section('4. lazy-load — nothing Stellar or WalletConnect on a plain load');
  const before = u => bag.requests.filter(r => r.includes(u)).length;
  check('stellar-sdk.min.js NOT fetched', before('stellar-sdk.min.js') === 0,
    `${before('stellar-sdk.min.js')} request(s)`);
  check('freighter-api.min.js NOT fetched', before('freighter-api.min.js') === 0,
    `${before('freighter-api.min.js')} request(s)`);
  check('wc-provider.bundle.js NOT fetched', before('wc-provider.bundle.js') === 0,
    `${before('wc-provider.bundle.js')} request(s)`);

  // ── 5. wallet modal ────────────────────────────────────────────────────
  section('5. wallet modal + chain switcher');
  await page.click('#btn-connect');
  await page.waitForTimeout(1200);

  const modal = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#chain-switcher .wallet-option')].map(b => ({
      name: b.querySelector('.wname')?.textContent.trim(),
      tag: b.querySelector('.wtag')?.textContent.trim(),
      disabled: b.disabled,
    }));
    return {
      open: document.getElementById('wallet-modal')?.classList.contains('open'),
      chainStepShown: document.getElementById('chain-step')?.style.display !== 'none',
      rows,
      walletListChildren: document.getElementById('wallet-list')?.children.length ?? 0,
      walletListText: document.getElementById('wallet-list')?.textContent.trim() ?? '',
    };
  });

  check('modal opened', modal.open === true);
  check('chain step is shown (2 chains configured)', modal.chainStepShown === true);
  check('chain switcher lists 2 chains', modal.rows.length === 2,
    JSON.stringify(modal.rows));
  check('ethereum row marked active', modal.rows[0]?.name === '✓ Ethereum' && modal.rows[0]?.disabled === true,
    JSON.stringify(modal.rows[0]));
  // The tag carries the network qualifier so a testnet can never be offered at
  // visual parity with a live mainnet.
  check('stellar row tagged as testnet', /testnet/i.test(modal.rows[1]?.tag || ''),
    JSON.stringify(modal.rows[1]));
  // No extension in headless Chromium, so an empty-state hint is the correct
  // outcome. What matters is that the step rendered rather than throwing.
  check('wallet list rendered something', modal.walletListChildren > 0,
    `children=${modal.walletListChildren} text=${modal.walletListText}`);

  // ── 6. switch to stellar ───────────────────────────────────────────────
  section('6. switch to Stellar');
  const cspBeforeSwitch = (await page.evaluate(() => window.__cspViolations)).length;
  const errsBeforeSwitch = bag.consoleErrors.length + bag.pageErrors.length;

  await page.evaluate(() => {
    // Click the PAGE-LEVEL picker button — the primary chain-switch path
    // since the 2026-08-19 founder decision, not the modal row. Exercises the
    // real handler wiring rather than calling setChain() directly.
    const btns = [...document.querySelectorAll('#chain-picker .chain-btn')];
    btns.find(b => /Stellar/.test(b.textContent)).click();
  });
  await page.waitForTimeout(3000);

  const xlm = await page.evaluate(() => {
    const t = id => document.getElementById(id)?.textContent.trim() ?? null;
    // See the identical comment in section 3 — computed style, not the class.
    const hidden = id => {
      const el = document.getElementById(id);
      return el ? getComputedStyle(el).display === 'none' : null;
    };
    return {
      activeChain: window.SAFU.chain().id,
      range: t('stat-stake-range'),
      chainTag: t('sec-chain-tag'),
      lang: t('sec-contract-lang'),
      auditNote: t('sec-audit-note'),
      catchHidden: hidden('stat-cell-catch-rate'),
      aboutCatchHidden: hidden('about-card-catch-rate'),
      symbolicHidden: hidden('sec-symbolic-panel'),
      auditTableHidden: hidden('sec-audit-table'),
      auditNoteHidden: hidden('sec-audit-note'),
      invariantHidden: hidden('guarantee-invariant'),
      mevNoteHidden: hidden('sec-mev-chain-note'),
      walletsLine: t('step-desc-connect'),
      coverage: t('stat-coverage'),
      assetLabels: [...document.querySelectorAll('.js-asset')].map(e => e.textContent.trim()),
      pickerButtons: [...document.querySelectorAll('#chain-picker .chain-btn')].map(b => ({
        text: b.textContent.trim(), active: b.classList.contains('active'), disabled: b.disabled,
      })),
      testnetBandHidden: hidden('testnet-band'),
      testnetBandText: document.getElementById('testnet-band')?.textContent.trim() ?? null,
    };
  });

  check('active chain is stellar', xlm.activeChain === 'stellar', xlm.activeChain);
  // The whole point of the stat-cell mechanism: "100%" is an Ethereum result and
  // must not inherit onto a chain that has not earned it.
  check('catch-rate cell HIDDEN', xlm.catchHidden === true, `${xlm.catchHidden}`);
  check('about catch-rate card HIDDEN', xlm.aboutCatchHidden === true, `${xlm.aboutCatchHidden}`);
  // Halmos does not run against Soroban and no substitute result exists.
  check('symbolic panel HIDDEN', xlm.symbolicHidden === true, `${xlm.symbolicHidden}`);
  // The Halmos panel's own bug class, checked directly: this must be a REAL
  // computed-style hide, not just the class being present.
  check('solvency-invariant guarantee card HIDDEN', xlm.invariantHidden === true, `${xlm.invariantHidden}`);
  check('MEV/mempool note HIDDEN on Stellar (no verified claim)', xlm.mevNoteHidden === true, `${xlm.mevNoteHidden}`);
  check('wallet list mentions Freighter, not MetaMask, on Stellar',
    /Freighter/.test(xlm.walletsLine || '') && !/MetaMask/.test(xlm.walletsLine || ''), xlm.walletsLine);
  check('chain picker now shows stellar active+disabled, ethereum clickable',
    xlm.pickerButtons[1]?.active === true && xlm.pickerButtons[1]?.disabled === true &&
    xlm.pickerButtons[0]?.disabled === false,
    JSON.stringify(xlm.pickerButtons));
  check('testnet band VISIBLE on Stellar', xlm.testnetBandHidden === false, `${xlm.testnetBandHidden}`);
  check('testnet band text names the chain and says no real funds',
    /Stellar/.test(xlm.testnetBandText || '') && /no real funds/.test(xlm.testnetBandText || ''),
    xlm.testnetBandText);
  // severities:null → the table is hidden rather than rendered as vacuous zeros.
  check('audit severity table HIDDEN', xlm.auditTableHidden === true, `${xlm.auditTableHidden}`);
  check('audit findings note SHOWN', xlm.auditNoteHidden === false && /remediated/.test(xlm.auditNote || ''),
    `hidden=${xlm.auditNoteHidden} text=${xlm.auditNote}`);
  check('stake range reads 120–7500 XLM', xlm.range === '120–7500 XLM', xlm.range);
  check('chain tag reads · XLM · testnet', /XLM/.test(xlm.chainTag || '') && /testnet/.test(xlm.chainTag || ''),
    JSON.stringify(xlm.chainTag));
  check('contract lang line is Rust + Apache-2.0',
    /Rust/.test(xlm.lang || '') && /Apache-2\.0/.test(xlm.lang || ''), xlm.lang);
  check('coverage ratio still rendered', xlm.coverage === 'UP TO 15:1', xlm.coverage);
  check('no ETH left in .js-asset prose',
    xlm.assetLabels.length > 0 && xlm.assetLabels.every(s => s === 'XLM'),
    JSON.stringify(xlm.assetLabels));

  // ── 7. lazy-load, after ────────────────────────────────────────────────
  section('7. lazy-load — Stellar bundles arrive only now');
  const after = u => bag.requests.filter(r => r.includes(u)).length;
  check('stellar-sdk.min.js fetched after switch', after('stellar-sdk.min.js') >= 1,
    `${after('stellar-sdk.min.js')} request(s)`);
  check('stellar-sdk.min.js fetched exactly once', after('stellar-sdk.min.js') === 1,
    `${after('stellar-sdk.min.js')} request(s) — loader dedup may be broken`);
  check('wc-provider.bundle.js still NOT fetched', after('wc-provider.bundle.js') === 0,
    `${after('wc-provider.bundle.js')} request(s)`);

  // ── 8. switch aftermath ────────────────────────────────────────────────
  section('8. no errors introduced by the switch');
  const csp2 = await page.evaluate(() => window.__cspViolations);
  check('no new CSP violations after switch', csp2.length === cspBeforeSwitch,
    csp2.slice(cspBeforeSwitch).join(' | '));
  const errsAfter = bag.consoleErrors.length + bag.pageErrors.length;
  check('no new console/page errors after switch', errsAfter === errsBeforeSwitch,
    [...bag.consoleErrors, ...bag.pageErrors].slice(errsBeforeSwitch).join(' | '));

  // ── 9. whitepaper.html — the 18th module ───────────────────────────────
  section('9. whitepaper.html (module 18: whitepaper.js)');
  const wpPage = await ctx.newPage();
  const wpBag = newBag();
  instrument(wpPage, wpBag);
  const wpResp = await wpPage.goto(`${BASE}/whitepaper.html`, { waitUntil: 'load' });
  await wpPage.waitForTimeout(1500);
  check('whitepaper.html returns 200', wpResp && wpResp.status() === 200,
    `got ${wpResp && wpResp.status()}`);
  check('whitepaper.js fetched', wpBag.requests.some(u => u.includes('/js/whitepaper.js')));
  check('whitepaper: no page errors', wpBag.pageErrors.length === 0, wpBag.pageErrors.join(' | '));
  check('whitepaper: no console errors', wpBag.consoleErrors.length === 0, wpBag.consoleErrors.join(' | '));
  const wpCsp = await wpPage.evaluate(() => window.__cspViolations);
  check('whitepaper: no CSP violations', wpCsp.length === 0, wpCsp.join(' | '));
  const wpBad = wpBag.badResponses.filter(isOwnAsset);
  check('whitepaper: same-origin assets < 400', wpBad.length === 0, wpBad.join(' | '));

  // ── 10. protocols.html — new page (2026-08-19) ─────────────────────────
  section('10. protocols.html (protocols & ecosystems)');
  const pPage = await ctx.newPage();
  const pBag = newBag();
  instrument(pPage, pBag);
  const pResp = await pPage.goto(`${BASE}/protocols.html`, { waitUntil: 'load' });
  await pPage.waitForTimeout(1000);
  check('protocols.html returns 200', pResp && pResp.status() === 200,
    `got ${pResp && pResp.status()}`);
  check('protocols: no page errors', pBag.pageErrors.length === 0, pBag.pageErrors.join(' | '));
  check('protocols: no console errors', pBag.consoleErrors.length === 0, pBag.consoleErrors.join(' | '));
  const pCsp = await pPage.evaluate(() => window.__cspViolations);
  check('protocols: no CSP violations', pCsp.length === 0, pCsp.join(' | '));
  const pBad = pBag.badResponses.filter(isOwnAsset);
  check('protocols: same-origin assets < 400', pBad.length === 0, pBad.join(' | '));
  const pSections = await pPage.evaluate(() => ({
    whitelabel: Boolean(document.getElementById('whitelabel')),
    ecosystems: Boolean(document.getElementById('ecosystems')),
    multichain: Boolean(document.getElementById('multichain')),
    ctaHref: document.getElementById('btn-bd-intake')?.href ?? null,
  }));
  check('protocols: both audience tracks present (whitelabel + ecosystems)',
    pSections.whitelabel && pSections.ecosystems, JSON.stringify(pSections));
  check('protocols: multichain section present', pSections.multichain, JSON.stringify(pSections));
  check('protocols: BD CTA has a real href', /^https:\/\//.test(pSections.ctaHref || ''), pSections.ctaHref);

  // ── informational ──────────────────────────────────────────────────────
  section('informational (not assertions)');
  const external = [...new Set([...bag.badResponses, ...bag.requestFailures]
    .filter(u => !isOwnAsset(u)))];
  console.log(external.length
    ? `  external requests that failed (network condition, not a build defect):\n    ${external.join('\n    ')}`
    : '  all external requests (CDN + live API) succeeded');
  const stakers = await page.evaluate(() => document.getElementById('stat-stakers')?.textContent.trim());
  console.log(`  live staker count rendered as: ${stakers}  (not asserted — live value)`);
  console.log(`  suppressed localhost-CORS artifacts: ${bag.suppressed.length + wpBag.suppressed.length}` +
    ` (cross-origin only because the harness serves from 127.0.0.1; same-origin in production)`);

  await browser.close();

  // ── verdict ────────────────────────────────────────────────────────────
  console.log(`\n${'='.repeat(64)}`);
  console.log(`  ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('\n  FAILURES:');
    failures.forEach(f => console.log(`   - ${f.name}${f.detail ? `\n     ${f.detail}` : ''}`));
  }
  console.log(`
  SCOPE REMINDER — a pass here does NOT cover:
   * the nginx CSP (local server sends no headers; nginx is the primary policy
     and the browser enforces the INTERSECTION — still the open ship blocker)
   * any signing path (no MetaMask, no Freighter in headless Chromium)`);
  console.log('='.repeat(64));

  process.exit(failures.length ? 1 : 0);
};

run().catch(e => {
  console.error('\nSMOKE HARNESS CRASHED (not a site failure — the harness itself):');
  console.error(e);
  process.exit(2);
});
