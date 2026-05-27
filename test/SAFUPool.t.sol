// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import "forge-std/Test.sol";
import "../contracts/SAFUPool.sol";

/**
 * SAFUPool v6 — Forge test suite.
 *
 * Coverage:
 *   - Constructor param validation
 *   - stakeETH: happy path, expired deadline, revoked approval, double-stake, wrong amount, bad sig
 *   - L1: reasonHash auto-revoked after stake (replay blocked)
 *   - withdraw: after lock, during lock, claim active, wrong beneficiary
 *   - setBeneficiary: I2 — blocked when paused
 *   - releaseExpiredSlot: L3 — blocked on suspended wallet
 *   - submitClaim: oracle, owner, C2 rate-limit, owner bypasses, daily reset
 *   - claimStream: H3 totalStaked decrement, M6 pause gate, M4 failedPayouts
 *   - rescueFailedPayout: M4 — owner recovers stuck ETH
 *   - cancelClaim: F1 — status/principal restored
 *   - approveOverride: 2-of-2, M5 claimId validation, M1 completed-claim block
 *   - emergencyWithdraw: C1 — surplus only, no surplus reverts
 */
contract SAFUPoolTest is Test {

    SAFUPool pool;

    // Fixed private keys for deterministic sigs
    uint256 constant ORACLE_PK   = 0xA11CE;
    uint256 constant COSIGNER_PK = 0xB0B0B;
    uint256 constant STAKER1_PK  = 0xCAFE1;
    uint256 constant STAKER2_PK  = 0xCAFE2;

    address oracle;
    address coSigner;
    address staker1;
    address staker2;
    address beneficiary;

    uint256 constant MAX_POOL  = 0.75 ether;
    uint256 constant STAKE_AMT = 0.015 ether;

    // ─────────────────────────────────────────────────────────────────────────
    // Setup
    // ─────────────────────────────────────────────────────────────────────────

    function setUp() public {
        oracle      = vm.addr(ORACLE_PK);
        coSigner    = vm.addr(COSIGNER_PK);
        staker1     = vm.addr(STAKER1_PK);
        staker2     = vm.addr(STAKER2_PK);
        beneficiary = makeAddr("beneficiary");

        pool = new SAFUPool(oracle, coSigner, MAX_POOL);
        vm.deal(staker1, 10 ether);
        vm.deal(staker2, 10 ether);
    }

    // Test contract is the owner — must be able to receive ETH from rescue/emergency calls
    receive() external payable {}

    // ─────────────────────────────────────────────────────────────────────────
    // Helpers
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev Build oracle stake approval signature
    function _stakeSig(
        address wallet,
        uint8   tier,
        uint64  deadline,
        bytes32 reason
    ) internal view returns (bytes memory) {
        bytes32 inner = keccak256(abi.encodePacked(
            "SAFU_STAKE_APPROVAL",
            address(pool),
            block.chainid,
            wallet,
            tier,
            deadline,
            reason
        ));
        bytes32 eth = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", inner));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ORACLE_PK, eth);
        return abi.encodePacked(r, s, v);
    }

    /// @dev Stake wallet with given tier/reason/beneficiary
    function _stake(address wallet, uint8 tier, bytes32 reason, address ben) internal {
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes memory sig = _stakeSig(wallet, tier, deadline, reason);
        vm.prank(wallet);
        pool.stakeETH{value: STAKE_AMT}(tier, deadline, reason, sig, ben);
    }

    /// @dev Compute claimId
    function _claimId(address wallet, bytes32 txHash) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(wallet, txHash));
    }

    /// @dev Get claim status from public mapping
    function _claimStatus(bytes32 id) internal view returns (uint8 status) {
        (,,,,,,, status) = pool.claims(id);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Constructor
    // ─────────────────────────────────────────────────────────────────────────

    function test_constructor_params() public view {
        assertEq(pool.oracle(),      oracle);
        assertEq(pool.coSigner(),    coSigner);
        assertEq(pool.maxPoolSize(), MAX_POOL);
        assertEq(pool.owner(),       address(this));
    }

    function test_constructor_zeroOracle() public {
        vm.expectRevert("zero oracle");
        new SAFUPool(address(0), coSigner, MAX_POOL);
    }

    function test_constructor_zeroCoSigner() public {
        vm.expectRevert("zero coSigner");
        new SAFUPool(oracle, address(0), MAX_POOL);
    }

    function test_constructor_coSignerEqOwner() public {
        vm.expectRevert("coSigner must differ from owner");
        new SAFUPool(oracle, address(this), MAX_POOL);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // stakeETH
    // ─────────────────────────────────────────────────────────────────────────

    function test_stake_success() public {
        _stake(staker1, 1, keccak256("r1"), beneficiary);

        SAFUPool.StakeRecord memory s = pool.stakeOf(staker1);
        assertEq(s.amount, STAKE_AMT);
        assertEq(s.tier,   1);
        assertFalse(s.withdrawn);
        assertFalse(s.suspended);
        assertFalse(s.claimActive);
        assertEq(pool.totalStakers(), 1);
        assertEq(pool.totalStaked(),  STAKE_AMT);
    }

    function test_stake_expiredDeadline() public {
        uint64 deadline = uint64(block.timestamp - 1);
        bytes memory sig = _stakeSig(staker1, 1, deadline, keccak256("r"));
        vm.prank(staker1);
        vm.expectRevert("approval expired");
        pool.stakeETH{value: STAKE_AMT}(1, deadline, keccak256("r"), sig, beneficiary);
    }

    function test_stake_revokedApproval() public {
        bytes32 reason = keccak256("revoke_me");
        pool.revokeApproval(reason);

        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes memory sig = _stakeSig(staker1, 1, deadline, reason);
        vm.prank(staker1);
        vm.expectRevert("approval revoked");
        pool.stakeETH{value: STAKE_AMT}(1, deadline, reason, sig, beneficiary);
    }

    function test_stake_doubleStake() public {
        _stake(staker1, 1, keccak256("r1"), beneficiary);

        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes32 reason2 = keccak256("r2");
        bytes memory sig = _stakeSig(staker1, 1, deadline, reason2);
        vm.prank(staker1);
        vm.expectRevert("already staked");
        pool.stakeETH{value: STAKE_AMT}(1, deadline, reason2, sig, beneficiary);
    }

    function test_stake_wrongAmount() public {
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes32 reason = keccak256("r");
        bytes memory sig = _stakeSig(staker1, 1, deadline, reason);
        vm.prank(staker1);
        vm.expectRevert("wrong stake amount");
        pool.stakeETH{value: 0.01 ether}(1, deadline, reason, sig, beneficiary);
    }

    function test_stake_invalidSig() public {
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes32 reason  = keccak256("r");

        // Sign with staker's key instead of oracle key
        bytes32 inner = keccak256(abi.encodePacked(
            "SAFU_STAKE_APPROVAL", address(pool), block.chainid,
            staker1, uint8(1), deadline, reason
        ));
        bytes32 eth = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", inner));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(STAKER1_PK, eth);

        vm.prank(staker1);
        vm.expectRevert("invalid oracle sig");
        pool.stakeETH{value: STAKE_AMT}(1, deadline, reason, abi.encodePacked(r, s, v), beneficiary);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // L1 — reasonHash auto-revoked after stake
    // ─────────────────────────────────────────────────────────────────────────

    function test_L1_reasonHashRevokedAfterStake() public {
        bytes32 reason = keccak256("r1");
        _stake(staker1, 1, reason, beneficiary);
        assertTrue(pool.revokedApprovals(reason), "L1: reasonHash must be revoked after stake");
    }

    function test_L1_replayBlockedAfterWithdraw() public {
        bytes32 reason = keccak256("r1");
        _stake(staker1, 1, reason, beneficiary);

        vm.warp(block.timestamp + 91 days);
        vm.prank(staker1);
        pool.withdraw(beneficiary);

        // Try to re-stake with the same reasonHash — must fail
        uint64 deadline2 = uint64(block.timestamp + 1 hours);
        bytes memory sig2 = _stakeSig(staker1, 1, deadline2, reason);
        vm.prank(staker1);
        vm.expectRevert("approval revoked");
        pool.stakeETH{value: STAKE_AMT}(1, deadline2, reason, sig2, beneficiary);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // withdraw
    // ─────────────────────────────────────────────────────────────────────────

    function test_withdraw_afterLock() public {
        _stake(staker1, 1, keccak256("r1"), beneficiary);
        vm.warp(block.timestamp + 91 days);

        uint256 before = staker1.balance;
        vm.prank(staker1);
        pool.withdraw(beneficiary);

        assertEq(staker1.balance - before, STAKE_AMT);
        assertEq(pool.totalStaked(), 0);
        assertEq(pool.totalStakers(), 0);
    }

    function test_withdraw_duringLock() public {
        _stake(staker1, 1, keccak256("r1"), beneficiary);
        vm.prank(staker1);
        vm.expectRevert("lock period active");
        pool.withdraw(beneficiary);
    }

    function test_withdraw_claimActive() public {
        _stake(staker1, 1, keccak256("r1"), beneficiary);
        pool.submitClaim(staker1, keccak256("tx1"), 0.1 ether);
        // submitClaim sets withdrawn = true (stake forfeited) — that gates withdraw first
        vm.warp(block.timestamp + 91 days);
        vm.prank(staker1);
        vm.expectRevert("already withdrawn");
        pool.withdraw(beneficiary);
    }

    function test_withdraw_wrongBeneficiary() public {
        _stake(staker1, 1, keccak256("r1"), beneficiary);
        vm.warp(block.timestamp + 91 days);
        vm.prank(staker1);
        vm.expectRevert("wrong beneficiary");
        pool.withdraw(makeAddr("wrongBen"));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // setBeneficiary — I2
    // ─────────────────────────────────────────────────────────────────────────

    function test_setBeneficiary_works() public {
        _stake(staker1, 1, keccak256("r1"), beneficiary);
        address newBen = makeAddr("newBen");

        vm.prank(staker1);
        pool.setBeneficiary(newBen);

        SAFUPool.StakeRecord memory s = pool.stakeOf(staker1);
        assertEq(s.beneficiaryHash, keccak256(abi.encodePacked(newBen)));
    }

    function test_setBeneficiary_I2_blockedWhenPaused() public {
        _stake(staker1, 1, keccak256("r1"), beneficiary);
        pool.pause();

        vm.prank(staker1);
        vm.expectRevert();  // OZ v5: EnforcedPause()
        pool.setBeneficiary(makeAddr("newBen"));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // releaseExpiredSlot — L3
    // ─────────────────────────────────────────────────────────────────────────

    function test_releaseExpiredSlot_success() public {
        _stake(staker1, 1, keccak256("r1"), beneficiary);
        vm.warp(block.timestamp + 91 days);

        pool.releaseExpiredSlot(staker1);
        assertEq(pool.totalStakers(), 0);

        SAFUPool.StakeRecord memory s = pool.stakeOf(staker1);
        assertTrue(s.slotReleased);
    }

    function test_releaseExpiredSlot_L3_blockedSuspended() public {
        _stake(staker1, 1, keccak256("r1"), beneficiary);
        pool.suspendStake(staker1);
        vm.warp(block.timestamp + 91 days);

        vm.expectRevert("wallet suspended");
        pool.releaseExpiredSlot(staker1);
    }

    function test_releaseExpiredSlot_lockedStill() public {
        _stake(staker1, 1, keccak256("r1"), beneficiary);
        vm.expectRevert("lock still active");
        pool.releaseExpiredSlot(staker1);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // submitClaim — C2 rate limit
    // ─────────────────────────────────────────────────────────────────────────

    function test_submitClaim_byOracle() public {
        _stake(staker1, 1, keccak256("r1"), beneficiary);
        vm.prank(oracle);
        pool.submitClaim(staker1, keccak256("tx1"), 0.1 ether);
        assertEq(_claimStatus(_claimId(staker1, keccak256("tx1"))), 1);
    }

    function test_submitClaim_byOwner() public {
        _stake(staker1, 1, keccak256("r1"), beneficiary);
        pool.submitClaim(staker1, keccak256("tx1"), 0.1 ether);
        assertEq(_claimStatus(_claimId(staker1, keccak256("tx1"))), 1);
    }

    function test_C2_oracleRateLimit() public {
        // Rate limit = MAX_STAKERS * 200 / 10_000 = 1 claim/day
        _stake(staker1, 1, keccak256("r1"), beneficiary);
        _stake(staker2, 1, keccak256("r2"), beneficiary);

        vm.prank(oracle);
        pool.submitClaim(staker1, keccak256("tx1"), 0.1 ether);  // first — OK

        vm.prank(oracle);
        vm.expectRevert("oracle daily claim limit reached");
        pool.submitClaim(staker2, keccak256("tx2"), 0.1 ether);  // second — blocked
    }

    function test_C2_ownerBypassesRateLimit() public {
        _stake(staker1, 1, keccak256("r1"), beneficiary);
        _stake(staker2, 1, keccak256("r2"), beneficiary);

        vm.prank(oracle);
        pool.submitClaim(staker1, keccak256("tx1"), 0.1 ether);  // oracle used its limit

        // Owner submits second claim same day — must succeed
        pool.submitClaim(staker2, keccak256("tx2"), 0.1 ether);
        assertEq(_claimStatus(_claimId(staker2, keccak256("tx2"))), 1);
    }

    function test_C2_limitResetsNextDay() public {
        _stake(staker1, 1, keccak256("r1"), beneficiary);
        _stake(staker2, 1, keccak256("r2"), beneficiary);

        vm.prank(oracle);
        pool.submitClaim(staker1, keccak256("tx1"), 0.1 ether);

        vm.warp(block.timestamp + 1 days + 1);  // new day

        vm.prank(oracle);
        pool.submitClaim(staker2, keccak256("tx2"), 0.1 ether);  // should succeed
        assertEq(_claimStatus(_claimId(staker2, keccak256("tx2"))), 1);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // claimStream — H3, M6, M4
    // ─────────────────────────────────────────────────────────────────────────

    /// H3: totalStaked decremented when claim completes
    /// Use 1 wei entitlement so it completes in a single call (fits below daily outflow cap)
    function test_H3_totalStakedDecremented() public {
        _stake(staker1, 1, keccak256("r1"), beneficiary);

        // 1 wei entitlement — completes in one stream call after full vesting
        pool.submitClaim(staker1, keccak256("tx_h3"), 1 wei);
        bytes32 cId = _claimId(staker1, keccak256("tx_h3"));

        assertEq(pool.totalStaked(), STAKE_AMT, "totalStaked should be STAKE_AMT before completion");

        // Warp past cooldown (7d) + full vesting (45d) so entire entitlement is claimable
        vm.warp(block.timestamp + 52 days + 1);

        vm.prank(staker1);
        pool.claimStream(cId, beneficiary);

        assertEq(_claimStatus(cId), 2,  "claim must be completed");
        assertEq(pool.totalStaked(), 0, "H3: totalStaked must be 0 after completion");
    }

    /// M6: claimStream blocked when paused
    function test_M6_claimStreamBlockedWhenPaused() public {
        _stake(staker1, 1, keccak256("r1"), beneficiary);
        pool.submitClaim(staker1, keccak256("tx_m6"), 0.1 ether);
        bytes32 cId = _claimId(staker1, keccak256("tx_m6"));

        vm.warp(block.timestamp + 8 days);  // past cooldown
        pool.pause();

        vm.prank(staker1);
        vm.expectRevert();  // EnforcedPause
        pool.claimStream(cId, beneficiary);
    }

    /// M4: failed ETH transfer stored in failedPayouts (not silently lost)
    function test_M4_failedPayoutStored() public {
        RevertingReceiver rr = new RevertingReceiver();

        // Stake with reverting contract as beneficiary
        _stake(staker1, 1, keccak256("r1"), address(rr));
        pool.submitClaim(staker1, keccak256("tx_m4"), 1 wei);
        bytes32 cId = _claimId(staker1, keccak256("tx_m4"));

        vm.warp(block.timestamp + 52 days + 1);

        vm.prank(staker1);
        pool.claimStream(cId, address(rr));  // transfer fails, should not revert

        assertGt(pool.failedPayouts(address(rr)), 0, "M4: ETH must be in failedPayouts, not lost");
    }

    /// M4: rescueFailedPayout sends stuck ETH to owner
    function test_M4_rescueFailedPayout() public {
        RevertingReceiver rr = new RevertingReceiver();
        _stake(staker1, 1, keccak256("r1"), address(rr));
        pool.submitClaim(staker1, keccak256("tx_m4r"), 1 wei);
        bytes32 cId = _claimId(staker1, keccak256("tx_m4r"));

        vm.warp(block.timestamp + 52 days + 1);
        vm.prank(staker1);
        pool.claimStream(cId, address(rr));

        uint256 stuck       = pool.failedPayouts(address(rr));
        uint256 ownerBefore = address(this).balance;

        pool.rescueFailedPayout(address(rr));

        assertEq(pool.failedPayouts(address(rr)), 0,              "M4: failedPayouts must be cleared");
        assertEq(address(this).balance - ownerBefore, stuck,       "M4: owner must receive rescued ETH");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // cancelClaim — F1
    // ─────────────────────────────────────────────────────────────────────────

    function test_cancelClaim_success() public {
        _stake(staker1, 1, keccak256("r1"), beneficiary);
        pool.submitClaim(staker1, keccak256("tx1"), 0.1 ether);
        bytes32 cId = _claimId(staker1, keccak256("tx1"));

        uint256 balBefore = address(pool).balance;

        pool.cancelClaim(cId);

        assertEq(_claimStatus(cId), 3, "F1: status must be cancelled (3)");
        SAFUPool.StakeRecord memory s = pool.stakeOf(staker1);
        assertTrue(s.withdrawn,          "F1: withdrawn must be true (set by submitClaim, permanent forfeiture)");
        assertEq(s.amount, 0,            "F1: amount must be zeroed after cancel");
        assertFalse(s.claimActive,       "F1: claimActive must be false after cancel");
        assertEq(address(pool).balance, balBefore, "F1: pool must retain principal (forfeited)");
    }

    function test_cancelClaim_onlyOwner() public {
        _stake(staker1, 1, keccak256("r1"), beneficiary);
        pool.submitClaim(staker1, keccak256("tx1"), 0.1 ether);
        bytes32 cId = _claimId(staker1, keccak256("tx1"));

        vm.prank(staker1);
        vm.expectRevert();  // OwnableUnauthorizedAccount
        pool.cancelClaim(cId);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // approveOverride — M1, M5
    // ─────────────────────────────────────────────────────────────────────────

    function test_approveOverride_twoOf2_executes() public {
        _stake(staker1, 1, keccak256("r1"), beneficiary);
        bytes32 txHash = keccak256("ov_tx");
        bytes32 cId    = _claimId(staker1, txHash);
        uint256 ent    = 0.1 ether;

        pool.approveOverride(cId, staker1, txHash, ent);      // owner
        vm.prank(coSigner);
        pool.approveOverride(cId, staker1, txHash, ent);      // coSigner → executes

        assertEq(_claimStatus(cId), 1, "override claim must be active (1)");
    }

    function test_approveOverride_M5_claimIdMismatch() public {
        _stake(staker1, 1, keccak256("r1"), beneficiary);
        bytes32 txHash = keccak256("tx");
        bytes32 badId  = keccak256("anything_else");

        vm.expectRevert("claimId mismatch");
        pool.approveOverride(badId, staker1, txHash, 0.1 ether);
    }

    /// M1: completed claim cannot be overridden (double-payout blocked)
    /// After claimStream completes, stakes[wallet].amount = 0 (H3) — any override
    /// attempt fails at "wallet not staked" which is the outermost gate.
    /// M1's status!=2 check provides additional defense-in-depth.
    function test_M1_completedClaimCannotBeOverridden() public {
        _stake(staker1, 1, keccak256("r1"), beneficiary);
        bytes32 txHash = keccak256("tx_m1");
        bytes32 cId    = _claimId(staker1, txHash);

        pool.submitClaim(staker1, txHash, 1 wei);              // 1 wei — completes in one call
        vm.warp(block.timestamp + 52 days + 1);
        vm.prank(staker1);
        pool.claimStream(cId, beneficiary);

        assertEq(_claimStatus(cId), 2, "claim must be completed before M1 test");

        // Any override attempt on a completed claim must revert
        vm.expectRevert();
        pool.approveOverride(cId, staker1, txHash, 1 wei);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // emergencyWithdraw — C1
    // ─────────────────────────────────────────────────────────────────────────

    /// C1: only surplus (balance - totalStaked) withdrawn; staked principal protected
    function test_C1_surplusOnlyWithdrawn() public {
        _stake(staker1, 1, keccak256("r1"), beneficiary);
        // totalStaked = STAKE_AMT; balance = STAKE_AMT

        // Inject surplus (simulates selfdestruct or forceful send)
        vm.deal(address(pool), STAKE_AMT + 0.1 ether);

        pool.pause();
        uint256 ownerBefore = address(this).balance;
        pool.emergencyWithdraw();

        assertEq(address(this).balance - ownerBefore, 0.1 ether, "C1: only surplus must be withdrawn");
        assertEq(address(pool).balance, STAKE_AMT,               "C1: staked ETH must remain in pool");
    }

    /// C1: reverts when there is no surplus
    function test_C1_noSurplusReverts() public {
        _stake(staker1, 1, keccak256("r1"), beneficiary);
        // balance == totalStaked, surplus = 0
        pool.pause();
        vm.expectRevert("no surplus to withdraw");
        pool.emergencyWithdraw();
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper contract: always rejects ETH — used to test M4 failedPayouts
// ─────────────────────────────────────────────────────────────────────────────
contract RevertingReceiver {
    receive() external payable {
        revert("reject ETH");
    }
}
