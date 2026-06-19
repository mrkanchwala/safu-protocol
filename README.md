# SAFU — System Assurances

**System Assurances, F\*\*k You. Stake in SAFU.**

Stake ETH and get covered against wallet drains. If your wallet gets drained — phishing, approval exploit, key compromise — the contract pays you back automatically. Up to 15x your stake. No human vote. No governance proposal. No waiting room.

[safustaking.com](https://safustaking.com)

---

## How it works

1. **Stake** — deposit any amount between 0.01 and 0.75 ETH. Permissionless — no oracle approval required. Set a beneficiary address for payouts.
2. **Coverage activates** — your ETH is deployed to liquid staking. Withdraw anytime — no lock period.
3. **Accumulate points** — points accrue proportionally to your stake amount from day 1. After 90 days staked, your wallet becomes claim-eligible.
4. **If you get hacked** — oracle submits the verified incident within 30 days of the hack. Your tier is assessed at claim time. Stake is forfeited, payout streams to your beneficiary over 45 days.

No committee. No vote. Same inputs, same output, every time.

---

## Coverage

Stake any amount between 0.01 and 0.75 ETH. Your tier is assessed at claim time based on your wallet's on-chain history — not at staking. Coverage scales proportionally:

| Tier | Coverage multiplier | Max payout (at 0.75 ETH stake) | Wallet profile |
|------|--------------------|---------------------------------|----------------|
| A    | 15x                | 11.25 ETH                       | Clean history, low risk signals |
| B    | 10x                | 7.5 ETH                         | Mixed history, moderate signals |
| C    | 5x                 | 3.75 ETH                        | Higher risk signals detected |

Lower stakes get proportionally lower coverage: a 0.25 ETH Tier A stake covers up to 3.75 ETH.

---

## Points system

Points accrue from `stakedAt`, proportional to stake amount: `(stake / 0.75) × rate/day`. Rate increases with commitment:

| Days staked | Base rate (points/day at max stake) |
|-------------|-------------------------------------|
| 0 – 89      | 100                                |
| 90 – 179    | 120                                |
| 180 – 364   | 150                                |
| 365+        | 200                                |

A 0.25 ETH staker earns 1/3 the points of a 0.75 ETH staker. Points are banked permanently in `pointsBalance` — they accumulate across staking cycles and are never lost on withdrawal.

**Claim eligibility** is time-based: 90 days staked. Points are a loyalty and reward metric, not a claim gate.

**Pending claims:** If a hack is reported when the staker has been staked for fewer than 90 days, the claim is logged on-chain immediately but the stream activates once the 90-day threshold is reached. The oracle must report the hack within 30 days of its occurrence.

---

## Payout controls

- **`submitClaim`** — oracle registers a verified loss. Tier is assessed at claim time. Auto-activates the payout stream. Stake is permanently forfeited. Requires 2-of-2 cosigner attestation.
- **`claimStream`** — pull-payment; claimant calls daily after the 7-day cooldown. 100% linear over 45 days.
- **Dynamic outflow cap** — daily payout cap scales with pool utilisation: 5%/day below 20% utilised, 3%/day at 20–49%, 1%/day at ≥50%. At ≥50% utilisation, new claim submissions are blocked.
- **`cancelClaim` (F1)** — owner only. Cancels a false-positive claim. Stake is not returned — permanent forfeiture is the penalty design. Principal is restored to pool accounting; staker receives a 365-day withdrawal lock.
- **`approveOverride` (F2)** — 2-of-2 owner + coSigner. Corrects false negatives or disputes.

---

## SAFUPoolV8 — Mainnet

| | |
|---|---|
| **Contract** | [`0xa170f0937DEc353C1806eaC0c3d559524d458641`](https://etherscan.io/address/0xa170f0937DEc353C1806eaC0c3d559524d458641) |
| **Network** | Ethereum Mainnet |
| **Verified source** | Etherscan |
| **Compiler** | Solidity 0.8.25, optimizer 100 runs |
| **License** | BUSL-1.1 |
| **Oracle** | AWS KMS (secp256k1, eu-north-1) — `0x5a648f7037F32817996fc12d660425b5B9B1BdFB` |
| **CoSigner** | `0x6FeF81f9d01d62e0BE2879A2C07A4A8860064978` |

---

## What's in this repo

| File | What |
|------|------|
| `contracts/SAFUPoolV8.sol` | On-chain pool — proportional staking, permissionless enrollment, payout stream, tier-at-claim, points system |
| `script/Deploy.s.sol` | Foundry deploy script — atomically deploys with oracle, coSigner, maxPool, treasury args |
| `foundry.toml` | Compiler settings for reproducible builds |
| `test/SAFUPoolV8.t.sol` | 75-test Foundry suite |
| `test/SmokeMainnetFork.t.sol` | 10-test mainnet fork smoke suite |
| `website/` | safustaking.com static site — terminal aesthetic, WalletConnect, claim flow |

The oracle scoring engine is off-chain and closed source. What's on-chain is the payout execution — auditable, deterministic, immutable.

---

## Security

| Check | Result |
|-------|--------|
| CSO + Slither audit (2026-06-18) | PASS — 0 CRITICAL / 0 HIGH / 0 MEDIUM / 0 LOW |
| Halmos symbolic execution | 12/12 properties — zero counterexamples |
| Foundry test suite | 75/75 PASS |
| Mainnet fork smoke test | 10/10 PASS |

Previous versions: [Hashlock v6 report](https://aiaudit.hashlock.com/audit/890ab9ec-8311-423f-9bd1-7d4a3cce48f8)

---

## Events — indexing notes

- **`Staked`** — `(address indexed wallet, uint256 amount)`. No tier field — tier is assessed at claim time.
- **`PointsEarned`** is indexed by `keccak256(beneficiary)`. Hash the beneficiary address before querying logs.
- **`ClaimSubmitted`** includes `tier` — the tier assigned at claim time, not at staking.
- **`YieldReceived`** fires on external ETH received. It does NOT fire on ETH returned from the internal swap path — those receipts are suppressed by the `_swapping` flag.

---

## Known design decisions

- **Permissionless enrollment.** Any wallet can stake any amount in [0.01, 0.75] ETH. No oracle approval required. Tier is assessed at claim time by the oracle, not at staking.
- **No lock period.** Stakers can withdraw anytime. Coverage is active from stake date.
- **90-day time gate.** Claim eligibility requires 90 days staked. Points are a loyalty metric, not a claim gate.
- **Stake forfeiture on claim (by design).** When `submitClaim` runs, the staker's principal is permanently forfeited regardless of claim outcome. A false-positive `cancelClaim` does not return the stake — forfeiture is the penalty, not a bug. 365-day withdrawal lock is the consequence.
- **Proportional coverage.** Payout = `stake × tier_ratio × TIER_COVERAGE_BPS / 10_000`. With BPS at 10,000, payout = `stake × tier_ratio` exactly (15x/10x/5x).
- **Dynamic outflow cap.** Replaces the flat 2%/day cap from v7. Scales with pool utilisation to protect solvency under stress.
- **Oracle trust model.** The oracle is KMS-secured (AWS, secp256k1) and founder-controlled. Coverage cap enforcement is oracle-side only — the contract has no on-chain guard for enrollment volume. Intentional at current TVL, disclosed here and in NatSpec.
- **2-of-2 coSigner.** `coSigner != owner` and `coSigner != oracle` enforced at constructor, `setCoSigner`, and `setOracle`. `transferOwnership` enforces `newOwner != coSigner`. Both keys required for `approveOverride`.
- **2-of-2 claim attestation.** `submitClaim` requires both oracle signature and cosigner attestation with distinct prefixes. Single-key compromise cannot activate a payout.

---

## Risk disclosures

**Liquid staking protocol dependency.** Staked ETH is deployed to Lido (wstETH) on deposit and unwound on withdrawal. A slashing event or depeg means stakers may receive less ETH than their original principal on withdrawal. No on-chain mitigation at current TVL — accepted risk.

**Swap pool dependency.** Withdrawals route through the Curve stETH/ETH pool. If the pool is paused or severely imbalanced, `withdraw()` will revert until pool conditions normalise. No fallback swap path in v8.

**Centralisation.** `submitClaim`, `cancelClaim`, `setOracle`, `pause`, and `emergencyExit` are owner or oracle-controlled. Founder-operated at current stage. Multi-sig upgrade planned for production scale.

---

## Compile

```bash
forge install OpenZeppelin/openzeppelin-contracts
forge build
forge test
```
