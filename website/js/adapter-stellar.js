// Stellar / Soroban chain adapter.
//
// Registered under family 'stellar'. Implements the same shape as
// adapter-evm.js, and every place the two genuinely differ is a place a shared
// implementation would have been silently wrong rather than merely awkward:
//
//   decimals        7 (stroops), not 18. Formatting a stroop amount through an
//                   18-decimal helper understates it by 10^11.
//   address form    base32 strkey, case-SENSITIVE. EVM's sameAddress()
//                   lowercases both sides; doing that here corrupts the value.
//   tx hash         64 hex with NO 0x prefix. EVM's regex requires the prefix,
//                   so every valid Stellar hash would fail validation before a
//                   request fired.
//   beneficiary     sha256 over the Address's ScVal XDR — NOT keccak256, and
//   hash            not over the address string. Verified two ways, see below.
//   zero address    does not exist in Stellar. There is nothing to guard.
//
// SDK: window.StellarSdk, from the vendored official SDF UMD bundle
// (js/stellar-sdk.min.js, @stellar/stellar-sdk 16.2.0). Provenance and update
// procedure in docs/vendored-js.md. Loaded on demand by ensureSdk() rather than
// a top-level script tag: ethers (479 KB) + stellar-sdk (472 KB) is ~950 KB if
// both load eagerly, and a visitor transacts on one chain at a time.
window.SAFU = window.SAFU || {};
window.SAFU.adapters = window.SAFU.adapters || {};

window.SAFU.adapters.stellar = function (cfg) {
  const DECIMALS = BigInt(cfg.decimals);           // 7 — from config, never assumed
  const SCALE    = 10n ** DECIMALS;
  const HEX64    = /^[0-9a-fA-F]{64}$/;            // no 0x — deliberately
  // Same estimate basis as the T3 demo video's ledger→date conversion. Real
  // ledger close time varies, so every caller of estimateRemaining() must
  // label its output "~", never as an exact time.
  const AVG_LEDGER_SECONDS = 5;

  // ── SDK loading ────────────────────────────────────────────────────────
  let sdkPromise    = null;
  let instanceCache = null;   // pool-wide globals; one RPC read serves all three reads

  function sdk() {
    if (!window.StellarSdk) {
      throw new Error('SAFU: Stellar SDK not loaded — await adapter.ensureSdk() first');
    }
    return window.StellarSdk;
  }

  // CHANGED 2026-08-19: was `import('./stellar-sdk.min.js')`. A dynamic import
  // evaluates the file as an ES MODULE, where top-level `this` is undefined —
  // which happens to work for stellar-sdk (its UMD prefers `globalThis`) but
  // throws for freighter-api (`r.freighterApi = e()` with `r === this`). Using
  // one classic-script loader for both removes that asymmetry rather than
  // relying on a preamble detail per bundle. See js/loader.js.
  function ensureSdk() {
    if (window.StellarSdk) return Promise.resolve(window.StellarSdk);
    if (!sdkPromise) {
      sdkPromise = window.SAFU.loadScript('js/stellar-sdk.min.js', 'StellarSdk')
        .catch(e => { sdkPromise = null; throw e; });
    }
    return sdkPromise;
  }

  // ── amounts ────────────────────────────────────────────────────────────
  // Integer-only, via BigInt. i128 stroop values exceed Number.MAX_SAFE_INTEGER
  // at 900,719,925,474 XLM, and float arithmetic on a staked balance is a
  // correctness bug waiting for a large pool rather than a style preference.
  function formatAmount(raw) {
    let v = typeof raw === 'bigint' ? raw : BigInt(String(raw));
    const neg = v < 0n;
    if (neg) v = -v;
    const frac = (v % SCALE).toString().padStart(cfg.decimals, '0').replace(/0+$/, '');
    return `${neg ? '-' : ''}${v / SCALE}${frac ? '.' + frac : ''}`;
  }

  // Throws on more precision than the asset has, rather than truncating.
  // Truncating would stake LESS than the user typed and confirmed, silently.
  function parseAmount(human) {
    const s = String(human).trim();
    if (!/^-?\d+(\.\d+)?$/.test(s)) {
      throw new Error(`SAFU: "${human}" is not a valid ${cfg.assetSymbol} amount`);
    }
    const neg = s.startsWith('-');
    const [whole, frac = ''] = s.replace('-', '').split('.');
    if (frac.length > cfg.decimals) {
      throw new Error(`SAFU: ${cfg.assetSymbol} supports at most ${cfg.decimals} decimal places`);
    }
    const v = BigInt(whole) * SCALE + BigInt((frac + '0'.repeat(cfg.decimals)).slice(0, cfg.decimals));
    return neg ? -v : v;
  }

  // BytesN<32> travels as bare hex in this UI (no 0x), so conversion happens
  // here rather than at each call site. Uint8Array, not Buffer — this runs in a
  // browser where Buffer does not exist.
  function _toHex(bytes) {
    return Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
      .map(b => b.toString(16).padStart(2, '0')).join('');
  }

  function _fromHex(hex) {
    const clean = String(hex).replace(/^0x/, '');
    if (!/^[0-9a-fA-F]{64}$/.test(clean)) {
      throw new Error(`SAFU: expected 64 hex characters, got "${hex}"`);
    }
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
    return out;
  }

  return {
    // ── identity ─────────────────────────────────────────────────────────
    id:          cfg.id,
    family:      'stellar',
    decimals:    cfg.decimals,
    assetSymbol: cfg.assetSymbol,

    tag() {
      return cfg.networkLabel ? `${cfg.tag} · ${cfg.networkLabel}` : cfg.tag;
    },

    ensureSdk,

    // ── validation ───────────────────────────────────────────────────────
    // A Soroban `Address` is either an account (G…) or a contract (C…), and the
    // pool's beneficiary is typed as Address, so both are legitimate.
    isValidAddress(a) {
      if (typeof a !== 'string') return false;
      const S = sdk();
      return S.StrKey.isValidEd25519PublicKey(a) || S.StrKey.isValidContract(a);
    },

    // Stellar has no zero address. The Soroban contract carries no
    // zero-beneficiary guard for exactly this reason (stake.rs:150 notes V8's
    // address(0) check has no Soroban equivalent), so there is no revert for
    // the UI to pre-empt. Returning false is the accurate answer, not a stub.
    isZeroAddress() {
      return false;
    },

    // NO case folding. Strkeys are case-sensitive uppercase base32; lowercasing
    // to compare, as the EVM adapter does, would make two different values look
    // equal and corrupt anything derived from the comparison.
    sameAddress(a, b) {
      return typeof a === 'string' && typeof b === 'string' && a === b;
    },

    // Stellar transaction hashes and BytesN<32> claim ids are 64 hex chars with
    // no 0x prefix. A prefixed value is rejected rather than tolerated: it means
    // the caller pasted an EVM hash, and accepting it would send a guaranteed
    // miss to the scanner and report it back as "no drain found".
    isValidTxHash(h) {
      return typeof h === 'string' && HEX64.test(h);
    },

    isValidClaimId(id) {
      return typeof id === 'string' && HEX64.test(id);
    },

    // ── amounts ──────────────────────────────────────────────────────────
    formatAmount,
    parseAmount,

    // ── contract-specific ────────────────────────────────────────────────
    // sha256(Address.to_xdr(env)) — protection-pool stake.rs:167, :225, :250.
    // withdraw() and set_beneficiary() both compare against this, so a wrong
    // preimage does not error at the UI; it makes the CONTRACT reject a
    // correct withdrawal.
    //
    // VERIFIED 2026-08-19, two independent tools rather than derived:
    //   1. StellarSdk.Address.fromString(a).toScVal().toXDR() → 44 bytes for an
    //      account (ScVal disc 18 = SCV_ADDRESS, ScAddress disc 0 = ACCOUNT,
    //      PublicKey disc 0 = ED25519, then 32 raw bytes), 40 for a contract.
    //   2. `stellar xdr decode --type ScVal` round-trips those exact bytes back
    //      to the original strkey — confirming the encoding is ScVal XDR, which
    //      is what Rust's Address::to_xdr(env) produces.
    // Returns bare hex, no 0x, matching how Stellar renders BytesN<32>.
    hashBeneficiary(a) {
      const S = sdk();
      const xdr = S.Address.fromString(a).toScVal().toXDR();
      return Array.from(S.hash(xdr)).map(b => b.toString(16).padStart(2, '0')).join('');
    },

    // ── links ────────────────────────────────────────────────────────────
    explorerTxUrl(h) { return cfg.explorerTxBase + h; },

    // stellar.expert routes contracts and accounts to DIFFERENT paths, unlike
    // Etherscan's single /address/. Branching on the strkey prefix keeps one
    // config field instead of two, and a wrong path is a 404 the user sees.
    explorerAddrUrl(a) {
      const isContract = typeof a === 'string' && a.startsWith('C');
      return (isContract ? cfg.explorerContractBase : cfg.explorerAccountBase) + a;
    },

    explorerName() { return cfg.explorerName; },

    // ── network access ───────────────────────────────────────────────────
    server() {
      const S = sdk();
      return new S.rpc.Server(cfg.rpcUrl, { allowHttp: cfg.rpcUrl.startsWith('http://') });
    },

    contract() {
      // `new sdk().Contract(x)` parses as `(new sdk()).Contract(x)` — it
      // constructs the accessor and then calls Contract WITHOUT new. Binding
      // the namespace first is what makes the `new` apply to Contract.
      const S = sdk();
      return new S.Contract(cfg.contract);
    },

    // ── semantic reads ───────────────────────────────────────────────────
    // ONE RPC round-trip answers pool cap, paused state and staker count
    // together, because all three are pool-wide globals in the contract's
    // INSTANCE storage (storage.rs: admin/oracle/co_signer/xlm_token/pool_cap/
    // total_* /paused all use env.storage().instance()). RPC exposes that entry
    // directly, so none of these needs a getter function or a simulated
    // invocation — which matters, because the contract HAS no pool-cap getter.
    //
    // Verified live against the deployed T1 contract 2026-08-19: 9 entries,
    // PoolCap = 6000000000000 stroops (600,000 XLM).
    async readInstanceStorage(force) {
      if (instanceCache && !force) return instanceCache;
      const S = await ensureSdk();
      const server = new S.rpc.Server(cfg.rpcUrl, { allowHttp: cfg.rpcUrl.startsWith('http://') });
      const res = await server.getContractData(
        cfg.contract,
        S.xdr.ScVal.scvLedgerKeyContractInstance(),
        S.rpc.Durability.Persistent
      );
      const entries = res.val.contractData().val().instance().storage() || [];
      const out = {};
      for (const e of entries) {
        const k = S.scValToNative(e.key());
        out[Array.isArray(k) ? k.join('.') : String(k)] = S.scValToNative(e.val());
      }
      instanceCache = out;
      return out;
    },

    async readTotalStakers() {
      const s = await this.readInstanceStorage();
      return Number(s.TotalStakers ?? 0);
    },

    async readPaused() {
      const s = await this.readInstanceStorage();
      return Boolean(s.Paused);
    },

    // Soroban has no STAKE_MIN/STAKE_MAX. Bounds are pool_cap × bps / 10_000,
    // recomputed live by the contract on every stake call (stake.rs:105-113),
    // so a cap change via set_pool_cap moves them immediately. Deriving them
    // the same way here is the only way the UI can stay in step; the bps values
    // are compile-time Rust consts and come from config.
    async readStakeBounds() {
      const s = await this.readInstanceStorage();
      if (s.PoolCap === undefined || s.PoolCap === null) return null;
      const cap = BigInt(s.PoolCap);
      const den = BigInt(cfg.stakeBpsDenominator);
      return {
        min: formatAmount(cap * BigInt(cfg.stakeMinBps) / den),
        max: formatAmount(cap * BigInt(cfg.stakeMaxBps) / den),
      };
    },

    // Soroban confirms into a LEDGER, not a block. Printing "block: 58231" for
    // a Stellar tx is wrong in a way the user would notice and be unable to
    // look up, so the label travels with the adapter.
    blockLabel: 'ledger',

    // Soroban has NO total_ever_staked. The OG-staker badge (everStaked <= 50)
    // is an EVM-only signal, so this returns null and callers omit the badge
    // rather than showing it based on a substituted number.
    async readTotalEverStaked() {
      return null;
    },

    async readStakeRecord(addr) {
      const S = await ensureSdk();
      const raw = await this._simulate('get_stake', [S.Address.fromString(addr).toScVal()]);

      // Option<StakeRecord>: None decodes to null/undefined, not an empty object.
      if (raw === null || raw === undefined) {
        return { exists: false, amountRaw: 0n, withdrawn: false, claimActive: false,
                 suspended: false, stakedAtSeconds: null, beneficiaryHash: null,
                 penaltyLockLabel: null };
      }

      const amount = BigInt(raw.amount ?? 0);
      const lockLedger = Number(raw.penalty_locked_until_ledger ?? 0);

      return {
        exists:      amount > 0n || Boolean(raw.withdrawn),
        amountRaw:   amount,
        withdrawn:   Boolean(raw.withdrawn),
        // T1↔T2 DRIFT, handled deliberately: the DEPLOYED T1 contract exposes
        // `claim_active: bool`, T2 source renamed it to
        // `active_claim_id: Option<BytesN<32>>`. Reading only one breaks on one
        // side of the redeploy. Delete the dead branch at redeploy — see the
        // T2 REDEPLOY CHECKLIST in project memory.
        claimActive: raw.claim_active !== undefined
          ? Boolean(raw.claim_active)
          : Boolean(raw.active_claim_id),
        suspended:   Boolean(raw.suspended),
        // staked_at_timestamp is real unix seconds; staked_at_ledger is a
        // sequence number. Use the timestamp — it is the one that means a date.
        stakedAtSeconds: raw.staked_at_timestamp !== undefined
          ? Number(raw.staked_at_timestamp)
          : null,
        beneficiaryHash: raw.beneficiary_hash ? _toHex(raw.beneficiary_hash) : null,
        // A LEDGER SEQUENCE, not a timestamp. Rendering it as a date would mean
        // multiplying by an assumed 5s ledger interval and presenting an
        // estimate as a fact, so it is labelled for what it is.
        penaltyLockLabel: lockLedger > 0 ? `ledger ${lockLedger}` : null,
      };
    },

    // Option<Claim>: None decodes to null/undefined. Status is the raw
    // ClaimStatus discriminant (types.rs:220-232) — Unused=0, Active=1,
    // Completed=2, Cancelled=3, Reserved=4, PendingTime=5, AwaitingApproval=6,
    // Expired=7 — verified against source, not assumed. Callers branch on the
    // number directly rather than this file guessing a label for every state;
    // only the cooldown-remaining case (Active) needs translating.
    async readClaim(claimId) {
      // ensureSdk() first, matching readStakeRecord's own pattern — sdk()
      // (sync) assumes the SDK is already loaded, which is not guaranteed if
      // this is the first Stellar-SDK-touching call on the page.
      const S = await ensureSdk();
      const raw = await this._simulate('get_claim', [S.xdr.ScVal.scvBytes(_fromHex(claimId))]);
      if (raw === null || raw === undefined) return null;
      return {
        status:              Number(raw.status),
        cooldownEndsLedger:  Number(raw.cooldown_ends_ledger ?? 0),
        vestingEndsLedger:   Number(raw.vesting_ends_ledger ?? 0),
        entitlementRaw:      BigInt(raw.entitlement ?? 0),
        streamedRaw:         BigInt(raw.streamed ?? 0),
        wallet:              raw.wallet ?? null,
      };
    },

    // Same 5s/ledger estimate the T3 demo video used for "~September 19" —
    // labelled with a "~" everywhere it reaches the UI for the same reason
    // penaltyLockLabel above refuses to: Stellar's actual ledger interval
    // varies, so this is an estimate, never presented as an exact time.
    async readCurrentLedger() {
      const server = this.server();
      const res = await server.getLatestLedger();
      return Number(res.sequence);
    },

    // Ledger-delta to a rounded, human day/hour estimate. Floors at "less
    // than an hour" rather than a negative or zero-looking string — a claim
    // whose cooldown ends mid-call should read as "almost there", not "-3m".
    estimateRemaining(ledgersRemaining) {
      const seconds = Math.max(0, ledgersRemaining) * AVG_LEDGER_SECONDS;
      const days = Math.floor(seconds / 86400);
      const hours = Math.floor((seconds % 86400) / 3600);
      if (days > 0) return `~${days} day${days === 1 ? '' : 's'}${hours > 0 ? ` ${hours}h` : ''}`;
      if (hours > 0) return `~${hours} hour${hours === 1 ? '' : 's'}`;
      return 'less than an hour';
    },

    // Mirrors the Soroban contract's own stake() guards (stake.rs:143-165).
    // Everything except the existing-stake check comes from ONE instance-storage
    // read, because admin/oracle/co_signer/paused/pool_cap/total_staked are all
    // instance globals.
    async preflightStake({ staker, beneficiary, amountRaw }) {
      const sym = cfg.assetSymbol;
      const fmt = v => `${formatAmount(v)} ${sym}`;

      const [store, existing] = await Promise.all([
        this.readInstanceStorage(true),   // forced: a cached cap could be stale
        this.readStakeRecord(staker),
      ]);

      if (store.Paused) return 'The pool is paused — staking is disabled right now.';
      if (existing.exists && !existing.withdrawn)
        return 'This wallet already has an active stake. The pool allows one policy per wallet.';

      const cap = BigInt(store.PoolCap ?? 0);
      const total = BigInt(store.TotalStaked ?? 0);
      const amt = BigInt(amountRaw);

      if (cap > 0n) {
        const den = BigInt(cfg.stakeBpsDenominator);
        const min = cap * BigInt(cfg.stakeMinBps) / den;
        const max = cap * BigInt(cfg.stakeMaxBps) / den;
        if (amt < min) return `Minimum stake is ${fmt(min)}.`;
        if (amt > max) return `Maximum stake is ${fmt(max)}.`;
        if (total + amt > cap)
          return `Pool cap reached — cap is ${fmt(cap)} and ${fmt(total)} is staked.`;
      }

      // Soroban compares Addresses, so these are exact string comparisons — no
      // case folding, unlike the EVM adapter.
      if (this.sameAddress(beneficiary, staker))          return 'Beneficiary must differ from your staker wallet.';
      if (this.sameAddress(beneficiary, store.Oracle))    return 'Beneficiary cannot be the oracle address.';
      if (this.sameAddress(beneficiary, store.Admin))     return 'Beneficiary cannot be the pool admin address.';
      if (this.sameAddress(beneficiary, store.CoSigner))  return 'Beneficiary cannot be the co-signer address.';

      return null;
    },

    // ── writes ───────────────────────────────────────────────────────────
    async sendStake({ beneficiary, amountRaw }) {
      const S = await ensureSdk();
      const staker = window.SAFU.state.walletAddress;
      if (!staker) throw new Error('SAFU: connect a wallet first');
      return this._invoke('stake', [
        S.Address.fromString(staker).toScVal(),
        S.nativeToScVal(BigInt(amountRaw), { type: 'i128' }),
        S.Address.fromString(beneficiary).toScVal(),
      ]);
    },

    // withdraw() takes no amount — it's always the full stake, and the
    // contract's own guards (active-claim check, penalty-lock check, exact
    // beneficiary-hash match) are the real gate. Mirrors stake.rs:231-254,
    // read and confirmed 2026-09-11 during the T3 frontend eng review.
    async sendWithdraw({ beneficiary }) {
      const S = await ensureSdk();
      const staker = window.SAFU.state.walletAddress;
      if (!staker) throw new Error('SAFU: connect a wallet first');
      return this._invoke('withdraw', [
        S.Address.fromString(staker).toScVal(),
        S.Address.fromString(beneficiary).toScVal(),
      ]);
    },

    async sendClaimStream({ claimId, beneficiary }) {
      const S = await ensureSdk();
      return this._invoke('claim_stream', [
        S.xdr.ScVal.scvBytes(_fromHex(claimId)),
        S.Address.fromString(beneficiary).toScVal(),
      ]);
    },

    // ── soroban plumbing ─────────────────────────────────────────────────
    // A read-only invocation. Built with a local Account rather than
    // server.getAccount() on purpose: simulation needs a syntactically valid
    // source, not a funded one, and fetching would add a round-trip plus a
    // failure mode for wallets that have never been funded.
    async _simulate(fnName, args) {
      const S = await ensureSdk();
      const server = this.server();
      const source = new S.Account(this._simulationSource(), '0');

      const tx = new S.TransactionBuilder(source, {
        fee: cfg.baseFee || '100000',
        networkPassphrase: cfg.networkPassphrase,
      })
        .addOperation(this.contract().call(fnName, ...args))
        .setTimeout(30)
        .build();

      const sim = await server.simulateTransaction(tx);
      if (S.rpc.Api.isSimulationError(sim)) {
        throw new Error(`Soroban simulation failed for ${fnName}: ${sim.error}`);
      }
      const retval = sim.result && sim.result.retval;
      return retval === undefined ? null : S.scValToNative(retval);
    },

    _simulationSource() {
      const connected = window.SAFU.state.walletAddress;
      // Must be an ACCOUNT (G…), never a contract (C…) — a contract address is
      // not a valid transaction source.
      if (connected && connected.startsWith('G')) return connected;
      return cfg.simulationSource;
    },

    // A state-changing invocation: build → prepare (simulate + assemble, which
    // is what attaches the Soroban resource footprint and fee) → sign in the
    // wallet → submit → poll.
    async _invoke(fnName, args) {
      const S = await ensureSdk();
      const server = this.server();
      const staker = window.SAFU.state.walletAddress;
      if (!staker) throw new Error('SAFU: connect a wallet first');

      // Here the source MUST be fetched: a real sequence number is required for
      // a transaction that will actually be submitted.
      const source = await server.getAccount(staker);

      const built = new S.TransactionBuilder(source, {
        fee: cfg.baseFee || '100000',
        networkPassphrase: cfg.networkPassphrase,
      })
        .addOperation(this.contract().call(fnName, ...args))
        .setTimeout(180)
        .build();

      // prepareTransaction simulates and assembles in one step. If the contract
      // would reject the call, it fails HERE — before the user is asked to sign
      // — which is the same "never ask for a signature that cannot succeed"
      // principle as the EVM pre-flight.
      const prepared = await server.prepareTransaction(built);

      const connector = window.SAFU.connectors.stellar;
      if (!connector) throw new Error('SAFU: no Stellar wallet connector available');
      const signedXdr = await connector.signTransaction(prepared.toXDR());

      const signed = S.TransactionBuilder.fromXDR(signedXdr, cfg.networkPassphrase);
      const sent = await server.sendTransaction(signed);

      if (sent.status === 'ERROR') {
        throw new Error(`Stellar rejected the transaction: ${JSON.stringify(sent.errorResult ?? sent)}`);
      }

      const hash = sent.hash;
      return {
        hash,
        confirm: async () => {
          const res = await this._pollTransaction(hash);
          return { blockRef: res.ledger };
        },
      };
    },

    // Soroban submission is asynchronous: sendTransaction returns PENDING and
    // the result appears later. Without polling, the UI would report success for
    // a transaction that went on to FAIL on-chain.
    async _pollTransaction(hash, attempts = 30, delayMs = 1000) {
      const S = await ensureSdk();
      const server = this.server();
      for (let i = 0; i < attempts; i++) {
        await new Promise(r => setTimeout(r, delayMs));
        const res = await server.getTransaction(hash);
        if (res.status === S.rpc.Api.GetTransactionStatus.NOT_FOUND) continue;
        if (res.status === S.rpc.Api.GetTransactionStatus.SUCCESS) return res;
        throw new Error(`Transaction failed on-chain (${res.status})`);
      }
      throw new Error('Timed out waiting for confirmation — check the explorer for the final status.');
    },

    // ── api routing ──────────────────────────────────────────────────────
    verifyUrl()         { return CONFIG.SAFU_API_BASE + cfg.verifyPath; },
    verifyJobUrl(jobId) { return `${CONFIG.SAFU_API_BASE}${cfg.verifyPath}/${jobId}`; },
    claimUrl()          { return CONFIG.SAFU_API_BASE + cfg.claimPath; },
    apiChain()          { return cfg.apiChain; },

    cfg,

    // Deliberately null, not a placeholder string. Any caller reaching for a
    // zero address on Stellar has an EVM assumption in it.
    zeroAddress: null,
  };
};
