// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {PlanRegistry} from "./PlanRegistry.sol";
import {IAccountKeychain} from "./interfaces/IAccountKeychain.sol";
import {Invoice} from "./libs/Invoice.sol";

/// @title SubscriptionLedger
/// @notice Bookkeeping for SiLe subscriptions. It NEVER moves funds: charges are direct TIP-20
///         `transferWithMemo` calls signed by the subscription's access key, so the protocol's
///         periodic spending limit (TIP-1011) applies. This contract only records the outcome.
contract SubscriptionLedger is AccessControl {
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");

    enum Status {
        None,
        Active,
        PastDue,
        Canceled
    }

    /// Packed into two slots.
    struct Subscription {
        address subscriber; // slot 0
        uint64 planId;
        Status status;
        address accessKey; // slot 1: keychain key id (NOT the P256 account's .address)
        uint32 invoicesPaid; // next invoice sequence number to be paid
        uint64 lastPaidAt;
    }

    PlanRegistry public immutable registry;
    IAccountKeychain public immutable keychain;
    bytes12 public immutable deploymentTag;

    uint64 public subscriptionCount;
    mapping(uint64 subId => Subscription) internal _subs;

    event Subscribed(uint64 indexed subId, uint64 indexed planId, address indexed subscriber, address accessKey);
    event Paid(uint64 indexed subId, bytes32 indexed invoiceId, uint32 seq, bytes32 txHash);
    event StatusChanged(uint64 indexed subId, Status status);

    error PlanInactive();
    error KeyInvalid();
    error KeyExpiresTooSoon();
    error KeyLimitTooLow();
    error UnknownSubscription();
    error BadStatus(Status current);
    error NotAuthorized();
    error InvoiceMismatch();

    constructor(PlanRegistry registry_, IAccountKeychain keychain_, address admin) {
        registry = registry_;
        keychain = keychain_;
        deploymentTag = Invoice.deploymentTag(block.chainid, address(this));
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // ---------------------------------------------------------------- subscriber

    /// @notice Record a subscription for `msg.sender`. Must be called after (or in the same tx as)
    ///         authorising `accessKey` on the keychain. The key is checked on-chain so the ledger only
    ///         records subscriptions the chain can actually bill.
    function subscribe(uint64 planId, address accessKey) external returns (uint64 subId) {
        PlanRegistry.Plan memory plan = registry.getPlan(planId);
        if (!plan.active) revert PlanInactive();

        IAccountKeychain.KeyInfo memory key = keychain.getKey(msg.sender, accessKey);
        if (accessKey == address(0) || key.keyId != accessKey || key.isRevoked || !key.enforceLimits) {
            revert KeyInvalid();
        }
        if (key.expiry <= block.timestamp + plan.period) revert KeyExpiresTooSoon();
        (uint256 remaining,) = keychain.getRemainingLimitWithPeriod(msg.sender, accessKey, plan.token);
        if (remaining < plan.amount) revert KeyLimitTooLow();

        subId = ++subscriptionCount;
        _subs[subId] = Subscription({
            subscriber: msg.sender,
            planId: planId,
            status: Status.Active,
            accessKey: accessKey,
            invoicesPaid: 0,
            lastPaidAt: 0
        });
        emit Subscribed(subId, planId, msg.sender, accessKey);
    }

    /// @notice Subscriber or plan merchant may cancel. (Revoking the key is what actually stops payment.)
    function cancel(uint64 subId) external {
        Subscription storage s = _get(subId);
        if (msg.sender != s.subscriber && msg.sender != registry.getPlan(s.planId).merchant) revert NotAuthorized();
        _setStatus(subId, s, Status.Canceled);
    }

    // ---------------------------------------------------------------- operator

    /// @notice Record a successful charge. `invoiceId` must be the memo for the next sequence number.
    function markPaid(uint64 subId, bytes32 invoiceId, bytes32 txHash) external onlyRole(OPERATOR_ROLE) {
        Subscription storage s = _get(subId);
        if (s.status != Status.Active && s.status != Status.PastDue) revert BadStatus(s.status);
        (uint64 memoSub, uint32 seq, bytes12 tag) = Invoice.decode(invoiceId);
        if (memoSub != subId || tag != deploymentTag || seq != s.invoicesPaid) revert InvoiceMismatch();

        s.invoicesPaid = seq + 1;
        s.lastPaidAt = uint64(block.timestamp);
        emit Paid(subId, invoiceId, seq, txHash);
        if (s.status == Status.PastDue) _setStatus(subId, s, Status.Active);
    }

    function markPastDue(uint64 subId) external onlyRole(OPERATOR_ROLE) {
        Subscription storage s = _get(subId);
        if (s.status != Status.Active) revert BadStatus(s.status);
        _setStatus(subId, s, Status.PastDue);
    }

    function markCanceled(uint64 subId) external onlyRole(OPERATOR_ROLE) {
        _setStatus(subId, _get(subId), Status.Canceled);
    }

    // ---------------------------------------------------------------- views

    function getSubscription(uint64 subId) external view returns (Subscription memory) {
        return _get(subId);
    }

    /// @notice The memo the charger must use for this subscription's next invoice.
    function nextInvoiceId(uint64 subId) external view returns (bytes32) {
        return Invoice.encode(deploymentTag, subId, _get(subId).invoicesPaid);
    }

    // ---------------------------------------------------------------- internal

    function _get(uint64 subId) internal view returns (Subscription storage s) {
        s = _subs[subId];
        if (s.status == Status.None) revert UnknownSubscription();
    }

    function _setStatus(uint64 subId, Subscription storage s, Status next) internal {
        if (s.status == Status.Canceled) revert BadStatus(s.status);
        s.status = next;
        emit StatusChanged(subId, next);
    }
}
