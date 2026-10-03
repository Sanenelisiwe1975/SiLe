// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {IAccountKeychain} from "../../src/interfaces/IAccountKeychain.sol";

/// @dev Test double for the keychain precompile's view functions.
contract MockKeychain is IAccountKeychain {
    mapping(address account => mapping(address keyId => KeyInfo)) internal _keys;
    mapping(address account => mapping(address keyId => mapping(address token => uint256))) internal _remaining;

    function setKey(address account, address keyId, uint64 expiry, bool enforceLimits, bool isRevoked) external {
        _keys[account][keyId] = KeyInfo(SignatureType.P256, keyId, expiry, enforceLimits, isRevoked);
    }

    function setRemaining(address account, address keyId, address token, uint256 remaining) external {
        _remaining[account][keyId][token] = remaining;
    }

    function getKey(address account, address keyId) external view returns (KeyInfo memory) {
        return _keys[account][keyId];
    }

    function getRemainingLimitWithPeriod(address account, address keyId, address token)
        external
        view
        returns (uint256, uint64)
    {
        return (_remaining[account][keyId][token], 0);
    }
}
