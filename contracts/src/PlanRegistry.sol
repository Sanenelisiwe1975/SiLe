// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// @title PlanRegistry
/// @notice Merchants publish billing plans. Terms are immutable: changing them means a new plan
///         that points at its predecessor. Holds no funds.
contract PlanRegistry {
    /// Packed into two slots (storage writes cost 250k gas on Tempo).
    struct Plan {
        address merchant; // slot 0
        uint64 period; // seconds
        bool active;
        address token; // slot 1 (TIP-20)
        uint96 amount; // base units per period
    }

    uint64 public planCount;
    mapping(uint64 planId => Plan) internal _plans;

    event PlanCreated(
        uint64 indexed planId,
        address indexed merchant,
        address indexed token,
        uint96 amount,
        uint64 period,
        uint64 previousPlanId,
        string metadataURI
    );
    event PlanDeactivated(uint64 indexed planId);

    error InvalidTerms();
    error NotMerchant();
    error UnknownPlan();

    /// @param previousPlanId 0 for a new plan, or an existing plan of the caller that this one supersedes.
    function createPlan(address token, uint96 amount, uint64 period, string calldata metadataURI, uint64 previousPlanId)
        external
        returns (uint64 planId)
    {
        if (token == address(0) || amount == 0 || period == 0) revert InvalidTerms();
        if (previousPlanId != 0 && _plans[previousPlanId].merchant != msg.sender) revert NotMerchant();

        planId = ++planCount;
        _plans[planId] = Plan({merchant: msg.sender, period: period, active: true, token: token, amount: amount});
        emit PlanCreated(planId, msg.sender, token, amount, period, previousPlanId, metadataURI);
    }

    /// @notice Stops new subscriptions. Existing subscriptions keep their terms.
    function deactivate(uint64 planId) external {
        Plan storage p = _plans[planId];
        if (p.merchant == address(0)) revert UnknownPlan();
        if (p.merchant != msg.sender) revert NotMerchant();
        p.active = false;
        emit PlanDeactivated(planId);
    }

    function getPlan(uint64 planId) external view returns (Plan memory p) {
        p = _plans[planId];
        if (p.merchant == address(0)) revert UnknownPlan();
    }
}
