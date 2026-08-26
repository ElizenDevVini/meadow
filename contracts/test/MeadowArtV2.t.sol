// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {MeadowArtV2} from "../src/MeadowArtV2.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockMultiplier} from "./mocks/MockMultiplier.sol";

contract MeadowArtV2Test is Test {
    uint256 internal constant N = 4;
    uint64 internal constant REWARD_DAYS = 365;

    MockERC20 internal projectToken;
    MockERC20 internal stockA;
    MockERC20 internal stockB;
    MeadowArtV2 internal art;

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

        art = new MeadowArtV2(IERC20(address(projectToken)), stocks, prices, stockIdx, rates, rewardEnd, owner);

        projectToken.mint(buyer, 10_000e18);
        projectToken.mint(buyer2, 10_000e18);
    }

    function _buy(address who, uint256 id) internal {
        vm.startPrank(who);
        projectToken.approve(address(art), prices[id]);
        art.buy(id);
        vm.stopPrank();
    }

    // ---- shared behavior (carried over from MeadowArt) ----

    // Deliberate deviation from MeadowArt: a distinct name/symbol per
    // collection, so V2 pieces are distinguishable from V1 in wallets and
    // on marketplaces.
    function test_NameAndSymbol() public view {
        assertEq(art.name(), "meadow art v2");
        assertEq(art.symbol(), "PIECE2");
    }

    function test_BuyPullsExactPriceAndMints() public {
        uint256 buyerBalBefore = projectToken.balanceOf(buyer);

        vm.startPrank(buyer);
        projectToken.approve(address(art), prices[0]);
        vm.expectEmit(true, true, false, true);
        emit MeadowArtV2.Bought(0, buyer, prices[0]);
        art.buy(0);
        vm.stopPrank();

        assertEq(art.ownerOf(0), buyer);
        assertEq(projectToken.balanceOf(buyer), buyerBalBefore - prices[0]);
        assertEq(projectToken.balanceOf(address(art)), prices[0]);
        assertEq(art.lastClaim(0), block.timestamp);
    }

    function test_ClaimAccruesRateTimesElapsedAndPaysAssignedStock() public {
        _buy(buyer, 0);
        stockA.mint(address(art), 1_000_000e18);

        uint256 elapsed = 10_000;
        vm.warp(block.timestamp + elapsed);

        uint256 expected = rates[0] * elapsed;
        assertEq(art.claimable(0), expected);

        vm.prank(buyer);
        art.claim(0);

        assertEq(stockA.balanceOf(buyer), expected);
        assertEq(art.lastClaim(0), block.timestamp);
        assertEq(art.claimable(0), 0);
    }

    function test_TransferResetsLastClaimAndAccrualFollowsThePiece() public {
        _buy(buyer, 0);
        stockA.mint(address(art), 1_000_000e18);
        vm.warp(block.timestamp + 10_000);

        assertGt(art.claimable(0), 0);

        vm.prank(buyer);
        art.transferFrom(buyer, buyer2, 0);

        assertEq(art.lastClaim(0), block.timestamp);
        assertEq(art.claimable(0), 0);

        vm.warp(block.timestamp + 5_000);
        assertEq(art.claimable(0), rates[0] * 5_000);

        vm.prank(buyer2);
        art.claim(0);
        assertEq(stockA.balanceOf(buyer2), rates[0] * 5_000);
    }

    // ---- one piece per wallet, permanent ----

    function test_BuyRevertsWhenSameWalletBuysASecondPiece() public {
        _buy(buyer, 0);

        vm.startPrank(buyer);
        projectToken.approve(address(art), prices[1]);
        vm.expectRevert(MeadowArtV2.AlreadyMinted.selector);
        art.buy(1);
        vm.stopPrank();

        assertTrue(art.hasMinted(buyer));
        assertEq(art.ownerOf(0), buyer);
    }

    function test_BuyRevertsOnDoubleBuyOfSamePieceByDifferentWallet() public {
        _buy(buyer, 0);

        vm.startPrank(buyer2);
        projectToken.approve(address(art), prices[0]);
        vm.expectRevert(MeadowArtV2.AlreadyMinted.selector);
        art.buy(0);
        vm.stopPrank();
    }

    function test_DifferentWalletCanStillBuy() public {
        _buy(buyer, 0);
        _buy(buyer2, 1);

        assertEq(art.ownerOf(0), buyer);
        assertEq(art.ownerOf(1), buyer2);
        assertTrue(art.hasMinted(buyer));
        assertTrue(art.hasMinted(buyer2));
    }

    function test_WalletThatSoldItsPieceStillCannotMintAgain() public {
        _buy(buyer, 0);

        vm.prank(buyer);
        art.transferFrom(buyer, buyer2, 0);
        assertEq(art.balanceOf(buyer), 0); // balance is back to zero, but the cap is permanent

        vm.startPrank(buyer);
        projectToken.approve(address(art), prices[1]);
        vm.expectRevert(MeadowArtV2.AlreadyMinted.selector);
        art.buy(1);
        vm.stopPrank();
    }

    // ---- base URI / marketplace metadata ----

    function test_SetBaseURIOwnerOnly() public {
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, buyer));
        art.setBaseURI("https://example.com/meta/");
    }

    function test_TokenURIMatchesBasePlusTokenIdAfterSet() public {
        _buy(buyer, 3);

        string memory base = "https://elizendevvini.github.io/meadow/art/v2/meta/";
        vm.prank(owner);
        art.setBaseURI(base);

        assertEq(art.tokenURI(3), string.concat(base, "3"));
    }

    function test_TokenURIRevertsForNonexistentToken() public {
        vm.prank(owner);
        art.setBaseURI("https://example.com/meta/");

        vm.expectRevert();
        art.tokenURI(2); // never bought
    }

    function test_TokenURIIsEmptyBeforeBaseURISet() public {
        _buy(buyer, 0);
        assertEq(art.tokenURI(0), "");
    }

    function test_ContractURIReturnsBasePlusCollectionJson() public {
        string memory base = "https://elizendevvini.github.io/meadow/art/v2/meta/";
        vm.prank(owner);
        art.setBaseURI(base);

        assertEq(art.contractURI(), string.concat(base, "collection.json"));
    }

    function test_ContractURIEmptyBeforeBaseURISet() public {
        assertEq(art.contractURI(), "");
    }

    // ---- multiplier: one-shot + clamp ----

    function test_SetMultiplierSourceIsOneShot() public {
        MockMultiplier mult1 = new MockMultiplier();
        MockMultiplier mult2 = new MockMultiplier();

        vm.startPrank(owner);
        art.setMultiplierSource(address(mult1));
        vm.expectRevert(MeadowArtV2.AlreadySet.selector);
        art.setMultiplierSource(address(mult2));
        vm.stopPrank();

        assertEq(art.multiplierSource(), address(mult1));
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
}
