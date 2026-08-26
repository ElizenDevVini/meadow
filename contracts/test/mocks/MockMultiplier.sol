// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IMeadowMultiplier} from "../../src/MeadowArt.sol";

/// @notice Settable multiplier source for testing MeadowArt.multiplier(),
/// including the try/catch fallback when the source reverts.
contract MockMultiplier is IMeadowMultiplier {
    uint256 public wad = 1e18;
    bool public shouldRevert;

    function set(uint256 wad_) external {
        wad = wad_;
    }

    function setShouldRevert(bool value) external {
        shouldRevert = value;
    }

    function multiplierWad() external view returns (uint256) {
        if (shouldRevert) revert("mock multiplier revert");
        return wad;
    }
}
