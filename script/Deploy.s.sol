// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import "forge-std/Script.sol";
import "../contracts/SAFUPool.sol";

/**
 * SAFUPool deploy script — IBW mainnet.
 *
 * Deploys SAFUPool and immediately calls setCoSigner() in the same broadcast.
 * This guarantees the 2-of-2 override key is never left as owner (H0 gate).
 *
 * Required env vars (set before running):
 *   DEPLOY_ORACLE      — oracle address (derives from SAFU_ORACLE_KEY on VPS)
 *   DEPLOY_COSIGNER    — second hardware wallet address (separate from owner)
 *   DEPLOY_MAX_POOL    — pool ETH cap in wei (IBW: 750000000000000000 = 0.75 ETH)
 *   DEPLOYER_PK        — deployer private key (becomes owner)
 *
 * Recommended wallet assignments (IBW):
 *   Owner (deployer):  0x1B91087CcD57Aa0116201419971aF5A01C04eF35
 *   CoSigner:          0x5b6BF225E6B1495240E04eff93a1D261c8BBBaf8
 *   Oracle:            derived from SAFU_ORACLE_KEY on VPS — run `oracle_address()` first
 *
 * Run (dry-run, no broadcast):
 *   forge script script/Deploy.s.sol --rpc-url $RPC_URL \
 *     --sig "run()" -vvvv
 *
 * Run (mainnet broadcast):
 *   forge script script/Deploy.s.sol --rpc-url $RPC_URL \
 *     --broadcast --verify --etherscan-api-key $ETHERSCAN_API_KEY \
 *     --sig "run()" -vvvv
 */
contract DeployScript is Script {

    function run() external {
        address oracle_    = vm.envAddress("DEPLOY_ORACLE");
        address coSigner_  = vm.envAddress("DEPLOY_COSIGNER");
        uint256 maxPool_   = vm.envUint("DEPLOY_MAX_POOL");
        uint256 deployerPk = vm.envUint("DEPLOYER_PK");

        address deployer = vm.addr(deployerPk);

        console.log("=== SAFUPool IBW Deploy ===");
        console.log("Deployer (owner):", deployer);
        console.log("Oracle:          ", oracle_);
        console.log("CoSigner:        ", coSigner_);
        console.log("Max pool (wei):  ", maxPool_);

        require(oracle_   != address(0), "DEPLOY_ORACLE not set");
        require(coSigner_ != address(0), "DEPLOY_COSIGNER not set");
        require(coSigner_ != deployer,   "coSigner must differ from owner: use second hardware wallet");
        require(maxPool_  > 0,           "DEPLOY_MAX_POOL not set");

        vm.startBroadcast(deployerPk);

        // v6: coSigner passed directly to constructor — 2-of-2 active from block 0
        SAFUPool pool = new SAFUPool(oracle_, coSigner_, maxPool_);
        console.log("SAFUPool deployed:", address(pool));
        console.log("CoSigner active from deploy: 2-of-2 live");

        vm.stopBroadcast();

        console.log("=== Deploy complete ===");
        console.log("Verify: https://etherscan.io/address/", address(pool));
        console.log("Next: point SAFU_ORACLE_KEY env var to oracle key, restart API, run smoke test");
    }
}
