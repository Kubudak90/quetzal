// TXE tests for the tUSDC (TokenA) contract.
// Run with: VERSION=4.2.1 aztec test (inside contracts/token-a/)

use crate::TokenA;
use aztec::{
    protocol::address::AztecAddress,
    test::helpers::test_environment::TestEnvironment,
};

// Brand metadata padded to str<31> as required by the constructor.
// "tUSDC" + 26 '0' chars = 31 ASCII chars.
global TUSDC_NAME: str<31> = "tUSDC00000000000000000000000000";
global TUSDC_SYMBOL: str<31> = "tUSDC00000000000000000000000000";
global TUSDC_DECIMALS: u8 = 6;

unconstrained fn deploy_tusdc(
    env: &mut TestEnvironment,
    deployer: AztecAddress,
    minter: AztecAddress,
) -> AztecAddress {
    let initializer_call = TokenA::interface().constructor_with_minter(
        TUSDC_NAME,
        TUSDC_SYMBOL,
        TUSDC_DECIMALS,
        minter,
    );
    env.deploy("@token_a/TokenA").with_public_initializer(deployer, initializer_call)
}

#[test]
unconstrained fn mint_to_private_balance() {
    let mut env = TestEnvironment::new();

    // Two light accounts: admin/minter and a separate account we won't use here.
    let admin = env.create_light_account();
    let _other = env.create_light_account();

    let token_address = deploy_tusdc(&mut env, admin, admin);

    // 1000.000000 tUSDC (6 decimals)
    let mint_amount: u128 = 1_000_000_000;
    env.call_private(admin, TokenA::at(token_address).mint_to_private(admin, mint_amount));

    let balance =
        env.execute_utility(TokenA::at(token_address).balance_of_private(admin));
    assert(balance == mint_amount, "minted private balance mismatch");
}

#[test]
unconstrained fn private_transfer_moves_balance() {
    let mut env = TestEnvironment::new();

    let alice = env.create_light_account();
    let bob = env.create_light_account();

    // Alice is also the minter to keep the setup minimal.
    let token_address = deploy_tusdc(&mut env, alice, alice);

    // Mint 100.000000 tUSDC to Alice.
    let mint_amount: u128 = 100_000_000;
    env.call_private(alice, TokenA::at(token_address).mint_to_private(alice, mint_amount));

    // Transfer 30.000000 tUSDC from Alice to Bob (private -> private).
    let transfer_amount: u128 = 30_000_000;
    env.call_private(
        alice,
        TokenA::at(token_address).transfer_private_to_private(alice, bob, transfer_amount, 0),
    );

    let alice_balance =
        env.execute_utility(TokenA::at(token_address).balance_of_private(alice));
    let bob_balance =
        env.execute_utility(TokenA::at(token_address).balance_of_private(bob));

    assert(alice_balance == mint_amount - transfer_amount, "alice should have 70 tUSDC");
    assert(bob_balance == transfer_amount, "bob should have 30 tUSDC");
}
