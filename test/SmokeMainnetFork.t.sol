// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import "forge-std/Test.sol";
import "../contracts/SAFUPoolV7.sol";

contract FullSmokeMainnetFork is Test {
    SAFUPool pool = SAFUPool(payable(0x8ff7518ff9352F4a81d6914E8A08A47085042896));

    address wallet     = address(0xAA01);
    address beneficiary = address(0xBB02);
    address oracleAddr = 0x5a648f7037F32817996fc12d660425b5B9B1BdFB;
    address ownerAddr  = 0x1B91087CcD57Aa0116201419971aF5A01C04eF35;
    address coSignerAddr = 0x5b6BF225E6B1495240E04eff93a1D261c8BBBaf8;

    address staker2 = address(0xBEEF);
    address ben2    = address(0xCAFE);

    uint8   constant TIER_A = 1;
    uint256 constant STAKE_A = 0.25 ether;
    uint256 constant TEST_ENTITLEMENT = 0.05 ether;

    uint256 constant ORACLE_PK = 0xA11CE;

    function setUp() public {
        // Replace oracle with one we can vm.sign for
        address testOracle = vm.addr(ORACLE_PK);
        vm.prank(ownerAddr);
        pool.setOracle(testOracle);
        oracleAddr = testOracle;
    }

    function _signStake(address w, bytes32 rh) internal view returns (bytes memory) {
        bytes32 inner = keccak256(abi.encodePacked(
            "SAFU_STAKE_APPROVAL", address(pool), block.chainid, w, TIER_A, uint64(block.timestamp + 3600), rh
        ));
        bytes32 ethHash = MessageHashUtils.toEthSignedMessageHash(inner);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ORACLE_PK, ethHash);
        return abi.encodePacked(r, s, v);
    }

    function _stakeWallet() internal {
        vm.deal(wallet, 1 ether);
        bytes32 rh = keccak256("wallet-reason-1");
        bytes memory sig = _signStake(wallet, rh);
        vm.prank(wallet);
        pool.stakeETH{value: STAKE_A}(TIER_A, uint64(block.timestamp + 3600), rh, sig, beneficiary, true);
    }

    function _streamToCompletion(bytes32 claimId, address staker, address ben) internal {
        for (uint256 i = 0; i < 60; i++) {
            vm.warp(block.timestamp + 1 days);
            vm.prank(staker);
            try pool.claimStream(claimId, ben) {} catch { break; }
            if (pool.totalAllocated() == 0) break;
        }
    }

    function _oracleSignForStaker2() internal view returns (bytes32 rh, bytes memory s2) {
        rh = keccak256("staker2-reason");
        s2 = _signStake(staker2, rh);
    }

    // ==========================================
    // T5.1 - Stake + verify on-chain state
    // ==========================================
    function test_T51_stake() public {
        assertEq(pool.oracle(), oracleAddr, "oracle mismatch");
        assertEq(pool.owner(), ownerAddr, "owner mismatch");
        assertFalse(pool.paused(), "paused at start");
        assertEq(pool.totalStaked(), 0, "pool not empty");

        _stakeWallet();

        assertEq(pool.totalStaked(), STAKE_A);
        assertEq(pool.totalStakers(), 1);
        assertEq(pool.pointsOf(wallet), 0);
        console.log("T5.1 STAKE: PASS");
    }

    // ==========================================
    // T5.2 - Points accumulation + brackets
    // ==========================================
    function test_T52_points() public {
        _stakeWallet();

        vm.warp(block.timestamp + 89 days);
        assertFalse(pool.isClaimEligible(wallet), "eligible too early");
        uint256 pts89 = pool.pointsOf(wallet);
        assertEq(pts89, 89 * 100, "day 89 points wrong");

        vm.warp(block.timestamp + 1 days); // day 90
        assertTrue(pool.isClaimEligible(wallet), "not eligible at day 90");
        uint256 pts90 = pool.pointsOf(wallet);
        assertEq(pts90, 90 * 100, "day 90 points wrong - 9000");

        vm.warp(block.timestamp + 90 days); // day 180
        uint256 pts180 = pool.pointsOf(wallet);
        // 90*100 + 90*120 = 9000 + 10800 = 19800
        assertEq(pts180, 19800, "day 180 points wrong");

        console.log("T5.2 POINTS: PASS - 0/89d/90d/180d brackets verified");
    }

    // ==========================================
    // T5.3 - Full claim lifecycle: submit -> cooldown -> stream -> complete
    // ==========================================
    function test_T53_claim_lifecycle() public {
        _stakeWallet();
        vm.warp(block.timestamp + 90 days);
        vm.deal(address(pool), 5 ether); // fund pool for claim payout

        bytes32 txHash = keccak256("hack-tx-1");
        uint256 hackTs = block.timestamp - 1 days;
        bytes32 claimId = keccak256(abi.encodePacked(wallet, txHash));

        // Submit claim
        vm.prank(oracleAddr);
        pool.submitClaim(wallet, txHash, TEST_ENTITLEMENT, hackTs);
        assertEq(pool.totalAllocated(), TEST_ENTITLEMENT, "totalAllocated wrong");
        console.log("Claim submitted, entitlement:", TEST_ENTITLEMENT);

        // Points burned: 9000 burned, remainder banked
        uint256 banked = pool.pointsOf(wallet);
        console.log("Points banked after burn:", banked);
        // 90*100 = 9000, burned 9000, remainder = 0
        assertEq(banked, 0, "points remainder wrong");

        // Cooldown (7 days)
        vm.warp(block.timestamp + 7 days + 1);

        // Stream to completion (daily cap = 2%/day, needs multiple days)
        uint256 benBefore = beneficiary.balance;
        _streamToCompletion(claimId, wallet, beneficiary);

        uint256 totalPaid = beneficiary.balance - benBefore;
        assertEq(totalPaid, TEST_ENTITLEMENT, "total paid != entitlement");
        assertEq(pool.totalAllocated(), 0, "totalAllocated not zero");
        console.log("T5.3 CLAIM LIFECYCLE: PASS - total paid:", totalPaid);
    }

    // ==========================================
    // T5.4 - Immediate withdraw (no lock in v7)
    // ==========================================
    function test_T54_withdraw_no_lock() public {
        _stakeWallet();
        // Withdraw immediately - no lock period in v7
        vm.prank(wallet);
        pool.withdraw(beneficiary);

        assertEq(pool.totalStaked(), 0);
        assertEq(pool.totalStakers(), 0);
        uint256 banked = pool.pointsOf(wallet);
        assertEq(banked, 0, "points at day 0 after withdraw");
        console.log("T5.4 WITHDRAW NO LOCK: PASS");
    }

    // ==========================================
    // T5.5 - Cancel claim (false positive) -> penalty lock -> withdraw after 365d
    // ==========================================
    function test_T55_cancel_claim_penalty() public {
        _stakeWallet();
        vm.warp(block.timestamp + 90 days);
        vm.deal(address(pool), 5 ether);

        bytes32 txHash = keccak256("false-positive-tx");
        uint256 hackTs = block.timestamp - 1 days;
        bytes32 claimId = keccak256(abi.encodePacked(wallet, txHash));

        vm.prank(oracleAddr);
        pool.submitClaim(wallet, txHash, TEST_ENTITLEMENT, hackTs);

        // Owner cancels (false positive)
        vm.prank(ownerAddr);
        pool.cancelClaim(claimId);

        // Stake restored but penalty locked
        assertEq(pool.totalStaked(), STAKE_A, "stake not restored after cancel");
        assertEq(pool.totalStakers(), 1, "stakers not restored");

        // Withdraw blocked by penalty
        vm.prank(wallet);
        vm.expectRevert("SAFU: penalty lock active");
        pool.withdraw(beneficiary);

        // Warp past 365-day penalty
        vm.warp(block.timestamp + 365 days + 1);
        vm.prank(wallet);
        pool.withdraw(beneficiary);

        assertEq(pool.totalStaked(), 0);
        console.log("T5.5 CANCEL + PENALTY: PASS - 365d lock enforced, withdraw after expiry");
    }

    // ==========================================
    // T5.6 - Override (2-of-2: owner + coSigner)
    // ==========================================
    function test_T56_override_2of2() public {
        _stakeWallet();
        vm.deal(address(pool), 5 ether);

        bytes32 txHash = keccak256("false-negative-tx");
        bytes32 claimId = keccak256(abi.encodePacked(wallet, txHash));
        uint256 entitlement = 0.05 ether;

        // Owner approves
        vm.prank(ownerAddr);
        pool.approveOverride(claimId, wallet, txHash, entitlement);

        // CoSigner approves - triggers execution
        vm.prank(coSignerAddr);
        pool.approveOverride(claimId, wallet, txHash, entitlement);

        assertEq(pool.totalAllocated(), entitlement, "override not applied");

        // Stream to completion
        vm.warp(block.timestamp + 7 days + 1);
        _streamToCompletion(claimId, wallet, beneficiary);

        assertEq(pool.totalAllocated(), 0);
        console.log("T5.6 OVERRIDE 2-of-2: PASS - owner + coSigner -> payout complete");
    }

    // ==========================================
    // T5.7 - Pause -> emergencyExit (wstETH return)
    // ==========================================
    function test_T57_pause_emergency_exit() public {
        _stakeWallet();

        // Pause
        vm.prank(ownerAddr);
        pool.pause();
        assertTrue(pool.paused());

        // Staker calls emergencyExit - gets wstETH directly
        vm.prank(wallet);
        pool.emergencyExit();

        assertEq(pool.totalStaked(), 0);
        assertEq(pool.totalStakers(), 0);

        // Unpause
        vm.prank(ownerAddr);
        pool.unpause();
        assertFalse(pool.paused());

        console.log("T5.7 PAUSE + EMERGENCY EXIT: PASS");
    }

    // ==========================================
    // T5.8 - Points banking across stake cycles
    // ==========================================
    function test_T58_points_banking() public {
        // Use staker2 with a test oracle we control
        (bytes32 rh, bytes memory s2) = _oracleSignForStaker2();
        vm.deal(staker2, 2 ether);

        // Cycle 1: stake 100 days -> withdraw -> bank points
        vm.prank(staker2);
        pool.stakeETH{value: STAKE_A}(TIER_A, uint64(block.timestamp + 3600), rh, s2, ben2, true);

        vm.warp(block.timestamp + 100 days);
        uint256 ptsCycle1 = pool.pointsOf(staker2);
        // 90*100 + 10*120 = 9000 + 1200 = 10200
        assertEq(ptsCycle1, 10200, "cycle 1 points wrong");

        vm.prank(staker2);
        pool.withdraw(ben2);
        uint256 bankedAfterC1 = pool.pointsOf(staker2);
        assertEq(bankedAfterC1, 10200, "banked after cycle 1 wrong");

        // Cycle 2: re-stake 100 days -> withdraw -> accumulate
        bytes32 rh2 = keccak256("staker2-reason-2");
        bytes memory s2b = _signStake(staker2, rh2);

        vm.prank(staker2);
        pool.stakeETH{value: STAKE_A}(TIER_A, uint64(block.timestamp + 3600), rh2, s2b, ben2, true);

        vm.warp(block.timestamp + 100 days);
        vm.prank(staker2);
        pool.withdraw(ben2);

        uint256 bankedAfterC2 = pool.pointsOf(staker2);
        assertEq(bankedAfterC2, 10200 + 10200, "banked after cycle 2 wrong - should accumulate");
        console.log("T5.8 POINTS BANKING: PASS - 2 cycles, accumulated:", bankedAfterC2);
    }

    // ==========================================
    // T5.9 - Pending claim (insufficient points) -> unlock later
    // ==========================================
    function test_T59_pending_claim_unlock() public {
        _stakeWallet();
        vm.deal(address(pool), 5 ether);

        // At day 0: submit claim -> should go to pending (status=5)
        bytes32 txHash = keccak256("pending-hack");
        uint256 hackTs = block.timestamp;
        bytes32 claimId = keccak256(abi.encodePacked(wallet, txHash));

        vm.prank(oracleAddr);
        pool.submitClaim(wallet, txHash, TEST_ENTITLEMENT, hackTs);
        // Points < 9000 at day 0 -> pending

        // Can't unlock yet
        vm.expectRevert("SAFU: insufficient points");
        pool.unlockPendingClaim(claimId);

        // Warp to 90 days -> 9000 points
        vm.warp(block.timestamp + 90 days);

        // Anyone can unlock
        pool.unlockPendingClaim(claimId);
        assertEq(pool.totalAllocated(), TEST_ENTITLEMENT);

        // Stream to completion
        vm.warp(block.timestamp + 7 days + 1);
        _streamToCompletion(claimId, wallet, beneficiary);

        assertEq(pool.totalAllocated(), 0);
        console.log("T5.9 PENDING -> UNLOCK -> STREAM: PASS");
    }
}
