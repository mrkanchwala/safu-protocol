// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import "forge-std/Test.sol";
import "../contracts/SAFUPool.sol";

/**
 * SAFUPool v6 — Halmos symbolic property checks.
 *
 * Run with: halmos --contract SAFUPoolHalmos
 *
 * Each check_ function is a symbolic property Halmos verifies.
 * Function parameters are treated as unconstrained symbolic inputs.
 * Concrete state is set up via setUp + helpers (ECDSA with fixed PKs).
 */
contract SAFUPoolHalmos is Test {

    SAFUPool pool;

    uint256 constant ORACLE_PK   = 0xA11CE;
    uint256 constant COSIGNER_PK = 0xB0B0B;
    uint256 constant STAKER1_PK  = 0xCAFE1;

    address oracle;
    address coSigner;
    address staker1;
    address beneficiary;

    uint256 constant MAX_POOL  = 0.75 ether;
    uint256 constant STAKE_AMT = 0.015 ether;
    bytes32 constant REASON    = keccak256("halmos-r1");
    bytes32 constant TX_HASH   = keccak256("halmos-tx1");

    function setUp() public {
        oracle      = vm.addr(ORACLE_PK);
        coSigner    = vm.addr(COSIGNER_PK);
        staker1     = vm.addr(STAKER1_PK);
        beneficiary = makeAddr("beneficiary");

        pool = new SAFUPool(oracle, coSigner, MAX_POOL);
        vm.deal(staker1, 10 ether);
    }

    receive() external payable {}

    // ── Helpers ──────────────────────────────────────────────────────────────

    function _stakeSig(uint64 deadline) internal view returns (bytes memory) {
        bytes32 inner = keccak256(abi.encodePacked(
            "SAFU_STAKE_APPROVAL", address(pool), block.chainid,
            staker1, uint8(1), deadline, REASON
        ));
        bytes32 ethHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", inner));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ORACLE_PK, ethHash);
        return abi.encodePacked(r, s, v);
    }

    function _stake() internal {
        uint64 deadline = uint64(block.timestamp + 1 hours);
        vm.prank(staker1);
        pool.stakeETH{value: STAKE_AMT}(1, deadline, REASON, _stakeSig(deadline), beneficiary);
    }

    function _stakeAndClaim() internal returns (bytes32 claimId) {
        _stake();
        pool.submitClaim(staker1, TX_HASH, 0.1 ether);
        claimId = keccak256(abi.encodePacked(staker1, TX_HASH));
    }

    // ── Properties ───────────────────────────────────────────────────────────

    // P1: cancelClaim never sends ETH back — forfeit design
    function check_cancelClaim_no_refund() public {
        bytes32 claimId = _stakeAndClaim();
        uint256 balBefore = address(pool).balance;
        pool.cancelClaim(claimId);
        assert(address(pool).balance == balBefore);
    }

    // P2: cancelClaim decrements totalStaked by exactly the staked amount
    function check_cancelClaim_totalStaked_decremented() public {
        _stakeAndClaim();
        uint256 totalBefore = pool.totalStaked();
        pool.cancelClaim(keccak256(abi.encodePacked(staker1, TX_HASH)));
        assert(pool.totalStaked() == totalBefore - STAKE_AMT);
    }

    // P3: after submitClaim, staker withdrawal is permanently blocked
    function check_withdraw_blocked_after_claim() public {
        _stakeAndClaim();
        vm.warp(block.timestamp + 91 days);
        vm.prank(staker1);
        try pool.withdraw(beneficiary) {
            assert(false); // must not succeed — withdrawal blocked after claim
        } catch {}
    }

    // P4: staker amount is zeroed after cancelClaim
    function check_cancelClaim_amount_zeroed() public {
        bytes32 claimId = _stakeAndClaim();
        pool.cancelClaim(claimId);
        SAFUPool.StakeRecord memory s = pool.stakeOf(staker1);
        assert(s.amount == 0);
        assert(!s.claimActive);
    }

    // P5: coSigner != owner invariant always holds at deploy
    function check_cosigner_neq_owner() public view {
        assert(pool.coSigner() != pool.owner());
    }

    // P6: H2 fix — transferOwnership to coSigner always reverts
    function check_transferOwnership_to_cosigner_reverts() public {
        try pool.transferOwnership(pool.coSigner()) {
            assert(false); // must not succeed — H2 fix
        } catch {}
    }

    // P7: accounting soundness — reserved ETH never exceeds contract balance
    function check_reserved_leq_balance() public view {
        assert(pool.totalStaked() + pool.totalFailedPayouts() <= address(pool).balance);
    }

    // P8: M1 symbolic — any entitlement above tier A cap (0.20 ETH) must revert
    function check_submitClaim_above_tierA_cap_reverts(uint256 entitlement) public {
        _stake();
        vm.assume(entitlement > 0.20 ether);
        try pool.submitClaim(staker1, TX_HASH, entitlement) {
            assert(false); // must not succeed — tier A cap is 0.20 ETH
        } catch {}
    }

    // P9: M1 symbolic — any entitlement above MAX_COVERAGE must revert
    function check_submitClaim_above_max_coverage_reverts(uint256 entitlement) public {
        _stake();
        vm.assume(entitlement > 0.25 ether);
        try pool.submitClaim(staker1, TX_HASH, entitlement) {
            assert(false); // must not succeed — MAX_COVERAGE is 0.25 ETH
        } catch {}
    }

    // P10: cancelled claim (status==3) cannot be streamed
    function check_cancelled_claim_not_streamable() public {
        bytes32 claimId = _stakeAndClaim();
        pool.cancelClaim(claimId);
        vm.prank(staker1);
        try pool.claimStream(claimId, beneficiary) {
            assert(false); // must not succeed — claim is cancelled
        } catch {}
    }
}
