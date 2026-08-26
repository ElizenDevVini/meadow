// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {MeadowMarket} from "../src/MeadowMarket.sol";
import {MeadowArt} from "../src/MeadowArt.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockERC721} from "./mocks/MockERC721.sol";

contract MeadowMarketTest is Test {
    uint16 internal constant FEE_BPS = 250; // 2.5%

    MockERC20 internal payToken;
    MockERC721 internal nft;
    MeadowMarket internal market;

    address internal owner = makeAddr("owner");
    address internal feeRecipient = makeAddr("feeRecipient");
    address internal seller = makeAddr("seller");
    address internal buyer = makeAddr("buyer");
    address internal stranger = makeAddr("stranger");

    uint256 internal constant TOKEN_ID = 1;
    uint256 internal constant PRICE = 1_000e18;

    function setUp() public {
        payToken = new MockERC20("Pay", "PAY", 18);
        nft = new MockERC721("Meadow Art", "PIECE");
        market = new MeadowMarket(IERC721(address(nft)), IERC20(address(payToken)), FEE_BPS, feeRecipient, owner);

        nft.mint(seller, TOKEN_ID);
        payToken.mint(buyer, 100_000e18);
    }

    function _listViaApprove(uint256 id, uint256 price) internal {
        vm.startPrank(seller);
        nft.approve(address(market), id);
        market.list(id, price);
        vm.stopPrank();
    }

    // ---- list ----

    function test_ListRevertsIfNotOwner() public {
        vm.prank(stranger);
        vm.expectRevert(MeadowMarket.NotOwner.selector);
        market.list(TOKEN_ID, PRICE);
    }

    function test_ListRevertsIfNotApproved() public {
        vm.prank(seller);
        vm.expectRevert(MeadowMarket.NotApproved.selector);
        market.list(TOKEN_ID, PRICE);
    }

    function test_ListRevertsOnZeroPrice() public {
        vm.startPrank(seller);
        nft.approve(address(market), TOKEN_ID);
        vm.expectRevert(MeadowMarket.ZeroPrice.selector);
        market.list(TOKEN_ID, 0);
        vm.stopPrank();
    }

    function test_ListSucceedsViaGetApproved() public {
        vm.prank(seller);
        nft.approve(address(market), TOKEN_ID);

        vm.expectEmit(true, true, false, true, address(market));
        emit MeadowMarket.Listed(TOKEN_ID, seller, PRICE);
        vm.prank(seller);
        market.list(TOKEN_ID, PRICE);

        (address s, uint256 p) = market.listings(TOKEN_ID);
        assertEq(s, seller);
        assertEq(p, PRICE);
        assertTrue(market.isListingValid(TOKEN_ID));
    }

    function test_ListTwiceOverwritesRatherThanReverting() public {
        _listViaApprove(TOKEN_ID, PRICE);
        vm.prank(seller);
        market.list(TOKEN_ID, PRICE * 2);
        assertEq(market.priceOf(TOKEN_ID), PRICE * 2);
    }

    function test_ListSucceedsViaSetApprovalForAll() public {
        vm.startPrank(seller);
        nft.setApprovalForAll(address(market), true);
        market.list(TOKEN_ID, PRICE);
        vm.stopPrank();
        assertTrue(market.isListingValid(TOKEN_ID));
    }

    // ---- updatePrice / cancel ----

    function test_UpdatePriceRevertsIfNotSeller() public {
        _listViaApprove(TOKEN_ID, PRICE);
        vm.prank(stranger);
        vm.expectRevert(MeadowMarket.NotListed.selector);
        market.updatePrice(TOKEN_ID, PRICE * 2);
    }

    function test_UpdatePriceRevertsOnZeroPrice() public {
        _listViaApprove(TOKEN_ID, PRICE);
        vm.prank(seller);
        vm.expectRevert(MeadowMarket.ZeroPrice.selector);
        market.updatePrice(TOKEN_ID, 0);
    }

    function test_UpdatePriceSucceedsForSeller() public {
        _listViaApprove(TOKEN_ID, PRICE);
        vm.prank(seller);
        market.updatePrice(TOKEN_ID, PRICE * 2);
        assertEq(market.priceOf(TOKEN_ID), PRICE * 2);
    }

    function test_CancelRevertsIfNotSeller() public {
        _listViaApprove(TOKEN_ID, PRICE);
        vm.prank(stranger);
        vm.expectRevert(MeadowMarket.NotListed.selector);
        market.cancel(TOKEN_ID);
    }

    function test_CancelSucceedsForSeller() public {
        _listViaApprove(TOKEN_ID, PRICE);
        vm.prank(seller);
        market.cancel(TOKEN_ID);
        (address s,) = market.listings(TOKEN_ID);
        assertEq(s, address(0));
        assertFalse(market.isListingValid(TOKEN_ID));
    }

    // ---- buy ----

    function test_BuyTransfersNftAndSplitsPayment() public {
        _listViaApprove(TOKEN_ID, PRICE);

        vm.prank(buyer);
        payToken.approve(address(market), PRICE);

        uint256 expectedFee = (PRICE * FEE_BPS) / market.BPS();
        uint256 expectedSellerProceeds = PRICE - expectedFee;

        vm.expectEmit(true, true, true, true, address(market));
        emit MeadowMarket.Sold(TOKEN_ID, seller, buyer, PRICE, expectedFee);
        vm.prank(buyer);
        market.buy(TOKEN_ID);

        assertEq(nft.ownerOf(TOKEN_ID), buyer);
        assertEq(payToken.balanceOf(seller), expectedSellerProceeds);
        assertEq(payToken.balanceOf(feeRecipient), expectedFee);
        assertEq(payToken.balanceOf(buyer), 100_000e18 - PRICE);
        assertEq(payToken.balanceOf(address(market)), 0); // non-custodial: nothing strands in the market

        (address s,) = market.listings(TOKEN_ID);
        assertEq(s, address(0)); // listing cleared after sale
    }

    /// @dev PRICE * FEE_BPS does not divide evenly by BPS here, so this pins
    /// the rounding direction (fee rounds down, seller absorbs the dust) and
    /// proves the split still sums to the full price with no wei stranded.
    function test_BuySplitRoundsDownAndConservesFullPrice() public {
        uint256 oddPrice = 1_001e18 + 7;
        vm.startPrank(seller);
        nft.approve(address(market), TOKEN_ID);
        market.list(TOKEN_ID, oddPrice);
        vm.stopPrank();

        payToken.mint(buyer, oddPrice);
        vm.startPrank(buyer);
        payToken.approve(address(market), oddPrice);
        market.buy(TOKEN_ID);
        vm.stopPrank();

        uint256 expectedFee = (oddPrice * FEE_BPS) / market.BPS();
        assertEq(payToken.balanceOf(feeRecipient), expectedFee);
        assertEq(payToken.balanceOf(seller), oddPrice - expectedFee);
        assertEq(payToken.balanceOf(seller) + payToken.balanceOf(feeRecipient), oddPrice);
        assertEq(payToken.balanceOf(address(market)), 0);
    }

    function test_BuyWithZeroFeeSkipsFeeTransferEntirely() public {
        vm.prank(owner);
        market.setFee(0, feeRecipient);

        _listViaApprove(TOKEN_ID, PRICE);
        vm.prank(buyer);
        payToken.approve(address(market), PRICE);
        vm.prank(buyer);
        market.buy(TOKEN_ID);

        assertEq(payToken.balanceOf(seller), PRICE);
        assertEq(payToken.balanceOf(feeRecipient), 0);
    }

    function test_BuyRevertsOnSelfBuy() public {
        _listViaApprove(TOKEN_ID, PRICE);
        vm.prank(seller);
        vm.expectRevert(MeadowMarket.SelfBuy.selector);
        market.buy(TOKEN_ID);
    }

    function test_BuyRevertsWhenTokenNotListed() public {
        vm.prank(buyer);
        vm.expectRevert(MeadowMarket.NotListed.selector);
        market.buy(TOKEN_ID);
    }

    function test_BuyRevertsOnStaleListing_SellerTransferredAway() public {
        _listViaApprove(TOKEN_ID, PRICE);

        vm.prank(seller);
        nft.transferFrom(seller, stranger, TOKEN_ID);

        vm.prank(buyer);
        payToken.approve(address(market), PRICE);
        vm.prank(buyer);
        vm.expectRevert(MeadowMarket.StaleListing.selector);
        market.buy(TOKEN_ID);
    }

    function test_BuyRevertsOnStaleListing_ApprovalRevoked() public {
        _listViaApprove(TOKEN_ID, PRICE);

        vm.prank(seller);
        nft.approve(address(0), TOKEN_ID);

        vm.prank(buyer);
        payToken.approve(address(market), PRICE);
        vm.prank(buyer);
        vm.expectRevert(MeadowMarket.StaleListing.selector);
        market.buy(TOKEN_ID);
    }

    function test_BuyRevertsIfBuyerHasNotApprovedPay() public {
        _listViaApprove(TOKEN_ID, PRICE);

        // buyer never approved the market to move `pay`; the first transfer
        // buy() attempts is the seller's proceeds (price minus fee)
        uint256 expectedSellerProceeds = PRICE - (PRICE * FEE_BPS) / market.BPS();
        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC20Errors.ERC20InsufficientAllowance.selector, address(market), 0, expectedSellerProceeds
            )
        );
        market.buy(TOKEN_ID);
    }

    // ---- admin ----

    function test_SetFeeRevertsIfNotOwner() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        market.setFee(500, feeRecipient);
    }

    function test_SetFeeRevertsAboveMax() public {
        uint16 tooHigh = market.MAX_FEE_BPS() + 1;
        vm.prank(owner);
        vm.expectRevert(MeadowMarket.FeeTooHigh.selector);
        market.setFee(tooHigh, feeRecipient);
    }

    function test_SetFeeRevertsOnZeroRecipient() public {
        vm.prank(owner);
        vm.expectRevert(MeadowMarket.InvalidConfig.selector);
        market.setFee(500, address(0));
    }

    function test_SetFeeSucceedsForOwner() public {
        address newRecipient = makeAddr("newRecipient");

        vm.expectEmit(false, false, false, true, address(market));
        emit MeadowMarket.FeeChanged(500, newRecipient);
        vm.prank(owner);
        market.setFee(500, newRecipient);

        assertEq(market.feeBps(), 500);
        assertEq(market.feeRecipient(), newRecipient);
    }

    // ---- views ----

    function test_ListingsManyReturnsCorrectData() public {
        nft.mint(seller, 2);
        _listViaApprove(TOKEN_ID, PRICE);
        vm.startPrank(seller);
        nft.approve(address(market), 2);
        market.list(2, PRICE * 3);
        vm.stopPrank();

        uint256[] memory ids = new uint256[](3);
        ids[0] = TOKEN_ID;
        ids[1] = 2;
        ids[2] = 99; // never listed

        (address[] memory sellers, uint256[] memory prices, bool[] memory valid) = market.listingsMany(ids);

        assertEq(sellers[0], seller);
        assertEq(prices[0], PRICE);
        assertTrue(valid[0]);

        assertEq(sellers[1], seller);
        assertEq(prices[1], PRICE * 3);
        assertTrue(valid[1]);

        assertEq(sellers[2], address(0));
        assertEq(prices[2], 0);
        assertFalse(valid[2]);
    }

    // ---- constructor validation ----

    function test_ConstructorRevertsOnZeroFeeRecipient() public {
        vm.expectRevert(MeadowMarket.InvalidConfig.selector);
        new MeadowMarket(IERC721(address(nft)), IERC20(address(payToken)), FEE_BPS, address(0), owner);
    }

    function test_ConstructorRevertsOnFeeTooHigh() public {
        vm.expectRevert(MeadowMarket.FeeTooHigh.selector);
        new MeadowMarket(IERC721(address(nft)), IERC20(address(payToken)), 1001, feeRecipient, owner);
    }

    function test_ConstructorRevertsOnEoaArt() public {
        vm.expectRevert(MeadowMarket.InvalidConfig.selector);
        new MeadowMarket(IERC721(stranger), IERC20(address(payToken)), FEE_BPS, feeRecipient, owner);
    }

    // ---- integration: a real MeadowArt piece sold through the market ----

    function test_IntegrationWithRealMeadowArt_SaleResetsAccrual() public {
        MockERC20 projectToken = new MockERC20("Meadow Project", "MDWP", 18);
        MockERC20 stock = new MockERC20("Stock", "STK", 18);

        IERC20[] memory stocks = new IERC20[](1);
        stocks[0] = IERC20(address(stock));
        uint256[] memory prices = new uint256[](1);
        prices[0] = 100e18;
        uint8[] memory stockIdx = new uint8[](1);
        stockIdx[0] = 0;
        uint256[] memory rates = new uint256[](1);
        rates[0] = 1e12; // wei of stock per second

        uint64 rewardEnd = uint64(block.timestamp + 365 days);
        MeadowArt art = new MeadowArt(
            IERC20(address(projectToken)), stocks, prices, stockIdx, rates, rewardEnd, owner
        );
        stock.mint(address(art), 1_000e18); // fund the treasury so payouts aren't clamped

        // seller buys piece 0 from MeadowArt
        projectToken.mint(seller, prices[0]);
        vm.startPrank(seller);
        projectToken.approve(address(art), prices[0]);
        art.buy(0);
        vm.stopPrank();

        uint256 boughtAt = block.timestamp;
        vm.warp(boughtAt + 10 days);

        // accrual has been running for 10 days on the seller's ownership
        assertEq(art.claimable(0), rates[0] * 10 days);

        // seller lists on the market (paid in a token separate from the art's own pricing token)
        MeadowMarket artMarket =
            new MeadowMarket(IERC721(address(art)), IERC20(address(payToken)), FEE_BPS, feeRecipient, owner);
        vm.startPrank(seller);
        art.approve(address(artMarket), 0);
        artMarket.list(0, PRICE);
        vm.stopPrank();

        payToken.mint(buyer, PRICE);
        vm.startPrank(buyer);
        payToken.approve(address(artMarket), PRICE);
        artMarket.buy(0);
        vm.stopPrank();

        // ownership moved
        assertEq(art.ownerOf(0), buyer);

        // MeadowArt's own transfer hook resets lastClaim to the sale timestamp,
        // so accrual restarts from zero for the new owner
        assertEq(art.claimable(0), 0);

        vm.warp(block.timestamp + 5 days);
        assertEq(art.claimable(0), rates[0] * 5 days); // accrues from the sale time, not from boughtAt

        // the seller's 10 days of pre-sale accrual is gone, not paid: MeadowArt has
        // no owner-change reward settlement, so selling without claiming first forfeits it
        vm.prank(seller);
        vm.expectRevert(MeadowArt.NotPieceOwner.selector);
        art.claim(0);
    }
}
