// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

interface IKeychainView {
    struct KeyInfo {
        uint8 signatureType;
        address keyId;
        uint64 expiry;
        bool enforceLimits;
        bool isRevoked;
    }

    function getKey(address account, address keyId) external view returns (KeyInfo memory);
    function getRemainingLimitWithPeriod(address account, address keyId, address token)
        external
        view
        returns (uint256 remaining, uint64 periodEnd);
    function getTransactionKey() external view returns (address);
}

/// Spike-only stand-in for SubscriptionLedger.subscribe: proves msg.sender and that a
/// contract can read a key authorised earlier in the same transaction.
contract Probe {
    IKeychainView constant KEYCHAIN = IKeychainView(0xaAAAaaAA00000000000000000000000000000000);

    event Pinged(
        address indexed sender,
        address indexed keyId,
        address txKey,
        uint64 expiry,
        bool enforceLimits,
        bool isRevoked,
        uint256 remaining,
        uint64 periodEnd
    );

    function ping(address keyId, address token) external {
        IKeychainView.KeyInfo memory info = KEYCHAIN.getKey(msg.sender, keyId);
        (uint256 remaining, uint64 periodEnd) = KEYCHAIN.getRemainingLimitWithPeriod(msg.sender, keyId, token);
        emit Pinged(
            msg.sender, keyId, KEYCHAIN.getTransactionKey(), info.expiry, info.enforceLimits, info.isRevoked, remaining, periodEnd
        );
    }
}
