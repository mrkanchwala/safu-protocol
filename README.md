# SAFU — System Assurances

**System Assurances, F\*\*k You. Stake in SAFU.**

Most staking gives you yield. SAFU staking gives you cover. Stake ETH, earn yield while you wait, and get protected against wallet hacks. If your wallet gets drained — phishing, approval exploit, key compromise — you get paid out. Deterministically. No human vote. No governance proposal. No waiting room.

[safustaking.com](https://safustaking.com)

---

## How it works

1. **Enroll** — your wallet is assessed by the SAFU oracle, which assigns your tier (A / B / C) and stake requirement.
2. **Stake** — stake ETH. Your ETH is deployed to liquid staking to earn yield while your coverage is active. You can withdraw anytime — no lock period.
3. **Accumulate points** — points accrue from day 1. Reach 9,000 points to become claim-eligible (approximately 90 days at base rate).
4. **If you get hacked** — oracle submits the verified incident within 30 days of the hack. 9,000 points are burned, stake is forfeited, payout activates automatically. Streams to your beneficiary over 45 days. 2% daily cap, no exceptions.

No committee. No vote. Same inputs, same output, every time.

---

## Tier system

| Tier | Stake required | Max payout |
|------|----------------|------------|
| A    | 0.25 ETH       | 3.75 ETH   |
| B    | 0.50 ETH       | 3.75 ETH   |
| C    | 0.75 ETH       | 3.75 ETH   |

All tiers get the same max payout. Higher-risk wallets stake more collateral to earn the same coverage. DECLINE-flagged wallets are floored to tier C off-chain — no wallet is ever rejected at the contract level.

---

## Points system

Points accrue from `stakedAt`. Rate increases with commitment:

| Days staked | Points/day |
|-------------|-----------|
| 0 – 89      | 100       |
| 90 – 179    | 120       |
| 180 – 364   | 150       |
| 365+        | 200       |

**9,000 points** are required to activate a claim. Points not burned on a claim are banked permanently in `pointsBalance` — they accumulate across all staking cycles and are never lost on withdrawal.

**Pending claims (status 5):** If a hack is reported when the staker has fewer than 9,000 points, the claim is logged on-chain immediately but the stream activates once the staker reaches 9,000 points. The oracle must report the hack within 30 days of its occurrence — the 9,000-point accumulation may take longer.

---

## Payout controls

- **`submitClaim`** — oracle or owner registers a verified loss. Auto-activates the payout stream. Stake is permanently forfeited at this point.
- **`claimStream`** — pull-payment; claimant calls daily after the 7-day cooldown. 100% linear over 45 days.
- **2% daily cap** — applies to `totalStakedSnapshot` at claim activation. No exemptions, including owner.
- **Dynamic stress cap** — daily entitlement accepted shrinks automatically as pool utilisation rises: 25% of pool below 20% utilisation, 10% at 20–49%, 3% at ≥50%. At ≥50% utilisation, new claim submissions are blocked.
- **`cancelClaim` (F1)** — owner only. Cancels a false-positive claim. Stake is not returned — permanent forfeiture is the penalty design. Principal is restored to pool accounting; staker receives a 365-day withdrawal lock.
- **`approveOverride` (F2)** — 2-of-2 owner + coSigner. Corrects false negatives or disputes.

---

## SAFUPool v7 — Mainnet

| | |
|---|---|
| **Contract** | `[address published at deploy]` |
| **Network** | Ethereum Mainnet |
| **Verified source** | Etherscan + Sourcify |
| **Compiler** | Solidity 0.8.25, optimizer 200 runs |
| **License** | BUSL-1.1 |

---

## What's in this repo

| File | What |
|------|------|
| `contracts/SAFUPoolV7.sol` | On-chain pool — staking, yield integration, payout stream, tier enforcement, points system |
| `script/Deploy.s.sol` | Foundry deploy script — atomically deploys with oracle, coSigner, maxPool, treasury args |
| `foundry.toml` | Compiler settings for reproducible builds |
| `test/SAFUPoolV7.t.sol` | 161-test Foundry suite |
| `test/SAFUPoolV7Halmos.t.sol` | Symbolic execution — 12 properties, zero counterexamples |

The oracle scoring engine is off-chain and closed source. What's on-chain is the payout execution — auditable, deterministic, immutable.

---

## Security

| Check | Result |
|-------|--------|
| Internal CSO audit (2026-06-13) | PASS — 0 CRITICAL / 0 HIGH / 4 MEDIUM fixed / 2 LOW fixed |
| Halmos symbolic execution | 12/12 properties — zero counterexamples |
| Foundry test suite | 161/161 PASS |
| Hashlock AI audit | Pending (v7) |

Previous Hashlock v6 report: https://aiaudit.hashlock.com/audit/890ab9ec-8311-423f-9bd1-7d4a3cce48f8

**v7 CSO fixes (2026-06-13):**
- `emergencyExit` now blocked when staker has an active or pending claim — prevents `totalAllocated` griefing during pause
- Oracle and coSigner must be different keys — enforced at constructor, `setOracle`, and `setCoSigner`
- `withdraw()` NatSpec corrected — v7 has no lock period

---

## Events — indexing notes

- **`PointsEarned`** is indexed by `keccak256(beneficiary)`. Hash the beneficiary address before querying logs.
- **`YieldReceived`** fires on external ETH received. It does NOT fire on ETH returned from the internal swap path — those receipts are suppressed by the `_swapping` flag.
- **`totalExtractedYield`** (state var): tracks ETH sent to treasury via `extractYield()` (net yield only) and `withdrawYield()` (total ETH withdrawn). The two callers record different amounts — use individual `YieldExtracted` and raw transfer events for precise per-call accounting.

---

## Known design decisions

- **No lock period.** Stakers can withdraw anytime. Coverage is active from stake date. No time-lock on principal recovery.
- **Stake forfeiture on claim (by design).** When `submitClaim` runs, the staker's principal is permanently forfeited regardless of claim outcome. A false-positive `cancelClaim` does not return the stake — forfeiture is the penalty, not a bug. Principal is restored to pool accounting; the 365-day withdrawal lock is the actual consequence.
- **Oracle trust model.** The G9 enrollment cap (ensuring coverage_committed ≤ pool_TVL) is enforced oracle-side only. The contract has no on-chain guard for enrollment volume — the oracle is founder-controlled. This is an intentional design choice at current TVL. Disclosed here and in NatSpec.
- **Pending claim window.** The 30-day claim window applies at `submitClaim` time only. A pending claim (status 5) logged within the window can be activated by `unlockPendingClaim` after the window expires — the oracle's on-chain verification at submit time is the authoritative gate.
- **2-of-2 coSigner.** `coSigner != owner` and `coSigner != oracle` are enforced at constructor and `setCoSigner`. `oracle != coSigner` is also enforced at `setOracle`. `transferOwnership` enforces `newOwner != coSigner`. Both keys are required for `approveOverride` execution.

---

## Risk disclosures

**Liquid staking protocol dependency.** Staked ETH is deployed to a liquid staking protocol on deposit and unwound on withdrawal. A slashing event or depeg on the underlying liquid staking token means stakers may receive less ETH than their original principal on withdrawal. There is no on-chain mitigation for this at current TVL — accepted risk, disclosed here.

**Swap pool dependency.** Withdrawals route through an on-chain stETH/ETH swap pool to convert the liquid staking token back to ETH. If the swap pool is paused or severely imbalanced, `withdraw()` and `provideClaimLiquidity()` will revert until pool conditions normalise. There is no fallback swap path in v7 — this is a known limitation.

**Centralisation.** `submitClaim`, `cancelClaim`, `setOracle`, `pause`, and `emergencyExit` are owner or oracle-controlled. At current stage, the protocol is founder-operated. Multi-sig upgrade is planned for production scale.

---

## Compile

```bash
forge install OpenZeppelin/openzeppelin-contracts
forge build
forge test
```
