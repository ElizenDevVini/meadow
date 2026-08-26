// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title MeadowMarket
/// @notice Non-custodial secondary market for MeadowArt pieces, priced and
/// paid in an ERC-20. A seller keeps the piece in their own wallet and just
/// approves this contract; buy() pulls payment from the buyer and moves the
/// piece seller -> buyer in one transaction. The contract never holds a
/// piece and never holds `pay` beyond the span of a single buy() call.
contract MeadowMarket is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant BPS = 10_000;
    uint16 public constant MAX_FEE_BPS = 1_000; // fee can never exceed 10%

    IERC721 public immutable art;
    IERC20 public immutable pay;

    uint16 public feeBps;
    address public feeRecipient;

    struct Listing {
        address seller;
        uint256 price;
    }

    mapping(uint256 => Listing) public listings;

    event Listed(uint256 indexed tokenId, address indexed seller, uint256 price);
    event PriceUpdated(uint256 indexed tokenId, address indexed seller, uint256 price);
    event Cancelled(uint256 indexed tokenId, address indexed seller);
    event Sold(uint256 indexed tokenId, address indexed seller, address indexed buyer, uint256 price, uint256 fee);
    event FeeChanged(uint16 feeBps, address feeRecipient);

    error NotOwner();
    error NotListed();
    error StaleListing();
    error ZeroPrice();
    error NotApproved();
    error SelfBuy();
    error FeeTooHigh();
    error InvalidConfig();

    constructor(IERC721 art_, IERC20 pay_, uint16 feeBps_, address feeRecipient_, address owner_)
        Ownable(owner_)
    {
        if (address(art_) == address(0) || address(art_).code.length == 0) revert InvalidConfig();
        if (address(pay_) == address(0) || address(pay_).code.length == 0) revert InvalidConfig();
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        if (feeRecipient_ == address(0)) revert InvalidConfig();

        art = art_;
        pay = pay_;
        feeBps = feeBps_;
        feeRecipient = feeRecipient_;
    }

    // ---- listing management ----

    /// @notice List a piece you own for `price` of `pay`. Requires this
    /// contract to already be approved so it can move the piece on sale.
    /// The piece stays in your wallet until it sells.
    function list(uint256 tokenId, uint256 price) external {
        if (art.ownerOf(tokenId) != msg.sender) revert NotOwner();
        if (price == 0) revert ZeroPrice();
        if (!_approved(tokenId, msg.sender)) revert NotApproved();
        listings[tokenId] = Listing(msg.sender, price);
        emit Listed(tokenId, msg.sender, price);
    }

    function updatePrice(uint256 tokenId, uint256 price) external {
        if (listings[tokenId].seller != msg.sender) revert NotListed();
        if (price == 0) revert ZeroPrice();
        listings[tokenId].price = price;
        emit PriceUpdated(tokenId, msg.sender, price);
    }

    function cancel(uint256 tokenId) external {
        if (listings[tokenId].seller != msg.sender) revert NotListed();
        delete listings[tokenId];
        emit Cancelled(tokenId, msg.sender);
    }

    // ---- buying ----

    /// @notice Buy a listed piece. Pulls `price` of `pay` from the buyer,
    /// splitting off the fee to feeRecipient, then moves the piece seller ->
    /// buyer. Reverts if the buyer has not approved this contract for `pay`
    /// or does not hold enough, since safeTransferFrom bubbles that revert.
    function buy(uint256 tokenId) external nonReentrant {
        Listing memory l = listings[tokenId];
        if (l.seller == address(0)) revert NotListed();
        if (msg.sender == l.seller) revert SelfBuy();
        if (art.ownerOf(tokenId) != l.seller || !_approved(tokenId, l.seller)) revert StaleListing();

        delete listings[tokenId];

        uint256 fee = (l.price * feeBps) / BPS;
        uint256 sellerProceeds = l.price - fee;

        pay.safeTransferFrom(msg.sender, l.seller, sellerProceeds);
        if (fee > 0) pay.safeTransferFrom(msg.sender, feeRecipient, fee);
        art.safeTransferFrom(l.seller, msg.sender, tokenId);

        emit Sold(tokenId, l.seller, msg.sender, l.price, fee);
    }

    // ---- views ----

    function priceOf(uint256 tokenId) external view returns (uint256) {
        return listings[tokenId].price;
    }

    function isListingValid(uint256 tokenId) public view returns (bool) {
        Listing memory l = listings[tokenId];
        if (l.seller == address(0) || l.price == 0) return false;
        return art.ownerOf(tokenId) == l.seller && _approved(tokenId, l.seller);
    }

    /// @notice Batch read for the frontend: sellers, prices, and validity
    /// for every id in `ids`, in one call.
    function listingsMany(uint256[] calldata ids)
        external
        view
        returns (address[] memory sellers, uint256[] memory prices, bool[] memory valid)
    {
        sellers = new address[](ids.length);
        prices = new uint256[](ids.length);
        valid = new bool[](ids.length);
        for (uint256 i = 0; i < ids.length; i++) {
            Listing memory l = listings[ids[i]];
            sellers[i] = l.seller;
            prices[i] = l.price;
            valid[i] = isListingValid(ids[i]);
        }
    }

    // ---- admin ----

    /// @dev No withdraw function: the market never custodies a piece and
    /// never holds `pay` beyond the transient transferFrom calls in buy(),
    /// so there is nothing here for an owner to withdraw.
    function setFee(uint16 bps, address recipient) external onlyOwner {
        if (bps > MAX_FEE_BPS) revert FeeTooHigh();
        if (recipient == address(0)) revert InvalidConfig();
        feeBps = bps;
        feeRecipient = recipient;
        emit FeeChanged(bps, recipient);
    }

    // ---- internals ----

    function _approved(uint256 tokenId, address owner_) internal view returns (bool) {
        return art.getApproved(tokenId) == address(this) || art.isApprovedForAll(owner_, address(this));
    }
}
