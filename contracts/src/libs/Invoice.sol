// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// @title Invoice memo codec
/// @notice An invoice id IS the 32-byte TIP-20 transfer memo. Layout (big-endian, 32 bytes):
///   [0..4)   bytes4  magic "SiLe" (0x53694c65)
///   [4]      uint8   version (1)
///   [5..8)   bytes3  reserved (zero)
///   [8..16)  uint64  subscription id
///   [16..20) uint32  invoice sequence number (0 = first charge; retries reuse the same number)
///   [20..32) bytes12 deployment tag = bytes12(keccak256(abi.encode(chainId, ledger)))
/// Mirrored by the TS memo codec in packages/shared; both are tested against packages/shared/vectors/invoice.json.
library Invoice {
    bytes4 internal constant MAGIC = 0x53694c65; // "SiLe"
    uint8 internal constant VERSION = 1;

    error InvalidMemo();

    function deploymentTag(uint256 chainId, address ledger) internal pure returns (bytes12) {
        return bytes12(keccak256(abi.encode(chainId, ledger)));
    }

    function encode(bytes12 tag, uint64 subId, uint32 seq) internal pure returns (bytes32) {
        return bytes32(abi.encodePacked(MAGIC, VERSION, bytes3(0), subId, seq, tag));
    }

    function encode(uint256 chainId, address ledger, uint64 subId, uint32 seq) internal pure returns (bytes32) {
        return encode(deploymentTag(chainId, ledger), subId, seq);
    }

    /// @dev Reverts with InvalidMemo unless magic, version and reserved bytes are canonical.
    function decode(bytes32 memo) internal pure returns (uint64 subId, uint32 seq, bytes12 tag) {
        if (bytes4(memo) != MAGIC || uint8(memo[4]) != VERSION) revert InvalidMemo();
        if (memo[5] != 0 || memo[6] != 0 || memo[7] != 0) revert InvalidMemo();
        uint256 v = uint256(memo);
        subId = uint64(v >> 128);
        seq = uint32(v >> 96);
        tag = bytes12(memo << 160);
    }
}
