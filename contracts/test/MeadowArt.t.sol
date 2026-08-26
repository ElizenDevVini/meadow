// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {MeadowArt} from "../src/MeadowArt.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockMultiplier} from "./mocks/MockMultiplier.sol";

contract MeadowArtTest is Test {
    uint256 internal constant N = 4;
    uint64 internal constant REWARD_DAYS = 365;

    MockERC20 internal projectToken;
    MockERC20 internal stockA;
    MockERC20 internal stockB;
    MeadowArt internal art;

    address internal owner = makeAddr("owner");
    address internal buyer = makeAddr("buyer");
    address internal buyer2 = makeAddr("buyer2");

    uint64 internal rewardEnd;

    // piece 0 -> stockA, piece 1 -> stockB, piece 2 -> stockA, piece 3 -> stockB
    uint256[] internal prices = [100e18, 250e18, 500e18, 1000e18];
    uint8[] internal stockIdx = [0, 1, 0, 1];
    uint256[] internal rates = [1e12, 2e12, 5e12, 10e12];

    function setUp() public {
        projectToken = new MockERC20("Meadow Project", "MDWP", 18);
        stockA = new MockERC20("Stock A", "STKA", 18);
        stockB = new MockERC20("Stock B", "STKB", 18);

        rewardEnd = uint64(block.timestamp + REWARD_DAYS * 1 days);

        IERC20[] memory stocks = new IERC20[](2);
        stocks[0] = IERC20(address(stockA));
        stocks[1] = IERC20(address(stockB));

        art = new MeadowArt(IERC20(address(projectToken)), stocks, prices, stockIdx, rates, rewardEnd, owner);

        projectToken.mint(buyer, 10_000e18);
        projectToken.mint(buyer2, 10_000e18);
    }

    function _buy(address who, uint256 id) internal {
        vm.startPrank(who);
        projectToken.approve(address(art), prices[id]);
        art.buy(id);
        vm.stopPrank();
    }

    // ---- constructor validation ----

    function test_ConstructorRevertsOnLengthMismatch() public {
        IERC20[] memory stocks = new IERC20[](1);
        stocks[0] = IERC20(address(stockA));
        uint256[] memory badPrices = new uint256[](2);
        badPrices[0] = 1e18;
        badPrices[1] = 1e18;
        uint8[] memory badIdx = new uint8[](1);
        badIdx[0] = 0;

        vm.expectRevert(MeadowArt.InvalidConfig.selector);
        new MeadowArt(IERC20(address(projectToken)), stocks, badPrices, badIdx, rates, rewardEnd, owner);
    }

    function test_ConstructorRevertsOnZeroPrice() public {
        uint256[] memory badPrices = new uint256[](1);
        badPrices[0] = 0;
        uint8[] memory idx = new uint8[](1);
        idx[0] = 0;
        uint256[] memory rate = new uint256[](1);
        rate[0] = 1e12;
        IERC20[] memory stocks = new IERC20[](1);
        stocks[0] = IERC20(address(stockA));

        vm.expectRevert(MeadowArt.InvalidConfig.selector);
        new MeadowArt(IERC20(address(projectToken)), stocks, badPrices, idx, rate, rewardEnd, owner);
    }

    function test_ConstructorRevertsOnStockIdxOutOfRange() public {
        uint256[] memory p = new uint256[](1);
        p[0] = 1e18;
        uint8[] memory idx = new uint8[](1);
        idx[0] = 5; // only 1 stock configured below
        uint256[] memory rate = new uint256[](1);
        rate[0] = 1e12;
        IERC20[] memory stocks = new IERC20[](1);
        stocks[0] = IERC20(address(stockA));

        vm.expectRevert(MeadowArt.InvalidConfig.selector);
        new MeadowArt(IERC20(address(projectToken)), stocks, p, idx, rate, rewardEnd, owner);
    }

    function test_ConstructorRevertsOnRateAboveMax() public {
        uint256[] memory p = new uint256[](1);
        p[0] = 1e18;
        uint8[] memory idx = new uint8[](1);
        idx[0] = 0;
        uint256[] memory rate = new uint256[](1);
        rate[0] = art.MAX_RATE() + 1;
        IERC20[] memory stocks = new IERC20[](1);
        stocks[0] = IERC20(address(stockA));

        vm.expectRevert(MeadowArt.InvalidConfig.selector);
        new MeadowArt(IERC20(address(projectToken)), stocks, p, idx, rate, rewardEnd, owner);
    }

    function test_ConstructorRevertsOnRewardEndOutOfBounds() public {
        IERC20[] memory stocks = new IERC20[](1);
        stocks[0] = IERC20(address(stockA));
        uint256[] memory p = new uint256[](1);
        p[0] = 1e18;
        uint8[] memory idx = new uint8[](1);
        idx[0] = 0;
        uint256[] memory rate = new uint256[](1);
        rate[0] = 1e12;

        vm.expectRevert(MeadowArt.InvalidConfig.selector);
        new MeadowArt(
            IERC20(address(projectToken)), stocks, p, idx, rate, uint64(block.timestamp + 1 days), owner
        );
    }

    function test_ConstructorRevertsOnNon18DecimalStock() public {
        MockERC20 sixDecimals = new MockERC20("Bad", "BAD", 6);
        IERC20[] memory stocks = new IERC20[](1);
        stocks[0] = IERC20(address(sixDecimals));
        uint256[] memory p = new uint256[](1);
        p[0] = 1e18;
        uint8[] memory idx = new uint8[](1);
        idx[0] = 0;
        uint256[] memory rate = new uint256[](1);
        rate[0] = 1e12;

        vm.expectRevert(MeadowArt.InvalidConfig.selector);
        new MeadowArt(IERC20(address(projectToken)), stocks, p, idx, rate, rewardEnd, owner);
    }

    // ---- buy ----

    function test_BuyPullsExactPriceAndMints() public {
        uint256 buyerBalBefore = projectToken.balanceOf(buyer);

        vm.startPrank(buyer);
        projectToken.approve(address(art), prices[0]);
        vm.expectEmit(true, true, false, true);
        emit MeadowArt.Bought(0, buyer, prices[0]);
        art.buy(0);
        vm.stopPrank();

        assertEq(art.ownerOf(0), buyer);
        assertEq(projectToken.balanceOf(buyer), buyerBalBefore - prices[0]);
        assertEq(projectToken.balanceOf(address(art)), prices[0]);
        assertEq(art.lastClaim(0), block.timestamp);
    }

    function test_BuyRevertsWithoutApproval() public {
        vm.prank(buyer);
        vm.expectRevert();
        art.buy(0);
    }

    function test_BuyRevertsOnDoubleBuy() public {
        _buy(buyer, 0);
        vm.startPrank(buyer2);
        projectToken.approve(address(art), prices[0]);
        vm.expectRevert(MeadowArt.AlreadyMinted.selector);
        art.buy(0);
        vm.stopPrank();
    }

    function test_BuyRevertsAfterRewardEnd() public {
        vm.warp(rewardEnd);
        vm.startPrank(buyer);
        projectToken.approve(address(art), prices[0]);
        vm.expectRevert(MeadowArt.ProgramEnded.selector);
        art.buy(0);
        vm.stopPrank();
    }

    function test_BuyRevertsOnInvalidId() public {
        vm.startPrank(buyer);
        projectToken.approve(address(art), prices[0]);
        vm.expectRevert(MeadowArt.InvalidPiece.selector);
        art.buy(N); // only 4 configured (ids 0..3)
        vm.stopPrank();
    }

    // ---- claim accrual ----

    function test_ClaimAccruesRateTimesElapsedAndPaysAssignedStock() public {
        _buy(buyer, 0);
        stockA.mint(address(art), 1_000_000e18); // fund well above what will accrue

        uint256 elapsed = 10_000;
        vm.warp(block.timestamp + elapsed);

        uint256 expected = rates[0] * elapsed; // multiplier is 1x by default
        assertEq(art.claimable(0), expected);

        vm.prank(buyer);
        art.claim(0);

        assertEq(stockA.balanceOf(buyer), expected);
        assertEq(art.lastClaim(0), block.timestamp);
        assertEq(art.claimable(0), 0);
    }

    function test_ClaimIsNoOpWhenNothingAccrued() public {
        _buy(buyer, 0);
        stockA.mint(address(art), 1_000_000e18);

        vm.prank(buyer);
        art.claim(0); // no time elapsed since buy -> zero claimable, must not revert

        assertEq(stockA.balanceOf(buyer), 0);
    }

    // ---- multiplier ----

    function test_MultiplierScalesPayout() public {
        MockMultiplier mult = new MockMultiplier();
        vm.prank(owner);
        art.setMultiplierSource(address(mult));

        _buy(buyer, 0);
        stockA.mint(address(art), 1_000_000e18);

        mult.set(2e18); // 2x
        vm.warp(block.timestamp + 10_000);

        uint256 base = rates[0] * 10_000;
        assertEq(art.claimable(0), base * 2);
    }

    function test_MultiplierClampsToMaxAndMin() public {
        MockMultiplier mult = new MockMultiplier();
        vm.prank(owner);
        art.setMultiplierSource(address(mult));

        _buy(buyer, 0);
        stockA.mint(address(art), 1_000_000e18);
        vm.warp(block.timestamp + 10_000);
        uint256 base = rates[0] * 10_000;

        mult.set(50e18); // above MAX_MULT (10x)
        assertEq(art.claimable(0), base * 10);

        mult.set(1e15); // below MIN_MULT (0.1x)
        assertEq(art.claimable(0), base / 10);
    }

    function test_MultiplierFallsBackTo1xOnRevert() public {
        MockMultiplier mult = new MockMultiplier();
        mult.setShouldRevert(true);
        vm.prank(owner);
        art.setMultiplierSource(address(mult));

        _buy(buyer, 0);
        vm.warp(block.timestamp + 10_000);
        assertEq(art.claimable(0), rates[0] * 10_000);
    }

    function test_SetMultiplierSourceIsOneShot() public {
        MockMultiplier mult1 = new MockMultiplier();
        MockMultiplier mult2 = new MockMultiplier();

        vm.startPrank(owner);
        art.setMultiplierSource(address(mult1));
        vm.expectRevert(MeadowArt.AlreadySet.selector);
        art.setMultiplierSource(address(mult2));
        vm.stopPrank();

        assertEq(art.multiplierSource(), address(mult1));
    }

    function test_SetMultiplierSourceOnlyOwner() public {
        MockMultiplier mult = new MockMultiplier();
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, buyer));
        art.setMultiplierSource(address(mult));
    }

    // ---- claimMany ----

    function test_ClaimMany() public {
        _buy(buyer, 0);
        _buy(buyer, 1);
        stockA.mint(address(art), 1_000_000e18);
        stockB.mint(address(art), 1_000_000e18);

        vm.warp(block.timestamp + 5_000);

        uint256[] memory ids = new uint256[](2);
        ids[0] = 0;
        ids[1] = 1;

        vm.prank(buyer);
        art.claimMany(ids);

        assertEq(stockA.balanceOf(buyer), rates[0] * 5_000);
        assertEq(stockB.balanceOf(buyer), rates[1] * 5_000);
    }

    function test_ClaimManyRevertsOverBatchLimit() public {
        uint256[] memory ids = new uint256[](art.MAX_BATCH() + 1);
        vm.prank(buyer);
        vm.expectRevert(MeadowArt.BatchTooLarge.selector);
        art.claimMany(ids);
    }

    // ---- underfunded treasury ----

    function test_UnderfundedClaimPaysPartialWithoutRevertingAndForfeitsShortfall() public {
        _buy(buyer, 0);
        vm.warp(block.timestamp + 10_000);

        uint256 owed = rates[0] * 10_000;
        uint256 funded = owed / 4;
        stockA.mint(address(art), funded);

        assertEq(art.claimable(0), owed);
        assertEq(art.availablePayout(0), funded);

        vm.prank(buyer);
        art.claim(0); // must not revert even though funded < owed

        assertEq(stockA.balanceOf(buyer), funded);
        // lastClaim still advances to now, so the unpaid shortfall is forfeited,
        // not carried forward as a debt.
        assertEq(art.claimable(0), 0);
    }

    function test_DryTreasuryClaimIsTrueNoOpAndAccrualSurvivesUntilFunded() public {
        _buy(buyer, 0); // stockA balance stays at zero -- nothing minted to the contract
        vm.warp(block.timestamp + 10_000);

        uint256 owed = rates[0] * 10_000;
        assertEq(art.claimable(0), owed);
        assertEq(art.availablePayout(0), 0);

        vm.prank(buyer);
        art.claim(0); // must not revert, must not advance lastClaim, must not emit Claimed

        assertEq(stockA.balanceOf(buyer), 0);
        assertEq(art.claimable(0), owed); // accrual untouched by the dry claim

        stockA.mint(address(art), owed);
        vm.prank(buyer);
        art.claim(0); // now fully payable

        assertEq(stockA.balanceOf(buyer), owed);
        assertEq(art.claimable(0), 0);
    }

    // ---- transfer resets accrual ----

    function test_TransferResetsLastClaimAndOldOwnerCannotClaimAfterward() public {
        _buy(buyer, 0);
        stockA.mint(address(art), 1_000_000e18);
        vm.warp(block.timestamp + 10_000);

        uint256 accruedBeforeTransfer = art.claimable(0);
        assertGt(accruedBeforeTransfer, 0);

        vm.prank(buyer);
        art.transferFrom(buyer, buyer2, 0);

        assertEq(art.lastClaim(0), block.timestamp);
        assertEq(art.claimable(0), 0);

        vm.prank(buyer);
        vm.expectRevert(MeadowArt.NotPieceOwner.selector);
        art.claim(0);

        vm.warp(block.timestamp + 5_000);
        uint256 expectedForNewOwner = rates[0] * 5_000;
        assertEq(art.claimable(0), expectedForNewOwner);

        vm.prank(buyer2);
        art.claim(0);
        assertEq(stockA.balanceOf(buyer2), expectedForNewOwner);
        assertEq(stockA.balanceOf(buyer), 0); // seller never claimed before selling; forfeited
    }

    // ---- admin ----

    function test_WithdrawProceedsOwnerOnly() public {
        _buy(buyer, 0);
        address to = makeAddr("treasury");

        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, buyer));
        art.withdrawProceeds(to, prices[0]);

        vm.prank(owner);
        art.withdrawProceeds(to, prices[0]);
        assertEq(projectToken.balanceOf(to), prices[0]);
    }

    function test_WithdrawStockOwnerOnlyAndPullsSurplus() public {
        stockA.mint(address(art), 1_000e18);
        address to = makeAddr("treasury");

        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, buyer));
        art.withdrawStock(0, to, 100e18);

        vm.prank(owner);
        art.withdrawStock(0, to, 100e18);
        assertEq(stockA.balanceOf(to), 100e18);
        assertEq(stockA.balanceOf(address(art)), 900e18);
    }

    function test_WithdrawStockRevertsOnInsufficientBalance() public {
        stockA.mint(address(art), 10e18);
        vm.prank(owner);
        vm.expectRevert();
        art.withdrawStock(0, makeAddr("treasury"), 100e18);
    }
}
