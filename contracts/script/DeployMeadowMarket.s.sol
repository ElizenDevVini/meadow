// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MeadowMarket} from "../src/MeadowMarket.sol";

/// @notice Deploys MeadowMarket. Nothing here is hardcoded; there is no
/// private key in this file -- forge script picks the signer up from
/// --private-key, --ledger, or an unlocked --sender.
///
/// Required env vars:
///   ART           address of the deployed MeadowArt contract
///   PAY           address of the ERC20 the market prices and pays in
///   FEE_BPS       sale fee in bps, must be <= MeadowMarket.MAX_FEE_BPS (1000)
///   FEE_RECIPIENT address that receives the fee cut of each sale
///   OWNER         address that receives Ownable2Step ownership
contract DeployMeadowMarket is Script {
    function run() external {
        require(
            block.chainid == 4663 || block.chainid == 31337,
            "wrong chain: expected robinhood chain mainnet (4663) or local anvil (31337)"
        );

        address artAddr = vm.envAddress("ART");
        address payAddr = vm.envAddress("PAY");
        uint256 feeBpsRaw = vm.envUint("FEE_BPS");
        address feeRecipient = vm.envAddress("FEE_RECIPIENT");
        address owner = vm.envAddress("OWNER");

        require(artAddr.code.length > 0, "ART has no code: deploy MeadowArt first");
        require(payAddr.code.length > 0, "PAY has no code: deploy or fund the payment token first");
        require(feeBpsRaw <= 1000, "FEE_BPS must be <= 1000 (10%, MeadowMarket.MAX_FEE_BPS); lower it and re-run");
        require(feeRecipient != address(0), "FEE_RECIPIENT must not be the zero address");
        require(owner != address(0), "OWNER must not be the zero address");

        // feeBpsRaw was checked against type(uint16).max above.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint16 feeBps = uint16(feeBpsRaw);

        vm.startBroadcast();
        MeadowMarket market = new MeadowMarket(IERC721(artAddr), IERC20(payAddr), feeBps, feeRecipient, owner);
        vm.stopBroadcast();

        console.log("MeadowMarket:", address(market));
        console.log("Art:", artAddr);
        console.log("Pay:", payAddr);
        console.log("Fee bps:", feeBpsRaw);
        console.log("Fee recipient:", feeRecipient);
        console.log("Owner:", owner);
    }
}
