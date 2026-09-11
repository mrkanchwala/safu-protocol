# Vendored browser JS in `website/js/`

`website/` has no `package.json` and no build step, by design. Browser dependencies are therefore committed as prebuilt bundles rather than installed and bundled at deploy time. `wc-provider.bundle.js` established this pattern; the Stellar files follow it.

**These are copied byte-identical from official published artifacts. Do not hand-edit them.** Verify with the SHA256 below after any update.

| File | Source package | Version | Global | Size | License | SHA256 |
|---|---|---|---|---|---|---|
| `stellar-sdk.min.js` | `@stellar/stellar-sdk` | 16.2.0 | `StellarSdk` | 472 KB | Apache-2.0 | `c872bee0e34302f812bcb404580f288cf3d434efeee3d40755d4024d74982fd0` |
| `freighter-api.min.js` | `@stellar/freighter-api` | 6.0.1 | `freighterApi` | 10 KB | Apache-2.0 | `d797429cf97f9a67f1999910830a89dc01d565aedebafb651a11b1ed003a7e9d` |
| `wc-provider.bundle.js` | `@walletconnect/ethereum-provider` | 2.19.2 | ES module export (`EthereumProvider`) | 599 KB (613,619 bytes) | Apache-2.0 | `b7b4aa997065450f33c2b647339c4b0a81921346e4db3655d7c39def362027d6` |
| `stellar-wallets-kit.bundle.js` | `@creit.tech/stellar-wallets-kit` | 2.5.0 (7 modules only) | `SAFUStellarWalletModules` (IIFE) | 440 KB (450,677 bytes) | MIT | `ae49d0df2f393beec1e10e809b8599721b9e0577e6686fbb86bc4eddb95a2f06` |
| `stellar-wc.bundle.js` | `@creit.tech/stellar-wallets-kit` | 2.5.0 (WalletConnect module only) | ES module exports (`WalletConnectModule`, `WalletConnectTargetChain`, `WalletConnectAllowedMethods`) | 2.1 MB (2,151,584 bytes) | MIT | `98971e1b07f87b14b3291926fd3628c790250031a2d098cbde23c374a8cd08a8` |

`stellar-sdk.min.js` and `freighter-api.min.js` are published by the Stellar Development Foundation (`github.com/stellar/js-stellar-sdk`, `github.com/stellar/freighter`) and **already ship prebuilt UMD browser bundles**, so no bundler is involved for either.

**`stellar-wallets-kit.bundle.js` is the exception — 2026-08-19, superseding the "Freighter-only, revisit if multi-wallet breadth is required" decision recorded here until this date.** SCF #44's D3 text names "Freighter / Stellar Wallets Kit" either as satisfying the deliverable; multi-wallet breadth became a real user requirement, not a hypothetical, so the trade was made. See its own section below.

## Updating a bundle

```bash
cd /tmp && npm pack @stellar/stellar-sdk
tar -xzf stellar-stellar-sdk-*.tgz package/dist/stellar-sdk.min.js
shasum -a 256 package/dist/stellar-sdk.min.js        # record in the table above
cp package/dist/stellar-sdk.min.js <repo>/website/js/stellar-sdk.min.js
```

Then bump the `?v=` cache-busting query on the script tag in `index.html`.

## Loading strategy

Each family's library is loaded on demand, not eagerly. `ethers` (479 KB) plus `stellar-sdk` (472 KB) is ~950 KB if both load on every page view, and a visitor only ever transacts on one chain at a time.

**Use `window.SAFU.loadScript()` (`website/js/loader.js`), NOT dynamic `import()`.** Corrected 2026-08-19 — the earlier guidance here said to follow `wc-provider.bundle.js`'s dynamic-`import()` pattern, and that is wrong for a UMD bundle.

A file pulled in by `import()` is evaluated as an **ES module**, and in an ES module top-level `this` is `undefined`. Compare the two preambles:

```js
// stellar-sdk — survives, because it prefers globalThis
(e = typeof globalThis !== 'undefined' ? globalThis : e || self).StellarSdk = {}

// freighter-api — THROWS under import(), because r === this === undefined
r.freighterApi = e()
```

`import('./freighter-api.min.js')` fails with `Cannot set properties of undefined (setting 'freighterApi')` before any of the bundle's own code runs. Verified by loading both files in node.

`loadScript()` injects a classic `<script>`, which keeps `this === window` — what every UMD bundle is built for — while still deferring the download until the chain that needs it is selected. It also verifies the promised global actually appeared, so a bundle that loads but registers nothing fails loudly instead of surfacing as a `TypeError` deep inside an adapter later.

`wc-provider.bundle.js` is the exception and may keep its `import()`: it is a true ES module with a named export (`EthereumProvider`), not a UMD global.

## `wc-provider.bundle.js` — provenance recovered + rebuilt 2026-08-19 (E15)

**History:** the file originally shipped with no recorded version, SHA256, or licence ("(pre-existing)"). Provenance was first recovered (not rebuilt) earlier the same day by matching internal version strings (`@walletconnect/ethereum-provider` 2.13.0 + `@walletconnect/modal` 2.6.2). A founder decision then called for rebuilding at **2.23.10**. Building that surfaced a real problem, so the actual shipped version deviates from that number — recorded here in full since it overrides a locked decision.

**Why 2.19.2, not 2.23.10.** Starting at **2.20.0**, `@walletconnect/ethereum-provider` picked up a hard (non-optional) dependency on `@reown/appkit` — the WalletConnect→Reown rebrand's full wallet-modal UI stack — even though this site passes `showQrModal:false` and never renders it. A single-file bundle at 2.23.10 is **2.0 MB**, 2.8× the original 708 KB. Splitting the AppKit code into lazy chunks (esbuild `--splitting`) shrinks the *fetched* bytes back down but replaces the one committed file with 74, breaking the "one prebuilt bundle" pattern every other vendored file here follows. **2.19.2** (the last release before the AppKit merge) sidesteps the tradeoff entirely: it is a single 599 KB file — *smaller than the original 708 KB* — with no architecture change.

**The locked decision's actual goal is still met.** The rebuild existed to clear CVEs found in the original bundle's dependency tree (`elliptic` 6.5.4, `@stablelib/ed25519` ≤2.0.2). Both are verified **absent** from 2.19.2's dependency tree (`npm audit` + a direct grep of the bundled output, not just the lockfile — a lockfile audit is not an audit of the shipped bundle, per the earlier `axios`/`ws` false-positive findings below). Same Apache-2.0 licence.

**Rebuild command** (for the next update — repeat whenever a new CVE surfaces, checking first whether `@reown/appkit` has become optional again):

```bash
mkdir /tmp/wc-rebuild && cd /tmp/wc-rebuild
npm init -y && npm install @walletconnect/ethereum-provider@<version>
cat > entry.js <<'EOF'
export { EthereumProvider } from '@walletconnect/ethereum-provider';
EOF
npx esbuild entry.js --bundle --format=esm --platform=browser --minify \
  --define:process.env.NODE_ENV='"production"' \
  --outfile=wc-provider.bundle.js
shasum -a 256 wc-provider.bundle.js   # record in the table above
```

Verify functionally before shipping — `node -e "import('./wc-provider.bundle.js').then(m => console.log(typeof m.EthereumProvider.init))"` should print `function`. Check `npm audit` AND grep the actual bundled output for any flagged package name — the lockfile lists what's installed, not what's shipped to the browser (Node-only deps like `ws`/`axios` commonly resolve to inert browser stubs via the `browser` package.json field and never reach the real vulnerable code).

**Still open:** this rebuild has not had its manual human WalletConnect click-through test yet (founder-mandated sign-off gate — headless Chromium cannot drive a wallet extension). Old file preserved at `website/js/wc-provider.bundle.js.bak-pre-2.19.2-rebuild` for rollback.

## `stellar-wallets-kit.bundle.js` — built 2026-08-19, 7 of the kit's ~19 wallet modules only

**Why not the whole kit.** `@creit.tech/stellar-wallets-kit` bundles hardware-wallet SDKs (Ledger, Trezor), several exchange wallets (Klever, OneKey, Bitget), and — critically — its `wallet-connect.module.js` pulls in `@reown/appkit`, the exact dependency `wc-provider.bundle.js` above was rebuilt at 2.19.2 specifically to avoid. Its `./components` export also ships a full UI widget built on Preact + a Tailwind-runtime (Twind) — a second UI framework this site does not use anywhere else. None of that is imported here.

**What's actually in the bundle:** only the SDK-level classes for Freighter, xBull, Albedo, Rabet, Lobstr, Hana, and Hot Wallet — each implementing the kit's uniform `ModuleInterface` (`isAvailable`/`getAddress`/`signTransaction`/`getNetwork`). No `StellarWalletsKit` static class, no `./components`, no WalletConnect module. `website/js/connector-stellar.js` wires these 7 modules directly into this site's own existing `.wallet-option` modal — not the kit's UI.

**Stellar WalletConnect was deliberately excluded from THIS bundle**, not an oversight — same AppKit-bloat problem as EVM's WalletConnect, plus it would mean a second, separate WC session running alongside the EVM one. That exclusion still stands for this file. **The scoped revisit it asked for happened 2026-09-11 and shipped as a SEPARATE on-demand bundle — see `stellar-wc.bundle.js` below.** This bundle is unchanged at 440 KB.

**Build command:**
```bash
mkdir /tmp/swk-build && cd /tmp/swk-build
npm init -y && npm install @creit.tech/stellar-wallets-kit@2.5.0 --no-save
cat > entry.js <<'EOF'
import { FreighterModule } from '@creit.tech/stellar-wallets-kit/modules/freighter';
import { xBullModule }     from '@creit.tech/stellar-wallets-kit/modules/xbull';
import { AlbedoModule }    from '@creit.tech/stellar-wallets-kit/modules/albedo';
import { RabetModule }     from '@creit.tech/stellar-wallets-kit/modules/rabet';
import { LobstrModule }    from '@creit.tech/stellar-wallets-kit/modules/lobstr';
import { HanaModule }      from '@creit.tech/stellar-wallets-kit/modules/hana';
import { HotWalletModule } from '@creit.tech/stellar-wallets-kit/modules/hotwallet';
export const modules = {
  freighter: new FreighterModule(), xbull: new xBullModule(), albedo: new AlbedoModule(),
  rabet: new RabetModule(), lobstr: new LobstrModule(), hana: new HanaModule(),
  hotwallet: new HotWalletModule(),
};
EOF
npx esbuild entry.js --bundle --format=iife --global-name=SAFUStellarWalletModules --minify \
  --platform=browser --define:global=globalThis \
  --outfile=stellar-wallets-kit.bundle.js
shasum -a 256 stellar-wallets-kit.bundle.js   # record in the table above
```

`--define:global=globalThis` is required — without it the bundle throws `global is not defined` in a real browser (some of the kit's internal deps assume a Node-style `global`). `window.SAFUStellarWalletModules.modules` is the object each module lives on (esbuild's `--global-name` nests a single named export under that key, it does not flatten it to the top-level global).

**Verified via real Chromium (Playwright), not Node** — same reasoning as `adapter-stellar.test.mjs`'s existing real-SDK-bundle policy: a Node shim can't reproduce real browser globals these modules depend on internally, and did in fact throw a false `Cannot read properties of undefined` error when first tried in bare Node. Confirmed: all 7 modules load, expose the full interface, correct product names (`Freighter`, `xBull`, `Albedo`, `Rabet`, `LOBSTR`, `Hana Wallet`, `HOT Wallet`). Grepped the built output for `reown`, `appkit`, `ledger`, `trezor`, `@walletconnect` — all zero occurrences, confirming tree-shaking excluded them without needing to trust it.

**Known timing asymmetry, live-tested with no extensions installed:** Freighter and Lobstr's `isAvailable()` hang past the kit's own documented 1000ms contract; xBull and Albedo correctly resolve `true` with nothing installed (both have a web-based/PWA path needing no extension — real availability, not a bug). `connector-stellar.js`'s `_isAvailable()` wraps every check in a 1200ms race so a slow module cannot stall the wallet list — see that file for the fix.

## `stellar-wc.bundle.js` — added 2026-09-11, Stellar WalletConnect, loaded on demand

**This is the scoped revisit the section above asked for.** Founder request: offer WalletConnect on
Stellar, not just EVM. The blocking question was whether the kit's WC module does *real Stellar
signing* or merely pairs at the protocol level — the 2026-08-19 note warned that "Stellar is on
WalletConnect's supported chains" refers to a registered CAIP namespace, not a working adapter.

**Verified before building.** The module genuinely signs Stellar:

| | |
|---|---|
| CAIP chains | `stellar:pubnet`, `stellar:testnet` |
| Methods | `stellar_signXDR`, `stellar_signAndSubmitXDR`, `stellar_signMessage`, `stellar_signAuthEntry` |
| Interface | `implements ModuleInterface` — same `isAvailable`/`getAddress`/`signTransaction`/`getNetwork`/`disconnect` as the other 7 |

The earlier concern was about **AppKit's own EVM adapter layer**. The kit talks to Stellar itself via
`@walletconnect/sign-client`; `@reown/appkit` is used only for the QR modal UI. So the module works —
the cost is the modal dependency, which is exactly what the size numbers below show.

**Why a separate bundle, not merged into the 7-module one.** Measured, not estimated:

| Build | Size |
|---|---|
| 7 modules (current, unchanged) | 440 KB |
| 8 modules, WC merged in | **2.5 MB** (5.7×) |
| WC alone, as its own bundle | 2.1 MB |

Merging it would make every visitor download 2.5 MB to reach a stake form, to cover one wallet
option. Splitting it keeps the base bundle at 440 KB and fetches the 2.1 MB chunk **only when a user
actually clicks WalletConnect** — the same on-demand pattern `wc-provider.bundle.js` already uses on
the EVM side (`connector-evm.js:138`). This is a true ES module with named exports, so it keeps
`import()` for the same reason `wc-provider.bundle.js` does (see Loading strategy above — the
UMD/`loadScript()` rule does not apply to it).

**Build command:**
```bash
mkdir /tmp/swk-wc && cd /tmp/swk-wc
npm init -y && npm install @creit.tech/stellar-wallets-kit@2.5.0 --no-save
cat > entry-wc.js <<'EOF'
export { WalletConnectModule, WalletConnectTargetChain, WalletConnectAllowedMethods }
  from '@creit.tech/stellar-wallets-kit/modules/wallet-connect';
EOF
npx esbuild entry-wc.js --bundle --format=esm --platform=browser --minify \
  --define:global=globalThis --define:process.env.NODE_ENV='"production"' \
  --outfile=stellar-wc.bundle.js
shasum -a 256 stellar-wc.bundle.js   # record in the table above
```

Note the export subpath is `modules/wallet-connect` (hyphenated). `modules/walletconnect` does not
exist and fails to resolve.

**Verified via real Chromium (Playwright), not Node** — same policy as the 7-module bundle. Confirmed:
loads as ESM, exports all three symbols, constructs with `{projectId, metadata, allowedChains}`,
reports `productName: WalletConnect` / `moduleType: BRIDGE_WALLET`, and exposes the full
`ModuleInterface`. Zero page errors.

**Wiring:** `connector-stellar.js` imports it lazily inside `_connectWC()` and hands the instance to
the existing `_connectVia()`, so it flows through the same network-passphrase, address-validation and
signer-match checks as every other Stellar wallet with no special-casing. `allowedChains` is scoped to
the selected network only — a pubnet session is never reused to sign on testnet. `disconnect()` drops
the cached instance so the next connect negotiates a fresh pairing.

**CSP:** already covered by the existing WalletConnect relay entries added for EVM
(`wss://relay.walletconnect.com`, `verify.walletconnect.org`, etc.). `api.web3modal.org` and
`rpc.walletconnect.org` were added 2026-09-11 for AppKit's newer Reown endpoints.

**Still open — same gate as the EVM rebuild:** no manual human WalletConnect click-through test yet.
Headless Chromium cannot drive a real mobile wallet pairing, so the pair-scan-approve-sign round trip
remains founder-verified only.
