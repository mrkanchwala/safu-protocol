# SAFU Protocol

Verification layer for agent-to-agent value transfer.

## SAFUPool — Mainnet

| | |
|---|---|
| **Contract** | [`0x5f0a84405d485396eaA1CF53f9C21821147b9fC2`](https://etherscan.io/address/0x5f0a84405d485396eaa1cf53f9c21821147b9fc2) |
| **Network** | Ethereum Mainnet |
| **Verified** | [Etherscan](https://etherscan.io/address/0x5f0a84405d485396eaa1cf53f9c21821147b9fc2#code) |
| **Compiler** | Solidity 0.8.24, optimizer 200 runs |

## Overview

SAFUPool is an oracle-gated staking pool. Enrollment requires a signed approval from the SAFU oracle. Payouts are streamed linearly over 45 days after a 7-day cooldown. A 2%/day outflow cap applies with no exemptions.

## Compile

```bash
forge install OpenZeppelin/openzeppelin-contracts
forge build
```

## Audit

Source code matches deployed bytecode (Etherscan: Exact Match).
