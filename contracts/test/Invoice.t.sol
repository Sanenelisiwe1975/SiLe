// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Invoice} from "../src/libs/Invoice.sol";

contract InvoiceHarness {
    function decode(bytes32 memo) external pure returns (uint64, uint32, bytes12) {
        return Invoice.decode(memo);
    }
}

contract InvoiceTest is Test {
    InvoiceHarness h = new InvoiceHarness();

    /// Shared vectors are generated independently with viem; the TS codec is tested against the same file.
    function test_sharedVectors() public view {
        string memory json = vm.readFile("../packages/shared/vectors/invoice.json");
        assertEq(bytes4(vm.parseJsonBytes(json, ".magic")), Invoice.MAGIC);
        uint256 n;
        for (uint256 i; vm.keyExistsJson(json, string.concat(".cases[", vm.toString(i), "]")); ++i) {
            string memory p = string.concat(".cases[", vm.toString(i), "]");
            uint256 chainId = vm.parseJsonUint(json, string.concat(p, ".chainId"));
            address ledger = vm.parseJsonAddress(json, string.concat(p, ".ledger"));
            uint64 subId = uint64(vm.parseJsonUint(json, string.concat(p, ".subId")));
            uint32 seq = uint32(vm.parseJsonUint(json, string.concat(p, ".seq")));
            bytes12 tag = bytes12(vm.parseJsonBytes(json, string.concat(p, ".deploymentTag")));
            bytes32 memo = vm.parseJsonBytes32(json, string.concat(p, ".memo"));

            assertEq(Invoice.deploymentTag(chainId, ledger), tag, "tag");
            assertEq(Invoice.encode(chainId, ledger, subId, seq), memo, "encode");
            (uint64 s, uint32 q, bytes12 t) = h.decode(memo);
            assertEq(s, subId);
            assertEq(q, seq);
            assertEq(t, tag);
            ++n;
        }
        assertGt(n, 0, "no vectors");
    }

    function testFuzz_roundtrip(bytes12 tag, uint64 subId, uint32 seq) public view {
        (uint64 s, uint32 q, bytes12 t) = h.decode(Invoice.encode(tag, subId, seq));
        assertEq(s, subId);
        assertEq(q, seq);
        assertEq(t, tag);
    }

    function test_rejectsBadMagic() public {
        bytes32 memo = Invoice.encode(bytes12(0), 1, 0);
        vm.expectRevert(Invoice.InvalidMemo.selector);
        h.decode(memo ^ bytes32(uint256(1) << 255));
    }

    function test_rejectsBadVersion() public {
        bytes32 memo = Invoice.encode(bytes12(0), 1, 0);
        vm.expectRevert(Invoice.InvalidMemo.selector);
        h.decode(memo ^ bytes32(uint256(3) << 216)); // byte 4
    }

    function test_rejectsNonZeroReserved() public {
        bytes32 memo = Invoice.encode(bytes12(0), 1, 0);
        vm.expectRevert(Invoice.InvalidMemo.selector);
        h.decode(memo | bytes32(uint256(1) << 192)); // byte 7
    }
}
