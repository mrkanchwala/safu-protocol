// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import "forge-std/Test.sol";
import "../contracts/SAFUPoolV8.sol";

contract FullSmokeMainnetFork is Test {
    SAFUPoolV8 pool = SAFUPoolV8(payable(0x5Be5B9e1Db8be4B209aD6E6982d1e69FC9a54ec0));

    address wallet      = address(0xAA01);
    address beneficiary = address(0xBB02);
    address oracleAddr  = 0x5a648f7037F32817996fc12d660425b5B9B1BdFB;
    address ownerAddr   = 0x1B91087CcD57Aa0116201419971aF5A01C04eF35;
    address coSignerAddr = 0x5b6BF225E6B1495240E04eff93a1D261c8BBBaf8;

    address staker2 = address(0xBEEF);
    address ben2    = address(0xCAFE);

    uint8   constant TIER_A = 1;
    uint256 constant STAKE_MAX_AMT = 0.75 ether;
    uint256 constant STAKE_MID     = 0.375 ether;
    uint256 constant STAKE_MIN_AMT = 0.01 ether;
    uint256 constant TEST_ENTITLEMENT = 0.05 ether;

    uint256 constant ORACLE_PK = 0xA11CE;

    function setUp() public {
        address testOracle = vm.addr(ORACLE_PK);
        vm.prank(ownerAddr);
        pool.setOracle(testOracle);
        oracleAddr = testOracle;
    }

    function _stakeWallet(address w, address ben, uint256 amount) internal {
        vm.deal(w, amount + 0.1 ether);
        vm.prank(w);
        pool.stakeETH{value: amount}(ben, true);
    }

    function _signClaim(
        address w, bytes32 txHash, uint256 entitlement,
        uint8 tier, uint256 hackTs, uint64 deadline
    ) internal view returns (bytes memory) {
        bytes32 inner = keccak256(abi.encodePacked(
            "SAFU_CLAIM_APPROVAL",
            address(pool), block.chainid,
            w, txHash, entitlement, tier, hackTs, deadline
        ));
        bytes32 ethHash = MessageHashUtils.toEthSignedMessageHash(inner);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ORACLE_PK, ethHash);
        return abi.encodePacked(r, s, v);
    }

    function _streamToCompletion(bytes32 claimId, address staker, address ben) internal {
        for (uint256 i = 0; i < 60; i++) {
            vm.warp(block.timestamp + 1 days);
            vm.prank(staker);
            try pool.claimStream(claimId, ben) {} catch { break; }
            if (pool.totalAllocated() == 0) break;
        }
    }

    // T5.1 — Stake permissionless at max/mid/min
    function test_T51_stake_permissionless() public {
        assertEq(pool.oracle(), oracleAddr);
        assertEq(pool.owner(), ownerAddr);
        assertFalse(pool.paused());
        assertEq(pool.totalStaked(), 0);

        _stakeWallet(wallet, beneficiary, STAKE_MAX_AMT);
        assertEq(pool.totalStaked(), STAKE_MAX_AMT);
        assertEq(pool.totalStakers(), 1);
        console.log("T5.1 STAKE PERMISSIONLESS: PASS");
    }

    // T5.2 — Points proportional at max stake + 90-day time gate
    function test_T52_points_proportional() public {
        _stakeWallet(wallet, beneficiary, STAKE_MAX_AMT);

        vm.warp(block.timestamp + 89 days);
        assertFalse(pool.isClaimEligible(wallet));
        assertEq(pool.pointsOf(wallet), 8900, "day 89 wrong");

        vm.warp(block.timestamp + 1 days);
        assertTrue(pool.isClaimEligible(wallet));
        assertEq(pool.pointsOf(wallet), 9000, "day 90 wrong");

        vm.warp(block.timestamp + 90 days);
        assertEq(pool.pointsOf(wallet), 19800, "day 180 wrong");

        console.log("T5.2 POINTS PROPORTIONAL: PASS");
    }

    // T5.2b — Points at min stake (proportional reduction)
    function test_T52b_points_min_stake() public {
        _stakeWallet(wallet, beneficiary, STAKE_MIN_AMT);

        vm.warp(block.timestamp + 90 days);
        uint256 pts = pool.pointsOf(wallet);
        // 90*100 * 0.01e18 / 0.75e18 = 9000 / 75 = 120
        assertEq(pts, 120, "min stake day 90 wrong");

        console.log("T5.2b POINTS MIN STAKE: PASS");
    }

    // T5.3 — Full claim lifecycle: submit → cooldown → stream → complete
    function test_T53_claim_lifecycle() public {
        _stakeWallet(wallet, beneficiary, STAKE_MAX_AMT);
        vm.warp(block.timestamp + 90 days);
        vm.deal(address(pool), 5 ether);

        bytes32 txHash = keccak256("hack-tx-1");
        uint256 hackTs = block.timestamp - 1 days;
        uint64 deadline = uint64(block.timestamp + 3600);
        bytes32 claimId = keccak256(abi.encodePacked(wallet, txHash));
        bytes memory sig = _signClaim(wallet, txHash, TEST_ENTITLEMENT, TIER_A, hackTs, deadline);

        vm.prank(oracleAddr);
        pool.submitClaim(wallet, txHash, TEST_ENTITLEMENT, TIER_A, hackTs, deadline, sig);
        assertEq(pool.totalAllocated(), TEST_ENTITLEMENT);

        vm.warp(block.timestamp + 7 days + 1);

        uint256 benBefore = beneficiary.balance;
        _streamToCompletion(claimId, wallet, beneficiary);

        assertEq(beneficiary.balance - benBefore, TEST_ENTITLEMENT);
        assertEq(pool.totalAllocated(), 0);
        console.log("T5.3 CLAIM LIFECYCLE: PASS");
    }

    // T5.4 — Immediate withdraw (no lock)
    function test_T54_withdraw_no_lock() public {
        _stakeWallet(wallet, beneficiary, STAKE_MID);
        vm.prank(wallet);
        pool.withdraw(beneficiary);

        assertEq(pool.totalStaked(), 0);
        assertEq(pool.totalStakers(), 0);
        console.log("T5.4 WITHDRAW NO LOCK: PASS");
    }

    // T5.5 — Cancel claim → 365d penalty → withdraw after expiry
    function test_T55_cancel_claim_penalty() public {
        _stakeWallet(wallet, beneficiary, STAKE_MAX_AMT);
        vm.warp(block.timestamp + 90 days);
        vm.deal(address(pool), 5 ether);

        bytes32 txHash = keccak256("false-positive-tx");
        uint256 hackTs = block.timestamp - 1 days;
        uint64 deadline = uint64(block.timestamp + 3600);
        bytes32 claimId = keccak256(abi.encodePacked(wallet, txHash));
        bytes memory sig = _signClaim(wallet, txHash, TEST_ENTITLEMENT, TIER_A, hackTs, deadline);

        vm.prank(oracleAddr);
        pool.submitClaim(wallet, txHash, TEST_ENTITLEMENT, TIER_A, hackTs, deadline, sig);

        vm.prank(ownerAddr);
        pool.cancelClaim(claimId);

        assertEq(pool.totalStaked(), STAKE_MAX_AMT);

        vm.prank(wallet);
        vm.expectRevert("SAFU: penalty lock active");
        pool.withdraw(beneficiary);

        vm.warp(block.timestamp + 365 days + 1);
        vm.prank(wallet);
        pool.withdraw(beneficiary);

        assertEq(pool.totalStaked(), 0);
        console.log("T5.5 CANCEL + PENALTY: PASS");
    }

    // T5.6 — Override 2-of-2 (V8: tier param)
    function test_T56_override_2of2() public {
        _stakeWallet(wallet, beneficiary, STAKE_MAX_AMT);
        vm.deal(address(pool), 5 ether);

        bytes32 txHash = keccak256("false-negative-tx");
        bytes32 claimId = keccak256(abi.encodePacked(wallet, txHash));

        vm.prank(ownerAddr);
        pool.approveOverride(claimId, wallet, txHash, TEST_ENTITLEMENT, TIER_A);

        vm.prank(coSignerAddr);
        pool.approveOverride(claimId, wallet, txHash, TEST_ENTITLEMENT, TIER_A);

        assertEq(pool.totalAllocated(), TEST_ENTITLEMENT);

        vm.warp(block.timestamp + 7 days + 1);
        _streamToCompletion(claimId, wallet, beneficiary);

        assertEq(pool.totalAllocated(), 0);
        console.log("T5.6 OVERRIDE 2-of-2: PASS");
    }

    // T5.7 — Pause → emergencyExit
    function test_T57_pause_emergency_exit() public {
        _stakeWallet(wallet, beneficiary, STAKE_MAX_AMT);

        vm.prank(ownerAddr);
        pool.pause();
        assertTrue(pool.paused());

        vm.prank(wallet);
        pool.emergencyExit();

        assertEq(pool.totalStaked(), 0);

        vm.prank(ownerAddr);
        pool.unpause();
        assertFalse(pool.paused());

        console.log("T5.7 PAUSE + EMERGENCY EXIT: PASS");
    }

    // T5.8 — Points banking across 2 stake cycles
    function test_T58_points_banking() public {
        vm.deal(staker2, 3 ether);

        vm.prank(staker2);
        pool.stakeETH{value: STAKE_MAX_AMT}(ben2, true);

        vm.warp(block.timestamp + 100 days);
        assertEq(pool.pointsOf(staker2), 10200);

        vm.prank(staker2);
        pool.withdraw(ben2);
        assertEq(pool.pointsOf(staker2), 10200);

        vm.prank(staker2);
        pool.stakeETH{value: STAKE_MAX_AMT}(ben2, true);

        vm.warp(block.timestamp + 100 days);
        vm.prank(staker2);
        pool.withdraw(ben2);

        assertEq(pool.pointsOf(staker2), 20400);
        console.log("T5.8 POINTS BANKING: PASS");
    }

    // T5.9 — Pending claim (day 0) → unlock after 90d time gate
    function test_T59_pending_claim_unlock() public {
        _stakeWallet(wallet, beneficiary, STAKE_MAX_AMT);
        vm.deal(address(pool), 5 ether);

        bytes32 txHash = keccak256("pending-hack");
        uint256 hackTs = block.timestamp;
        uint64 deadline = uint64(block.timestamp + 3600);
        bytes32 claimId = keccak256(abi.encodePacked(wallet, txHash));
        bytes memory sig = _signClaim(wallet, txHash, TEST_ENTITLEMENT, TIER_A, hackTs, deadline);

        vm.prank(oracleAddr);
        pool.submitClaim(wallet, txHash, TEST_ENTITLEMENT, TIER_A, hackTs, deadline, sig);

        vm.expectRevert("SAFU: too early");
        pool.unlockPendingClaim(claimId);

        vm.warp(block.timestamp + 90 days);
        pool.unlockPendingClaim(claimId);
        assertEq(pool.totalAllocated(), TEST_ENTITLEMENT);

        vm.warp(block.timestamp + 7 days + 1);
        _streamToCompletion(claimId, wallet, beneficiary);

        assertEq(pool.totalAllocated(), 0);
        console.log("T5.9 PENDING -> UNLOCK -> STREAM: PASS");
    }
}
