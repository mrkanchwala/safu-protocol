// ─── SAFU CONFIG ──────────────────────────────────────────────────────────────
// Chain-keyed as of 2026-08-19. The previous shape was single-chain by
// construction: CONTRACT_ADDRESS and CHAIN_ID were singular, and the stake
// bounds carried the asset in the key name (STAKE_MIN_ETH), so a non-ETH value
// could not be expressed honestly.
//
// Adding a chain should be one entry in CHAINS plus one id in CHAIN_ORDER.
// Nothing outside an adapter should read a chain-specific value directly —
// use window.SAFU.chain() for the active chain's config.
//
// WALLETCONNECT_PROJECT_ID is intentionally public — WalletConnect requires it
// in client-side code. Security gate: domain allowlist MUST be enabled in
// WalletConnect Cloud (cloud.walletconnect.com) to prevent use on other domains.
window.CONFIG = {
  // ── protocol-level, chain-silent ────────────────────────────────────────
  SAFU_API_BASE:            'https://safustaking.com/api',
  WALLETCONNECT_PROJECT_ID: '3824772bb6c01d55a924dac308a3cb3e',

  // Contact + dispute intake. Single source of truth: the nav link, the
  // feedback page, and the claim-dispute flow all point here.
  FEEDBACK_FORM_URL: 'https://docs.google.com/forms/d/1qD9IrIkfs39Wupaw5y-zvCS46Ppq4JQiIsRgV9D3s80/viewform',

  DEFAULT_CHAIN: 'ethereum',
  CHAIN_ORDER:   ['ethereum', 'stellar'],

  CHAINS: {
    ethereum: {
      // identity
      id:           'ethereum',
      label:        'Ethereum',
      assetSymbol:  'ETH',
      tag:          'ETH',
      // null means "unmarked" — mainnet is the default state and carries no
      // qualifier. A testnet chain sets this and every render appends it, so
      // the data enforces the rule instead of each template remembering it.
      networkLabel: null,
      family:       'evm',
      status:       'live',

      // Schema.org operatingSystem fragment. chain-ui.js joins these over
      // CHAIN_ORDER at load, so the JSON-LD cannot assert a chain set that
      // differs from the one actually configured.
      osLabel:      'Ethereum Mainnet',

      // DECIMALS IS LOAD-BEARING. ETH is 18, Stellar is 7. Formatting a
      // Stellar amount with 18 understates it by 10^11, and this is a UI that
      // displays stake amounts and claim entitlements. Never assume 18.
      decimals:     18,

      // chain plumbing
      chainId:      1,
      chainIdHex:   '0x1',
      rpcUrl:       'https://safustaking.com/api/v1/rpc',
      contract:     '0xa170f0937DEc353C1806eaC0c3d559524d458641',

      // links
      explorerName:    'etherscan',
      explorerTxBase:  'https://etherscan.io/tx/',
      explorerAddrBase:'https://etherscan.io/address/',
      repoName:        'safu-protocol',
      repoUrl:         'https://github.com/mrkanchwala/safu-protocol',

      // api routing — the Stellar claim path is a separate endpoint built in
      // T2 step 7c, so this cannot be a single shared path.
      verifyPath:   '/v1/verify',
      claimPath:    '/v1/claim',
      apiChain:     'eth',

      // Fallback bounds only. Live values come from the contract's
      // STAKE_MIN()/STAKE_MAX() via init.loadStakeBounds().
      stakeMinFallback: '0.01',
      stakeMaxFallback: '0.75',

      // ── page-rendered facts, consumed by js/chain-ui.js ──────────────────
      // Every number the page prints next to a label is a fact about ONE
      // chain. Hardcoded in markup, "100% CATCH RATE" and "75 / 75 forge
      // tests" — both Ethereum-only — would render unchanged under a Stellar
      // tag, which is exactly the claim the multi-chain positioning guardrail
      // forbids. Semantic values only: the renderer owns the [ brackets ],
      // the "✓", and the ".txt — date" chrome, so a chain cannot ship a label
      // in the wrong house style by a template author forgetting it.
      stats: {
        catchRate:     { value: '100%',       label: 'CATCH RATE' },
        coverageRatio: { value: 'UP TO 15:1', label: 'COVERAGE RATIO' },
        lock:          { value: 'NO LOCK',    label: 'WITHDRAW ANYTIME' },
      },

      evidence: {
        audit: {
          toolLabel:  'CSO + Slither',
          date:       '2026-06-18',
          verdict:    'PASS',
          severities: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
        },

        // Symbolic execution is EVM tooling — Halmos does not run against
        // Soroban. A chain with no equivalent OMITS this key and chain-ui
        // hides the whole panel, rather than renaming it into a generic
        // "audit coverage" box that implies a check nobody ran.
        // CORRECTED 2026-08-19: was '12 / 12', which is V7's count. The live V8
        // suite `test/SAFUPoolHalmos.t.sol` has TEN `check_` properties, and
        // they map 1:1 to the ten bullets rendered in this panel. The 12 came
        // from `test/SAFUPoolV7Halmos.t.sol`, the superseded file. Project
        // memory and the SCF-corrected phrasing both say 10/10.
        // A test asserts this against the .sol file so it cannot drift again.
        symbolic: {
          fileSlug:  'halmos-symbolic',
          toolLabel: 'Halmos Symbolic Execution — a16z',
          date:      '2026-06-18',
          score:     '10 / 10',
          sub:       'properties verified — zero counterexamples',
        },

        review: { label: 'security review — comprehensive', date: '2026-06-18', verdict: 'PASS' },
        tests:  { label: 'forge test suite', value: '75 / 75', sub: 'tests pass — full coverage' },

        // "the pool always holds more <asset> than it owes" is a specific,
        // formally-verified solvency claim (one of the ten Halmos check_
        // properties above), not a generic guarantee. A chain without an
        // equivalent proof omits this key and chain-ui hides the whole
        // guarantee card, same pattern as `symbolic`.
        invariant: { verified: true },
      },

      // Language/licence line under [ contract ]. The verified-link URL is NOT
      // stored here — it is derived from adapter.explorerAddrUrl(contract), so
      // the address cannot be duplicated and drift out of sync.
      contractMeta: {
        langLine: 'Solidity 0.8.25 · BUSL-1.1',
      },

      // Chain-scoped disclosures rendered into the stake flow. Ethereum has
      // no yield deployment live, so it carries none.
      disclosures: [],

      // ── chain-specific prose, previously hardcoded in index.html ────────
      // Found live on Stellar (2026-08-19): the wallet list told a Stellar
      // user to install MetaMask, the claim-id hint pointed at Etherscan
      // event logs Soroban does not emit, and the MEV card's mempool/gas
      // language rendered nonsense after only its chain-name token was
      // substituted. All three are config-driven now, same pattern as
      // evidence.symbolic — a chain with nothing accurate to say here omits
      // the key (see stellar's mevChainNote) rather than inheriting
      // Ethereum's specifics.
      walletsLine: 'MetaMask, Rabby, Rainbow, Trust, Safe — any EIP-1193 compatible wallet.',
      // 2026-08-19: was a static HTML default ("0x... beneficiary address")
      // that rendered under Stellar too, whose addresses are never 0x-shaped.
      // Config-driven now, same reasoning as walletsLine two lines up.
      beneficiaryPlaceholder: '0x... beneficiary address',
      // 2026-08-19: same gap as beneficiaryPlaceholder above, found later in
      // the same pass — the claim-flow inputs (scan tx, dispute tx/wallet,
      // stream claim-id/beneficiary) all had their own separate hardcoded
      // "0x..." defaults, never covered by the earlier fix.
      claimTxPlaceholder:          '0x... drain tx hash',
      disputeTxPlaceholder:        '0x... tx hash',
      disputeWalletPlaceholder:    '0x... your wallet address',
      claimIdPlaceholder:          '0x... claim ID (bytes32)',
      streamBeneficiaryPlaceholder:'0x... your beneficiary address',
      // Trusted HTML — developer-authored, not user input. <strong> is safe
      // to interpolate directly (same trust basis as loader()'s <span>).
      claimIdHint: 'Claim ID is emitted in the <strong>ClaimActivated</strong> event on Etherscan.',
      // No .js-chain-name class here on purpose — this string is already
      // per-chain config data, not shared markup, so it does not need the
      // generic prose-substitution pass (which also wouldn't fire correctly
      // on HTML injected via innerHTML after renderProse() already ran).
      mevChainNote: 'Claim transactions are broadcast to the public mempool like any Ethereum transaction. For lowest gas costs, submit claims during off-peak hours (weekends or early UTC mornings).',
    },

    // ── STELLAR / SOROBAN (testnet) ──────────────────────────────────────
    // Values here were read from the contract and the network on 2026-08-19,
    // NOT carried across from Ethereum by analogy. Provenance per field below,
    // because "it looked plausible" is how a wrong bound ships.
    stellar: {
      id:           'stellar',
      label:        'Stellar',
      assetSymbol:  'XLM',
      tag:          'XLM',
      // Never null on this chain. Mainnet-but-under-audit must never render
      // at visual parity with a fully cleared pool — see auditPending below.
      networkLabel: 'mainnet',
      family:       'stellar',
      status:       'mainnet',
      osLabel:      'Stellar Mainnet',

      // T3 mainnet pool is live and unaudited-in-progress. Do not remove
      // until the third-party audit (applied for after Tranche 2) completes
      // and remediation lands — this drives the caution icon on the
      // chain-picker button and the disclosure band, both in wallet.js.
      auditPending: true,

      // 7, not 18. XLM's base unit is the stroop (1 XLM = 10^7 stroops).
      // Formatting a stroop amount with 18 understates it by 10^11.
      decimals:     7,

      // chain plumbing
      networkPassphrase: 'Public Global Stellar Network ; September 2015',
      rpcUrl:       'https://mainnet.sorobanrpc.com',

      // Inclusion fee in stroops. prepareTransaction() adds the Soroban
      // resource fee on top; this is only the inclusion bid.
      baseFee:      '100000',

      // SIMULATION-ONLY source account. A read-only simulation needs a
      // syntactically valid transaction source, not a funded or signing one —
      // nothing is ever signed with this and it need not exist on-network. The
      // connected wallet replaces it whenever one is present. Must be an
      // account (G…): a contract address is not a valid transaction source.
      simulationSource: 'GCZOUSNCY4TRCPQHP4IN2JEF4TVUMKGAZ6HNUXKIUWPMZJHJ7RA7A2UD',

      // TRANCHE 3 MAINNET CONTRACT — deployed 2026-09-10 (D1), replacing the
      // T2 testnet contract this field pointed at through the whole T2
      // review cycle. Vault wired same day (D1 sub-sequence): DeFindex vault
      // CA2LV3YOQ5WTQJKWIK6BFWXPNMSPHRG7763T5B4JLMEJLTVNNIK6S5AP, deploy_bps
      // 500 (5%), vault_fee=0 (verified on-chain, STRIDE Elevation.3 met).
      contract:     'CB3LZVWKGGWSYHHIE7ILK5CJH2MLUB6SWAU7UK6PMQEP3AESD3DAUBRC',

      // Native XLM SAC on mainnet, verified live (name="native", full SEP-41
      // surface) — not assumed to match the testnet address pattern.
      assetContract: 'CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA',

      // links — stellar.expert routes accounts and contracts to DIFFERENT
      // paths, unlike Etherscan's single /address/, so this is two fields.
      explorerName:         'stellar.expert',
      explorerTxBase:       'https://stellar.expert/explorer/public/tx/',
      explorerAccountBase:  'https://stellar.expert/explorer/public/account/',
      explorerContractBase: 'https://stellar.expert/explorer/public/contract/',
      repoName:             'safu-soroban',
      repoUrl:              'https://github.com/mrkanchwala/safu-soroban',

      // Step 7c built a DEDICATED Stellar claim endpoint — this is not the
      // EVM path with a different body.
      verifyPath:   '/v1/verify',
      claimPath:    '/v1/claim/stellar',
      apiChain:     'stellar',

      // STAKE BOUNDS — a different mechanism from Ethereum's, not different
      // numbers. Soroban derives them live as basis points of the pool cap
      // (types.rs MIN_STAKE_BPS=2, MAX_STAKE_BPS=125, denominator 10_000), so
      // there is no STAKE_MIN()/STAKE_MAX() getter to call. The cap itself is
      // readable: it lives in the contract's INSTANCE storage under
      // DataKey::PoolCap, which RPC exposes with no getter and no contract
      // change. Read live 2026-09-10 (T3 mainnet deploy): pool_cap = 40,000
      // XLM, giving min 8 XLM / max 500 XLM — F19's structural bound on how
      // much the exposed admin/co-signer keys can ever control.
      //
      // The bps constants are compile-time Rust consts, unreadable at runtime,
      // so they live here and MUST be re-verified against types.rs if the
      // contract is ever changed.
      stakeMinBps:         2,
      stakeMaxBps:         125,
      stakeBpsDenominator: 10000,
      stakeMinFallback:    '8',
      stakeMaxFallback:    '500',

      // VERIFIED against types.rs, not assumed to match V8 by coincidence:
      // COOLDOWN_LEDGERS = 7 * LEDGERS_PER_DAY, VESTING_LEDGERS = 45 * .
      cooldownDays: 7,
      streamDays:   45,

      stats: {
        // NO catchRate. "100%" is an Ethereum result from controlled testing
        // against verified historical EVM hacks; no measured Stellar figure
        // exists. Omitted so the cell is hidden rather than inheriting a
        // number this chain has not earned.

        // TIER_A_RATIO = 15 (types.rs) — verified, same as V8.
        coverageRatio: { value: 'UP TO 15:1', label: 'COVERAGE RATIO' },

        // Verified from stake.rs: withdraw() has NO time gate. Fresh stakes set
        // penalty_locked_until_ledger = 0, and it is only ever set by a claim
        // penalty (claim.rs:928). So "no lock" is accurate here, not copied.
        lock:          { value: 'NO LOCK',    label: 'WITHDRAW ANYTIME' },
      },

      evidence: {
        // T2's audit-chain+CSO PASS (2026-08-17, 10 findings, all remediated)
        // described the T2 contract tree. T3 changed the tree (5 new flags,
        // merged 2026-09-01) and applied to SCF's Audit Bank for a NEW
        // third-party review after Tranche 2 was approved — that review is
        // in progress now, not complete. Showing T2's old PASS here would
        // misrepresent an in-progress audit as a cleared one. SDF-cleared
        // disclosure wording (Emir, 2026-09-09): applied after Tranche 2,
        // awaiting approval.
        audit: {
          toolLabel: 'third-party audit (Audit Bank)',
          date:      null,
          verdict:   'IN PROGRESS',
          severities: null,
          findingsSummary: 'Applied for third-party audit after Tranche 2 was approved and paid — review in progress, results not yet available.',
        },

        // NO `symbolic` key. Halmos does not run against Soroban, and no
        // verified Komet/model-checking result exists to put in its place. The
        // panel is hidden rather than relabelled into a generic "audit
        // coverage" box that would imply a check nobody performed.

        review: { label: 'internal audit-chain + CSO (T2 baseline)', date: '2026-08-17', verdict: 'PASS — pre-dates T3 changes, see audit above' },
        tests:  { label: 'rust test suite', value: '278 / 278', sub: 'unit tests pass' },

        // NO `invariant` key. The Soroban contract's solvency/cap checks read
        // `total_staked` accounting, never a real token.balance() call — the
        // D2 yield integration is what will make those diverge, and no
        // enforced liquid-vs-deployed invariant exists yet to close that gap
        // (see t2-build-prep.md, "Question 1"). Claiming "mathematical
        // verification confirmed the pool always holds more than it owes"
        // would be false on this chain today.
      },

      // Licence claim UNBLOCKED 2026-08-19: safu-soroban now carries a real
      // Apache-2.0 LICENSE file AND `license = "Apache-2.0"` in Cargo.toml
      // (added for SCF #44, whose Build Award criteria require a clear plan to
      // open-source the contracts). This is verified against the repo, not
      // inherited from Ethereum — the EVM contracts are BUSL-1.1 and are NOT
      // SCF-funded, so the two chains legitimately differ here.
      contractMeta: {
        langLine: 'Rust 2021 · soroban-sdk 27.0.6 · Apache-2.0',
      },

      // T3 D1 wired the vault same day as deploy (2026-09-10): DeFindex vault
      // CA2LV3YOQ5WTQJKWIK6BFWXPNMSPHRG7763T5B4JLMEJLTVNNIK6S5AP, vault_fee=0
      // verified on-chain (get_fees()==[0,5000], DeFindex earns nothing from
      // this pool), deploy_bps=500 (5% cap), upgradable=false. get_vault() no
      // longer returns null — confirm live before removing this disclosure.
      disclosures: [
        'A capped share of staked XLM (5%) is deployed into a DeFindex vault ' +
        'routing to Blend for yield. Vault fee is 0% — DeFindex earns nothing ' +
        'from this pool. XLM lending yield is small (well under 1% APY); this ' +
        'is not presented as staker income.',
      ],

      // See the matching Ethereum comment for why these exist. Updated
      // 2026-08-19 alongside the connector-stellar.js rewrite — Freighter was
      // the only supported wallet when this line was first written; now 7
      // are, so a Freighter-only sentence would itself be the same class of
      // stale/wrong claim this file exists to prevent for chain-substituted
      // strings.
      walletsLine: 'Freighter, xBull, Albedo, Rabet, Lobstr, Hana, Hot Wallet, or any other supported Stellar wallet.',
      // G... is an account strkey — the correct shape for a beneficiary
      // (contracts use C..., not the intended target here).
      beneficiaryPlaceholder: 'G... beneficiary address',
      // 2026-08-19: same claim-flow gap as Ethereum's matching fields above.
      // Tx hashes and claim ids are bare 64 hex on Stellar — NO 0x prefix,
      // adapter-stellar.js's isValidTxHash/isValidClaimId reject a prefixed
      // value outright (see that file's comment — it means the caller pasted
      // an EVM hash, and the scanner would report a guaranteed false miss).
      claimTxPlaceholder:          'drain tx hash (64 hex chars, no 0x)',
      disputeTxPlaceholder:        'tx hash (64 hex chars, no 0x)',
      disputeWalletPlaceholder:    'G... your wallet address',
      claimIdPlaceholder:          'claim ID (64 hex chars, no 0x)',
      streamBeneficiaryPlaceholder:'G... your beneficiary address',
      // Verified against contracts/protection-pool/src/claim.rs in
      // safu-soroban (2026-08-19): Soroban has NO `ClaimActivated` event —
      // the nearest equivalent is `ClaimSubmitted`, emitted with claim_id as
      // a field when the oracle submits. stellar.expert is the explorer, not
      // Etherscan.
      claimIdHint: 'Claim ID is emitted in the <strong>ClaimSubmitted</strong> event, viewable on stellar.expert.',
      // NO mevChainNote key. Stellar's consensus (SCP) and fee model do not
      // share Ethereum's public-mempool/gas-auction dynamics, and no
      // Stellar-specific frontrunning-resistance claim has been verified —
      // the chain-neutral sentence above (oracle-only signing, beneficiary
      // locked at stake time) still holds and is all this chain asserts.
    },
  },
};
