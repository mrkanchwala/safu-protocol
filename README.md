# SAFU — System Assurances

**System Assurances, F\*\*k You. Stake in SAFU.**

Most staking gives you yield. SAFU staking gives you cover. Stake ETH, get protected against wallet hacks. If your wallet gets drained — phishing, approval exploit, key compromise — you get paid out. Deterministically. No human vote. No governance proposal. No waiting room.

[safustaking.com](https://safustaking.com)

---

## How it works

1. **Enroll** — your wallet is scored by the SAFU oracle. Score determines your tier (A / B / C).
2. **Stake** — 0.015 ETH. Your stake secures up to 0.25 ETH in coverage for 90 days.
3. **If you get hacked** — submit the incident. Payout activates automatically. Streams to your beneficiary over 45 days. 2% daily cap, no exceptions.

No committee. No vote. Same inputs, same output, every time.

---

## SAFUPool — Mainnet

| | |
|---|---|
| **Contract** | v6 — deploying soon |
| **Network** | Ethereum Mainnet |
| **Verified source** | Sourcify + Etherscan — address published at deploy |
| **Compiler** | Solidity 0.8.25, optimizer 200 runs |

---

## What's in this repo

| File | What |
|------|------|
| `contracts/SAFUPool.sol` | On-chain pool — staking, payout stream, tier enforcement |
| `script/Deploy.s.sol` | Foundry deploy script — atomically deploys + sets cosigner |
| `foundry.toml` | Compiler settings for reproducible builds |

The oracle scoring engine is off-chain and closed source. What's on-chain is the payout execution — auditable, deterministic, immutable.

---

## Events — indexing notes

- **`PointsEarned`** is indexed by `keccak256(beneficiary)`. Hash the beneficiary address before querying logs — querying the raw address will return no results.

## Known constraints (v6)

- **`MAX_STAKERS = 50`** is an immutable constant. `setMaxPoolSize` controls the ETH cap but cannot override the staker count ceiling. Increasing the staker limit requires redeployment.

- **Stake forfeiture on claim (by design):** When `submitClaim` runs, the staker's 0.015 ETH principal is permanently forfeited — regardless of claim outcome. If the owner later determines the claim was a false positive and calls `cancelClaim`, the stake is not returned. Forfeiture is an intentional penalty mechanism, not a bug. The forfeited ETH remains in the pool as surplus.

## Compile

```bash
forge install OpenZeppelin/openzeppelin-contracts
forge build
```
