// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PlanRegistry} from "../src/PlanRegistry.sol";

contract PlanRegistryTest is Test {
    PlanRegistry reg = new PlanRegistry();
    address merchant = makeAddr("merchant");
    address token = makeAddr("token");

    function test_createPlan() public {
        vm.expectEmit(address(reg));
        emit PlanRegistry.PlanCreated(1, merchant, token, 10e6, 30 days, 0, "ipfs://plan");
        vm.prank(merchant);
        uint64 id = reg.createPlan(token, 10e6, 30 days, "ipfs://plan", 0);

        assertEq(id, 1);
        PlanRegistry.Plan memory p = reg.getPlan(id);
        assertEq(p.merchant, merchant);
        assertEq(p.token, token);
        assertEq(p.amount, 10e6);
        assertEq(p.period, 30 days);
        assertTrue(p.active);
    }

    function test_rejectsInvalidTerms() public {
        vm.expectRevert(PlanRegistry.InvalidTerms.selector);
        reg.createPlan(address(0), 1, 1, "", 0);
        vm.expectRevert(PlanRegistry.InvalidTerms.selector);
        reg.createPlan(token, 0, 1, "", 0);
        vm.expectRevert(PlanRegistry.InvalidTerms.selector);
        reg.createPlan(token, 1, 0, "", 0);
    }

    function test_newVersionOnlyByMerchant() public {
        vm.prank(merchant);
        uint64 v1 = reg.createPlan(token, 10e6, 60, "", 0);

        vm.expectRevert(PlanRegistry.NotMerchant.selector);
        reg.createPlan(token, 20e6, 60, "", v1);

        vm.prank(merchant);
        uint64 v2 = reg.createPlan(token, 20e6, 60, "", v1);
        assertEq(v2, 2);
        assertEq(reg.getPlan(v1).amount, 10e6, "old terms unchanged");
    }

    function test_deactivate() public {
        vm.prank(merchant);
        uint64 id = reg.createPlan(token, 1, 1, "", 0);

        vm.expectRevert(PlanRegistry.NotMerchant.selector);
        reg.deactivate(id);

        vm.prank(merchant);
        reg.deactivate(id);
        assertFalse(reg.getPlan(id).active);
    }

    function test_unknownPlan() public {
        vm.expectRevert(PlanRegistry.UnknownPlan.selector);
        reg.getPlan(7);
        vm.expectRevert(PlanRegistry.UnknownPlan.selector);
        reg.deactivate(7);
    }
}
