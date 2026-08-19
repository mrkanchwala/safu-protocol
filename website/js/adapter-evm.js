// EVM chain adapter.
//
// Purpose: this file is the ONLY place outside the wallet-connection flow that
// is allowed to reference `ethers`. Before 2026-08-19 `ethers` was a bare global
// used at 12 sites across 4 modules, every use EVM-specific — isAddress()
// rejects Stellar strkeys, and parseEther/formatEther hardcode 18 decimals
// where Stellar uses 7. Adding a second chain family without this seam means
// duplicating every module.
//
// Any new chain family implements the same shape. The pure functions
// (isValidAddress, isValidTxHash, formatAmount, parseAmount) are the ones with
// unit tests, because they are where a silently wrong value originates.
window.SAFU = window.SAFU || {};
window.SAFU.adapters = window.SAFU.adapters || {};

window.SAFU.adapters.evm = function (cfg) {
  const ZERO = '0x0000000000000000000000000000000000000000';

  return {
    // ── identity ─────────────────────────────────────────────────────────
    id:          cfg.id,
    family:      'evm',
    decimals:    cfg.decimals,
    assetSymbol: cfg.assetSymbol,

    // Tag always carries the network qualifier when the chain declares one,
    // so a testnet can never render at visual parity with a live mainnet.
    tag() {
      return cfg.networkLabel ? `${cfg.tag} · ${cfg.networkLabel}` : cfg.tag;
    },

    // ── validation ───────────────────────────────────────────────────────
    isValidAddress(a) {
      return typeof a === 'string' && ethers.isAddress(a);
    },

    // ethers.isAddress(ZERO) returns true and the contract rejects it with
    // "zero beneficiary", so the zero check has to be separate.
    isZeroAddress(a) {
      return typeof a === 'string' && a.toLowerCase() === ZERO;
    },

    sameAddress(a, b) {
      return typeof a === 'string' && typeof b === 'string'
        && a.toLowerCase() === b.toLowerCase();
    },

    // EVM tx hashes and bytes32 claim ids are 0x + 64 hex. Stellar's are the
    // same 64 hex WITHOUT the 0x prefix, which is why this is per-family.
    isValidTxHash(h) {
      return typeof h === 'string' && /^0x[0-9a-fA-F]{64}$/.test(h);
    },

    isValidClaimId(id) {
      return typeof id === 'string' && /^0x[0-9a-fA-F]{64}$/.test(id);
    },

    // ── amounts ──────────────────────────────────────────────────────────
    // formatUnits/parseUnits with an explicit decimals, never formatEther,
    // so a chain with different precision cannot silently inherit 18.
    formatAmount(raw) {
      return ethers.formatUnits(raw, cfg.decimals);
    },

    parseAmount(human) {
      return ethers.parseUnits(String(human), cfg.decimals);
    },

    // ── contract-specific ────────────────────────────────────────────────
    // keccak256(abi.encodePacked(beneficiary)) — the exact preimage
    // SAFUPoolV8.sol uses at :147, :272, :323 and :544. claimStream and
    // withdraw both revert on a mismatch, so this lets the UI check first
    // instead of the user paying gas for the revert.
    hashBeneficiary(a) {
      return ethers.solidityPackedKeccak256(['address'], [a]);
    },

    // ── links ────────────────────────────────────────────────────────────
    explorerTxUrl(h)     { return cfg.explorerTxBase + h; },
    explorerAddrUrl(a)   { return cfg.explorerAddrBase + a; },
    explorerName()       { return cfg.explorerName; },

    // ── network access ───────────────────────────────────────────────────
    readContract() {
      return new ethers.Contract(
        cfg.contract,
        window.SAFU_ABI,
        new ethers.JsonRpcProvider(cfg.rpcUrl)
      );
    },

    signerContract(signer) {
      return new ethers.Contract(cfg.contract, window.SAFU_ABI, signer);
    },

    // ── semantic reads ───────────────────────────────────────────────────
    // Named by WHAT they answer, not by which contract method answers it.
    // init.js previously called rc.totalStakers() / rc.STAKE_MIN() directly,
    // which is an EVM-shaped call the Stellar contract has no analogue for —
    // Soroban has no STAKE_MIN getter at all, it derives bounds from a stored
    // pool cap. Keeping the raw contract handle in the caller meant every read
    // site would need a family branch.
    async readTotalStakers() {
      return Number(await this.readContract().totalStakers());
    },

    async readPaused() {
      return Boolean(await this.readContract().paused());
    },

    // Returns human-readable strings, or null when the chain cannot answer.
    // Null is distinguishable from "0" on purpose: the caller falls back to the
    // configured bounds rather than rendering a zero range.
    async readStakeBounds() {
      const rc = this.readContract();
      const [minRaw, maxRaw] = await Promise.all([rc.STAKE_MIN(), rc.STAKE_MAX()]);
      return { min: this.formatAmount(minRaw), max: this.formatAmount(maxRaw) };
    },

    // What a confirmation reference is CALLED on this chain. Stellar confirms
    // into a ledger, not a block, and printing "block: 58231" for a Stellar tx
    // is wrong in a way a user would notice and not be able to look up.
    blockLabel: 'block',

    async readTotalEverStaked() {
      return Number(await this.readContract().totalEverStaked());
    },

    // Normalised stake record. Field names and units are family-specific
    // (`stakedAt` seconds here vs a ledger sequence on Soroban), so the adapter
    // flattens them and callers stay family-neutral.
    async readStakeRecord(addr) {
      const s = await this.readContract().stakeOf(addr);
      const amount = BigInt(s.amount);
      const lock = BigInt(s.penaltyLockedUntil);
      return {
        exists:          amount > 0n || Boolean(s.withdrawn),
        amountRaw:       amount,
        withdrawn:       Boolean(s.withdrawn),
        claimActive:     Boolean(s.claimActive),
        suspended:       Boolean(s.suspended),
        stakedAtSeconds: Number(s.stakedAt),
        beneficiaryHash: s.beneficiaryHash,
        // Already humanised BY the adapter: V8 stores a unix timestamp, so a
        // date is honest here. The Soroban adapter stores a LEDGER SEQUENCE and
        // says so instead of inventing a date from an assumed ledger interval.
        penaltyLockLabel: lock > 0n
          ? new Date(Number(lock) * 1000).toLocaleDateString()
          : null,
      };
    },

    // Every precondition stakeETH() enforces, checked before the user is asked
    // to sign. stakeETH has 10 requires; this UI once checked 3, so "pool full",
    // "pool cap exceeded", "zero beneficiary", "beneficiary cannot be
    // oracle/owner/coSigner" and a paused pool all reached the wallet as a
    // signature request and reverted at the user's expense.
    // Returns an error string, or null when the tx should succeed.
    async preflightStake({ staker, beneficiary, amountRaw }) {
      const rc = this.readContract();
      const sym = cfg.assetSymbol;
      const fmt = v => `${this.formatAmount(v)} ${sym}`;

      const [isPaused, totalStaked, maxPoolEth, maxPoolSize, oracle, owner, coSigner, existing] =
        await Promise.all([
          rc.paused(), rc.totalStaked(), rc.MAX_POOL_ETH(), rc.maxPoolSize(),
          rc.oracle(), rc.owner(), rc.coSigner(), rc.stakeOf(staker),
        ]);

      if (isPaused) return 'The pool is paused — staking is disabled right now.';
      if (BigInt(existing.amount) > 0n && !existing.withdrawn)
        return 'This wallet already has an active stake. The pool allows one policy per wallet.';

      const after = BigInt(totalStaked) + BigInt(amountRaw);
      if (after > BigInt(maxPoolEth))
        return `Pool full — hard cap is ${fmt(maxPoolEth)} and ${fmt(totalStaked)} is staked.`;
      if (after > BigInt(maxPoolSize))
        return `Pool cap reached — current cap is ${fmt(maxPoolSize)} and ${fmt(totalStaked)} is staked.`;

      if (this.sameAddress(beneficiary, oracle))   return 'Beneficiary cannot be the oracle address.';
      if (this.sameAddress(beneficiary, owner))    return 'Beneficiary cannot be the contract owner.';
      if (this.sameAddress(beneficiary, coSigner)) return 'Beneficiary cannot be the co-signer address.';

      return null;
    },

    // ── writes ───────────────────────────────────────────────────────────
    // Normalised to { hash, confirm() -> { blockRef } } so stake.js and
    // stream.js do not branch on family. The connection lives in SAFU.state
    // because it is the app's single connection, not the adapter's.
    async sendStake({ beneficiary, amountRaw }) {
      const c = window.SAFU.state.contract;
      if (!c) throw new Error('SAFU: no signer contract — connect a wallet first');
      const tx = await c.stakeETH(beneficiary, true, { value: amountRaw });
      return {
        hash: tx.hash,
        confirm: async () => ({ blockRef: (await tx.wait()).blockNumber }),
      };
    },

    async sendClaimStream({ claimId, beneficiary }) {
      const c = window.SAFU.state.contract;
      if (!c) throw new Error('SAFU: no signer contract — connect a wallet first');
      const tx = await c.claimStream(claimId, beneficiary);
      return {
        hash: tx.hash,
        confirm: async () => ({ blockRef: (await tx.wait()).blockNumber }),
      };
    },

    // ── api routing ──────────────────────────────────────────────────────
    verifyUrl()          { return CONFIG.SAFU_API_BASE + cfg.verifyPath; },
    verifyJobUrl(jobId)  { return `${CONFIG.SAFU_API_BASE}${cfg.verifyPath}/${jobId}`; },
    claimUrl()           { return CONFIG.SAFU_API_BASE + cfg.claimPath; },
    apiChain()           { return cfg.apiChain; },

    // ── raw config escape hatch ──────────────────────────────────────────
    // For the wallet-connection flow, which still owns provider setup.
    cfg,
    zeroAddress: ZERO,
  };
};
