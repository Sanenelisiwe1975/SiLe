// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// @notice View subset of Tempo's Account Keychain precompile (0xaAAAaaAA00000000000000000000000000000000).
/// Source: https://tempo.xyz/developers/docs/protocol/transactions/AccountKeychain
interface IAccountKeychain {
    enum SignatureType {
        Secp256k1,
        P256,
        WebAuthn
    }

    struct KeyInfo {
        SignatureType signatureType;
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
}
