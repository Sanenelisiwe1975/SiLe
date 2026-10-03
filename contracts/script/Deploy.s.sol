// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {PlanRegistry} from "../src/PlanRegistry.sol";
import {SubscriptionLedger} from "../src/SubscriptionLedger.sol";
import {IAccountKeychain} from "../src/interfaces/IAccountKeychain.sol";

/// forge script script/Deploy.s.sol --rpc-url moderato --broadcast --tempo.fee-token <USD TIP-20>
/// env: DEPLOYER_PRIVATE_KEY, OPERATOR_ADDRESS
contract Deploy is Script {
    /// Account Keychain precompile. Source: https://tempo.xyz/developers/docs/protocol/transactions/AccountKeychain
    IAccountKeychain constant KEYCHAIN = IAccountKeychain(0xaAAAaaAA00000000000000000000000000000000);

    function run() external returns (PlanRegistry registry, SubscriptionLedger ledger) {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address operator = vm.envAddress("OPERATOR_ADDRESS");
        address admin = vm.addr(pk);

        vm.startBroadcast(pk);
        registry = new PlanRegistry();
        ledger = new SubscriptionLedger(registry, KEYCHAIN, admin);
        ledger.grantRole(ledger.OPERATOR_ROLE(), operator);
        vm.stopBroadcast();

        console.log("PlanRegistry", address(registry));
        console.log("SubscriptionLedger", address(ledger));
        console.log("operator", operator);
    }
}
