// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Optional external scaling factor for reward rates (e.g. a future
/// art-market-index oracle). Not wired to anything at launch: multiplier()
/// returns 1x until an owner opts into a source.
interface IMeadowMultiplier {
    function multiplierWad() external view returns (uint256);
}

/// @title MeadowArtV2
/// @notice Second Meadow art-NFT collection. Same mechanics as MeadowArt
/// (ERC-721 pieces bought with a project token, streaming rewards paid in an
/// assigned Robinhood Stock Token) plus a permanent one-piece-per-wallet
/// primary-sale cap and a settable base URI so this collection displays on
/// marketplaces out of the box.
contract MeadowArtV2 is ERC721, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant WAD = 1e18;
    uint256 public constant MIN_MULT = 1e17; // 0.1x floor
    uint256 public constant MAX_MULT = 10e18; // 10x ceiling
    uint256 public constant MAX_RATE = 1e18; // 1 whole stock token/second ceiling; real rates are ~1e12-1e13
    uint256 public constant MAX_BATCH = 64;
    uint256 public constant MIN_REWARD_DURATION = 30 days;
    uint256 public constant MAX_REWARD_DURATION = 1095 days;

    /// @notice Number of pieces (token ids 0..N-1), fixed at deploy time to match the catalog.
    uint256 public immutable N;
    IERC20 public immutable projectToken;
    uint64 public immutable rewardEnd;

    IERC20[] private _stocks;
    uint256[] private _prices;
    uint8[] private _stockIdx;
    uint256[] private _rates;

    mapping(uint256 => uint64) public lastClaim;
    address public multiplierSource;

    /// @notice Tracks whether a wallet has ever bought a piece from the
    /// primary sale. Permanent: it is never cleared, including after the
    /// wallet sells or transfers its piece away, so it stays a one-per-wallet
    /// cap on buy() rather than a one-piece-at-a-time balance check.
    mapping(address => bool) public hasMinted;

    string private _base;

    event Bought(uint256 indexed id, address indexed buyer, uint256 price);
    event Claimed(uint256 indexed id, address indexed to, address indexed stock, uint256 paid);
    event MultiplierSourceSet(address indexed src);
    event ProceedsWithdrawn(address indexed to, uint256 amount);
    event StockWithdrawn(uint8 indexed idx, address indexed to, uint256 amount);
    event BaseURISet(string base);

    error InvalidConfig();
    error InvalidPiece();
    error AlreadyMinted();
    error ProgramEnded();
    error NotMinted();
    error NotPieceOwner();
    error BatchTooLarge();
    error AlreadySet();

    constructor(
        IERC20 projectToken_,
        IERC20[] memory stocks_,
        uint256[] memory prices_,
        uint8[] memory stockIdx_,
        uint256[] memory rates_,
        uint64 rewardEnd_,
        address owner_,
        string memory baseURI_
    ) ERC721("meadow art v2", "PIECE2") Ownable(owner_) {
        uint256 n = prices_.length;
        if (n == 0 || stockIdx_.length != n || rates_.length != n) revert InvalidConfig();
        if (stocks_.length == 0) revert InvalidConfig();
        if (address(projectToken_) == address(0) || address(projectToken_).code.length == 0) revert InvalidConfig();
        if (IERC20Metadata(address(projectToken_)).decimals() != 18) revert InvalidConfig();
        if (rewardEnd_ < block.timestamp + MIN_REWARD_DURATION || rewardEnd_ > block.timestamp + MAX_REWARD_DURATION)
        {
            revert InvalidConfig();
        }

        for (uint256 i = 0; i < stocks_.length; i++) {
            address s = address(stocks_[i]);
            if (s == address(0) || s.code.length == 0) revert InvalidConfig();
            if (IERC20Metadata(s).decimals() != 18) revert InvalidConfig();
        }

        for (uint256 i = 0; i < n; i++) {
            if (prices_[i] == 0) revert InvalidConfig();
            if (stockIdx_[i] >= stocks_.length) revert InvalidConfig();
            if (rates_[i] > MAX_RATE) revert InvalidConfig();
        }

        N = n;
        projectToken = projectToken_;
        _stocks = stocks_;
        _prices = prices_;
        _stockIdx = stockIdx_;
        _rates = rates_;
        rewardEnd = rewardEnd_;

        // Set at deploy so the owner (a Safe) never has to send a separate
        // setBaseURI transaction before marketplaces can render the pieces.
        if (bytes(baseURI_).length != 0) {
            _base = baseURI_;
            emit BaseURISet(baseURI_);
        }
    }

    // ---- piece attributes ----

    function priceOf(uint256 id) public view returns (uint256) {
        if (id >= N) revert InvalidPiece();
        return _prices[id];
    }

    function stockOf(uint256 id) public view returns (IERC20) {
        if (id >= N) revert InvalidPiece();
        return _stocks[_stockIdx[id]];
    }

    function rateOf(uint256 id) public view returns (uint256) {
        if (id >= N) revert InvalidPiece();
        return _rates[id];
    }

    function stockCount() external view returns (uint256) {
        return _stocks.length;
    }

    function stockAt(uint256 idx) external view returns (IERC20) {
        if (idx >= _stocks.length) revert InvalidConfig();
        return _stocks[idx];
    }

    // ---- metadata ----

    function setBaseURI(string calldata base) external onlyOwner {
        _base = base;
        emit BaseURISet(base);
    }

    function _baseURI() internal view override returns (string memory) {
        return _base;
    }

    /// @notice OpenSea-style collection-level metadata pointer. Empty until
    /// the owner sets a base URI; the metadata host is expected to serve a
    /// collection.json alongside the per-token files at that base.
    function contractURI() external view returns (string memory) {
        if (bytes(_base).length == 0) return "";
        return string.concat(_base, "collection.json");
    }

    // ---- multiplier (inert until an owner opts in) ----

    function multiplier() public view returns (uint256) {
        if (multiplierSource == address(0)) return WAD;
        try IMeadowMultiplier(multiplierSource).multiplierWad() returns (uint256 wad) {
            if (wad < MIN_MULT) return MIN_MULT;
            if (wad > MAX_MULT) return MAX_MULT;
            return wad;
        } catch {
            return WAD;
        }
    }

    /// @notice One-shot: once a multiplier source is set it cannot be changed,
    /// so a future oracle cannot be swapped out from under existing holders.
    function setMultiplierSource(address src) external onlyOwner {
        if (src == address(0)) revert InvalidConfig();
        if (multiplierSource != address(0)) revert AlreadySet();
        multiplierSource = src;
        emit MultiplierSourceSet(src);
    }

    // ---- buy / claim ----

    /// @notice Each wallet may buy at most one piece from the primary sale,
    /// ever, even after selling and returning to a zero balance. Secondary
    /// transfers are not restricted by hasMinted, only this function is.
    function buy(uint256 id) external nonReentrant {
        if (id >= N) revert InvalidPiece();
        if (hasMinted[msg.sender]) revert AlreadyMinted();
        if (_ownerOf(id) != address(0)) revert AlreadyMinted();
        if (block.timestamp >= rewardEnd) revert ProgramEnded();

        uint256 price = _prices[id];
        hasMinted[msg.sender] = true;
        // block.timestamp fits uint64 until the year 2554; safe to truncate.
        // forge-lint: disable-next-line(unsafe-typecast)
        lastClaim[id] = uint64(block.timestamp);
        projectToken.safeTransferFrom(msg.sender, address(this), price);
        _safeMint(msg.sender, id);
        emit Bought(id, msg.sender, price);
    }

    function claimable(uint256 id) public view returns (uint256) {
        if (_ownerOf(id) == address(0)) return 0;
        uint256 end = block.timestamp < rewardEnd ? block.timestamp : rewardEnd;
        uint256 start = lastClaim[id];
        if (end <= start) return 0;
        uint256 raw = _rates[id] * (end - start);
        return Math.mulDiv(raw, multiplier(), WAD);
    }

    function availablePayout(uint256 id) public view returns (uint256) {
        uint256 amount = claimable(id);
        uint256 balance = _stocks[_stockIdx[id]].balanceOf(address(this));
        return amount < balance ? amount : balance;
    }

    function claimableMany(uint256[] calldata ids)
        external
        view
        returns (uint256[] memory claimableAmounts, uint256[] memory availableAmounts)
    {
        if (ids.length > MAX_BATCH) revert BatchTooLarge();
        claimableAmounts = new uint256[](ids.length);
        availableAmounts = new uint256[](ids.length);
        for (uint256 i = 0; i < ids.length; i++) {
            claimableAmounts[i] = claimable(ids[i]);
            availableAmounts[i] = availablePayout(ids[i]);
        }
    }

    function claim(uint256 id) external nonReentrant {
        _claim(id);
    }

    function claimMany(uint256[] calldata ids) external nonReentrant {
        if (ids.length > MAX_BATCH) revert BatchTooLarge();
        for (uint256 i = 0; i < ids.length; i++) {
            _claim(ids[i]);
        }
    }

    /// @dev Best-effort payout: pays whatever the assigned stock's balance
    /// covers and, only when a payout actually happens, advances lastClaim
    /// to min(now, rewardEnd). A dry treasury must leave accrual untouched
    /// (a true no-op) so it can still be claimed once funded -- only a
    /// partial payout forfeits its shortfall, per the no-commitment design.
    function _claim(uint256 id) internal {
        address pieceOwner = _ownerOf(id);
        if (pieceOwner == address(0)) revert NotMinted();
        if (pieceOwner != msg.sender) revert NotPieceOwner();

        uint256 amount = availablePayout(id);
        if (amount == 0) return;

        uint256 end = block.timestamp < rewardEnd ? block.timestamp : rewardEnd;
        // end is bounded by rewardEnd (uint64) or by block.timestamp, which
        // fits uint64 until the year 2554; safe to truncate.
        // forge-lint: disable-next-line(unsafe-typecast)
        lastClaim[id] = uint64(end);

        IERC20 stock = _stocks[_stockIdx[id]];
        stock.safeTransfer(msg.sender, amount);
        emit Claimed(id, msg.sender, address(stock), amount);
    }

    /// @dev Earning follows the piece: a new owner starts accruing from the
    /// transfer timestamp, so the seller should claim before selling.
    function _update(address to, uint256 tokenId, address auth) internal override returns (address from) {
        from = super._update(to, tokenId, auth);
        if (from != address(0) && to != address(0)) {
            lastClaim[tokenId] = uint64(block.timestamp);
        }
    }

    // ---- admin ----

    function withdrawProceeds(address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert InvalidConfig();
        projectToken.safeTransfer(to, amount);
        emit ProceedsWithdrawn(to, amount);
    }

    function withdrawStock(uint8 idx, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert InvalidConfig();
        if (idx >= _stocks.length) revert InvalidConfig();
        _stocks[idx].safeTransfer(to, amount);
        emit StockWithdrawn(idx, to, amount);
    }
}
