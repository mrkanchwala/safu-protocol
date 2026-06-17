# SAFU Pool v7 — Oracle & Ops Runbook

Operator-facing runbook for the SAFUPoolV7 owner/oracle. Covers the two ops-layer
risks flagged in the 2026-06-13 / 2026-06-17 CIE reviews that have no on-chain fix:
the Curve single-path dependency (M2) and oracle key handling (M1).

---

## M2 — Curve stETH/ETH single-path failure

**Risk:** `_unwrapToEth()` swaps stETH→ETH through one Curve pool
(`CURVE_POOL 0xDC24316b9AE028F1497c275EB9192a3Ea0f67022`). If that pool is drained,
depegged, or paused, yield extraction and withdrawals that need ETH liquidity revert.

**Detection / alert triggers:**
- Curve stETH/ETH pool TVL drops below ~$10M
- `get_dy` slippage on a 1 stETH quote exceeds 3%
- Any `extractYield` / withdrawal tx reverts inside `_unwrapToEth`

**Response sequence (owner):**
1. **Widen slippage tolerance.** Call `setSlippage(500)` — 5% max (contract caps here).
2. **If swaps still revert:** call `pause()`. This halts staking/claims but does NOT
   block `emergencyExit()`.
3. **Tell stakers to use `emergencyExit()`.** This returns wstETH directly to the staker —
   no Lido unwrap, no Curve swap, no ETH path. Stakers hold liquid wstETH and can exit
   via any venue at their discretion.
4. **Owner-side stETH exit (if pool funds are stranded as stETH):** route stETH→ETH
   through 1inch aggregator or the Uniswap v3 stETH/ETH pool instead of Curve. Curve is
   not the only venue — it is only the contract's default path.
5. Once Curve normalizes (TVL recovered, slippage < 1%), call `unpause()` and reset
   slippage to the normal floor.

**Monitoring:**
- Pool: `CURVE_POOL 0xDC24316b9AE028F1497c275EB9192a3Ea0f67022`
- stETH: `0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84`
- wstETH: `0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0`

---

## M1 — Oracle signing key

**Current state (IBW demo scale):**
- Key is off-disk: `/etc/safu/oracle.key` removed.
- Key supplied to the API via the `SAFU_ORACLE_KEY` env var in `~/safu-verify/.env`.
- Single-signer EOA. Acceptable at demo scale; NOT production-grade.

**Production hardening (post-deploy, before real funds):**
- Move signing to AWS KMS / HashiCorp Vault, or a dedicated isolated signing process
  with an IP allowlist. The contract's 2-of-2 coSigner override already provides a
  second-factor for the high-value path; the oracle EOA is the lower-value daily path.
- **Rotate the oracle key immediately after mainnet deploy** (the demo key has been on
  a shared VPS). Update `setOracle(newAddr)` on-chain and the env var in lockstep.

**Verification (run before each demo / deploy):**
```bash
# Confirm config reads the raw env var, not a stale file path
ssh root@46.225.110.140 "grep -n 'SAFU_ORACLE_KEY' ~/safu-verify/api/config.py"
# Confirm the key env var is present
ssh root@46.225.110.140 "grep -c 'SAFU_ORACLE_KEY' ~/safu-verify/.env"
```

---

## M3 — RPC provider fallback

See the CIE review (`outputs/2026-06-17_cie-review-safupoolv7-final.md`). The fix is a
~10-line change on the VPS `safu-verify` service: add `INFURA_RPC_URL` to `.env` and
`config.py`, and have `scanner_wrapper.score_transaction` retry on the fallback URL when
the primary Alchemy endpoint raises a connection error. This is VPS-resident code and
must be applied there, then `pm2 reload` (or service restart).
