// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {PlanRegistry} from "../src/PlanRegistry.sol";
import {SubscriptionLedger} from "../src/SubscriptionLedger.sol";
import {Invoice} from "../src/libs/Invoice.sol";
import {MockKeychain} from "./mocks/MockKeychain.sol";

contract SubscriptionLedgerTest is Test {
    PlanRegistry reg;
    MockKeychain kc;
    SubscriptionLedger ledger;

    address admin = makeAddr("admin");
    address operator = makeAddr("operator");
    address merchant = makeAddr("merchant");
    address subscriber = makeAddr("subscriber");
    address key = makeAddr("key");
    address token = makeAddr("token");

    uint96 constant AMOUNT = 10e6;
    uint64 constant PERIOD = 60;
    uint64 planId;

    function setUp() public {
        vm.warp(1_800_000_000);
        reg = new PlanRegistry();
        kc = new MockKeychain();
        ledger = new SubscriptionLedger(reg, kc, admin);
        bytes32 operatorRole = ledger.OPERATOR_ROLE();
        vm.prank(admin);
        ledger.grantRole(operatorRole, operator);

        vm.prank(merchant);
        planId = reg.createPlan(token, AMOUNT, PERIOD, "", 0);
        _goodKey();
    }

    function _goodKey() internal {
        kc.setKey(subscriber, key, uint64(block.timestamp + 365 days), true, false);
        kc.setRemaining(subscriber, key, token, AMOUNT);
    }

    function _subscribe() internal returns (uint64) {
        vm.prank(subscriber);
        return ledger.subscribe(planId, key);
    }

    function _memo(uint64 subId, uint32 seq) internal view returns (bytes32) {
        return Invoice.encode(block.chainid, address(ledger), subId, seq);
    }

    // ------------------------------------------------------------ subscribe

    function test_subscribe() public {
        vm.expectEmit(address(ledger));
        emit SubscriptionLedger.Subscribed(1, planId, subscriber, key);
        uint64 id = _subscribe();

        SubscriptionLedger.Subscription memory s = ledger.getSubscription(id);
        assertEq(s.subscriber, subscriber);
        assertEq(s.planId, planId);
        assertEq(s.accessKey, key);
        assertEq(uint8(s.status), uint8(SubscriptionLedger.Status.Active));
        assertEq(s.invoicesPaid, 0);
        assertEq(ledger.nextInvoiceId(id), _memo(id, 0));
    }

    function test_subscribe_rejectsInactivePlan() public {
        vm.prank(merchant);
        reg.deactivate(planId);
        vm.expectRevert(SubscriptionLedger.PlanInactive.selector);
        _subscribe();
    }

    function test_subscribe_rejectsMissingKey() public {
        vm.prank(subscriber);
        vm.expectRevert(SubscriptionLedger.KeyInvalid.selector);
        ledger.subscribe(planId, makeAddr("other"));
    }

    function test_subscribe_rejectsKeyOfAnotherAccount() public {
        vm.prank(makeAddr("mallory"));
        vm.expectRevert(SubscriptionLedger.KeyInvalid.selector);
        ledger.subscribe(planId, key);
    }

    function test_subscribe_rejectsRevokedKey() public {
        kc.setKey(subscriber, key, uint64(block.timestamp + 365 days), true, true);
        vm.expectRevert(SubscriptionLedger.KeyInvalid.selector);
        _subscribe();
    }

    function test_subscribe_rejectsUnlimitedKey() public {
        kc.setKey(subscriber, key, uint64(block.timestamp + 365 days), false, false);
        vm.expectRevert(SubscriptionLedger.KeyInvalid.selector);
        _subscribe();
    }

    function test_subscribe_rejectsShortExpiry() public {
        kc.setKey(subscriber, key, uint64(block.timestamp + PERIOD), true, false);
        vm.expectRevert(SubscriptionLedger.KeyExpiresTooSoon.selector);
        _subscribe();
    }

    function test_subscribe_rejectsLowLimit() public {
        kc.setRemaining(subscriber, key, token, AMOUNT - 1);
        vm.expectRevert(SubscriptionLedger.KeyLimitTooLow.selector);
        _subscribe();
    }

    // ------------------------------------------------------------ markPaid

    function test_markPaid_sequential() public {
        uint64 id = _subscribe();
        bytes32 m0 = _memo(id, 0);

        vm.expectEmit(address(ledger));
        emit SubscriptionLedger.Paid(id, m0, 0, bytes32("tx0"));
        vm.prank(operator);
        ledger.markPaid(id, m0, bytes32("tx0"));

        // replaying the same invoice is rejected (idempotency lives in the memo sequence)
        vm.prank(operator);
        vm.expectRevert(SubscriptionLedger.InvoiceMismatch.selector);
        ledger.markPaid(id, m0, bytes32("tx0"));

        vm.prank(operator);
        ledger.markPaid(id, _memo(id, 1), bytes32("tx1"));
        SubscriptionLedger.Subscription memory s = ledger.getSubscription(id);
        assertEq(s.invoicesPaid, 2);
        assertEq(s.lastPaidAt, block.timestamp);
        assertEq(ledger.nextInvoiceId(id), _memo(id, 2));
    }

    function test_markPaid_rejectsForeignMemo() public {
        uint64 id = _subscribe();
        vm.startPrank(operator);
        vm.expectRevert(SubscriptionLedger.InvoiceMismatch.selector);
        ledger.markPaid(id, Invoice.encode(block.chainid, address(0xBEEF), id, 0), 0); // other deployment
        vm.expectRevert(SubscriptionLedger.InvoiceMismatch.selector);
        ledger.markPaid(id, _memo(id + 1, 0), 0); // other subscription
        vm.expectRevert(SubscriptionLedger.InvoiceMismatch.selector);
        ledger.markPaid(id, _memo(id, 1), 0); // skipped sequence
        vm.expectRevert(Invoice.InvalidMemo.selector);
        ledger.markPaid(id, bytes32("not a sile memo"), 0);
        vm.stopPrank();
    }

    function test_operatorOnly() public {
        uint64 id = _subscribe();
        bytes32 role = ledger.OPERATOR_ROLE();
        bytes memory err = abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, merchant, role);
        vm.startPrank(merchant);
        vm.expectRevert(err);
        ledger.markPaid(id, _memo(id, 0), 0);
        vm.expectRevert(err);
        ledger.markPastDue(id);
        vm.expectRevert(err);
        ledger.markCanceled(id);
        vm.stopPrank();
    }

    // ------------------------------------------------------------ lifecycle

    function test_pastDueThenRecovers() public {
        uint64 id = _subscribe();
        vm.prank(operator);
        ledger.markPastDue(id);
        assertEq(uint8(ledger.getSubscription(id).status), uint8(SubscriptionLedger.Status.PastDue));

        vm.expectEmit(address(ledger));
        emit SubscriptionLedger.StatusChanged(id, SubscriptionLedger.Status.Active);
        vm.prank(operator);
        ledger.markPaid(id, _memo(id, 0), 0);
        assertEq(uint8(ledger.getSubscription(id).status), uint8(SubscriptionLedger.Status.Active));
    }

    function test_pastDueThenCanceled_isTerminal() public {
        uint64 id = _subscribe();
        vm.startPrank(operator);
        ledger.markPastDue(id);
        ledger.markCanceled(id);
        vm.expectRevert(
            abi.encodeWithSelector(SubscriptionLedger.BadStatus.selector, SubscriptionLedger.Status.Canceled)
        );
        ledger.markPaid(id, _memo(id, 0), 0);
        vm.expectRevert(
            abi.encodeWithSelector(SubscriptionLedger.BadStatus.selector, SubscriptionLedger.Status.Canceled)
        );
        ledger.markCanceled(id);
        vm.stopPrank();
    }

    function test_cancelBySubscriberOrMerchantOnly() public {
        uint64 a = _subscribe();
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(SubscriptionLedger.NotAuthorized.selector);
        ledger.cancel(a);

        vm.prank(subscriber);
        ledger.cancel(a);
        assertEq(uint8(ledger.getSubscription(a).status), uint8(SubscriptionLedger.Status.Canceled));

        uint64 b = _subscribe();
        vm.prank(merchant);
        ledger.cancel(b);
        assertEq(uint8(ledger.getSubscription(b).status), uint8(SubscriptionLedger.Status.Canceled));
    }

    function test_unknownSubscription() public {
        vm.expectRevert(SubscriptionLedger.UnknownSubscription.selector);
        ledger.getSubscription(99);
    }
}
