// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MeadowArt} from "../src/MeadowArt.sol";

/// @notice Deploys MeadowArt. Per-work economics (price, assigned stock
/// index, reward rate) come from tools/gen_art_onchain.py's output at
/// art/data/onchain.json, which is deterministic given the catalog. Real
/// addresses and the reward deadline are operator-supplied at broadcast
/// time via env vars -- nothing here is hardcoded, and there is no private
/// key in this file; forge script picks the signer up from --private-key,
/// --ledger, or an unlocked --sender.
///
/// Required env vars:
///   PROJECT_TOKEN  address of the ERC20 pieces are priced and paid in
///   STOCKS         comma-separated addresses, in onchain.json's stock order
///   REWARD_END     unix timestamp when streaming rewards stop accruing
///   OWNER          address that receives Ownable2Step ownership
contract DeployMeadowArt is Script {
    string internal constant ONCHAIN_JSON_PATH = "../art/data/onchain.json";

    function run() external {
        require(
            block.chainid == 4663 || block.chainid == 31337,
            "wrong chain: expected robinhood chain mainnet (4663) or local anvil (31337)"
        );

        address projectToken = vm.envAddress("PROJECT_TOKEN");
        address[] memory stocks = vm.envAddress("STOCKS", ",");
        uint256 rewardEndRaw = vm.envUint("REWARD_END");
        address owner = vm.envAddress("OWNER");

        require(projectToken.code.length > 0, "PROJECT_TOKEN has no code: deploy or fund the project token first");
        require(stocks.length > 0, "STOCKS must be a non-empty comma-separated address list");
        require(rewardEndRaw <= type(uint64).max, "REWARD_END overflows uint64, pass a unix timestamp in seconds");
        require(rewardEndRaw > block.timestamp, "REWARD_END must be in the future");
        require(owner != address(0), "OWNER must not be the zero address");

        (uint256[] memory prices, uint8[] memory stockIdx, uint256[] memory rates) = _readOnchainJson(stocks.length);

        IERC20[] memory stockTokens = new IERC20[](stocks.length);
        for (uint256 i = 0; i < stocks.length; i++) {
            require(stocks[i].code.length > 0, "a STOCKS entry has no code");
            stockTokens[i] = IERC20(stocks[i]);
        }

        vm.startBroadcast();
        // rewardEndRaw was checked against type(uint64).max above.
        // forge-lint: disable-next-line(unsafe-typecast)
        MeadowArt art = new MeadowArt(
            IERC20(projectToken), stockTokens, prices, stockIdx, rates, uint64(rewardEndRaw), owner
        );
        vm.stopBroadcast();

        console.log("MeadowArt:", address(art));
        console.log("Owner:", owner);
        console.log("Pieces:", prices.length);
        console.log("Reward end:", rewardEndRaw);
    }

    uint256 internal constant MAX_WORKS = 1000;

    /// @dev Reads the works array written by tools/gen_art_onchain.py.
    /// Parses per-index (rather than a jsonpath wildcard/array query, which
    /// this forge-std version does not support on JSON arrays) and finds the
    /// array length by probing ids with try/catch until one is out of range.
    function _readOnchainJson(uint256 stockCount)
        internal
        returns (uint256[] memory prices, uint8[] memory stockIdx, uint256[] memory rates)
    {
        string memory json = vm.readFile(ONCHAIN_JSON_PATH);

        uint256 n = 0;
        while (n < MAX_WORKS) {
            try vm.parseJsonUint(json, string.concat(".works[", vm.toString(n), "].id")) returns (uint256) {
                n++;
            } catch {
                break;
            }
        }
        require(n > 0, "onchain.json has no works: run tools/gen_art_onchain.py first");
        require(n < MAX_WORKS, "onchain.json has an implausible number of works, check the file");

        prices = new uint256[](n);
        stockIdx = new uint8[](n);
        rates = new uint256[](n);

        for (uint256 i = 0; i < n; i++) {
            string memory base = string.concat(".works[", vm.toString(i), "]");
            uint256 id = vm.parseJsonUint(json, string.concat(base, ".id"));
            require(id == i, "onchain.json works array is not ordered by ascending id");

            prices[i] = vm.parseJsonUint(json, string.concat(base, ".price_wei"));
            require(prices[i] > 0, "onchain.json has a zero price_wei entry");

            uint256 idx = vm.parseJsonUint(json, string.concat(base, ".stock_idx"));
            require(idx < stockCount, "onchain.json stock_idx is out of range for STOCKS");
            // idx was just checked against stockCount, which fits uint8 (5 stocks).
            // forge-lint: disable-next-line(unsafe-typecast)
            stockIdx[i] = uint8(idx);

            rates[i] = vm.parseJsonUint(json, string.concat(base, ".rate_wei"));
        }
    }
}
