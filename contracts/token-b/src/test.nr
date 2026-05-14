// TXE tests for the tETH (TokenB) contract.
// Run with: VERSION=4.2.1 aztec test (inside contracts/token-b/)

use crate::TokenB;
use aztec::{
    protocol::address::AztecAddress,
    test::helpers::test_environment::TestEnvironment,
};

// Brand metadata padded to str<31> as required by the constructor.
// "tETH" + 27 '0' chars = 31 ASCII chars.
global TETH_NAME: str<31> = "tETH000000000000000000000000000";
global TETH_SYMBOL: str<31> = "tETH000000000000000000000000000";
global TETH_DECIMALS: u8 = 18;

unconstrained fn deploy_teth(
    env: &mut TestEnvironment,
    deployer: AztecAddress,
    minter: AztecAddress,
) -> AztecAddress {
    let initializer_call = TokenB::interface().constructor_with_minter(
        TETH_NAME,
        TETH_SYMBOL,
        TETH_DECIMALS,
        minter,
    );
    env.deploy("@token_b/TokenB").with_public_initializer(deployer, initializer_call)
}

#[test]
unconstrained fn mint_to_private_balance() {
    let mut env = TestEnvironment::new();

    let admin = env.create_light_account();
    let _other = env.create_light_account();

    let token_address = deploy_teth(&mut env, admin, admin);

    // 1 tETH (18 decimals)
    let mint_amount: u128 = 1_000_000_000_000_000_000;
    env.call_private(admin, TokenB::at(token_address).mint_to_private(admin, mint_amount));

    let balance =
        env.execute_utility(TokenB::at(token_address).balance_of_private(admin));
    assert(balance == mint_amount, "minted private balance mismatch");
}

#[test]
unconstrained fn private_transfer_moves_balance() {
    let mut env = TestEnvironment::new();

    let alice = env.create_light_account();
    let bob = env.create_light_account();

    let token_address = deploy_teth(&mut env, alice, alice);

    // Mint 5 tETH to Alice.
    let mint_amount: u128 = 5_000_000_000_000_000_000;
    env.call_private(alice, TokenB::at(token_address).mint_to_private(alice, mint_amount));

    // Transfer 2.5 tETH from Alice to Bob (private -> private).
    let transfer_amount: u128 = 2_500_000_000_000_000_000;
    env.call_private(
        alice,
        TokenB::at(token_address).transfer_private_to_private(alice, bob, transfer_amount, 0),
    );

    let alice_balance =
        env.execute_utility(TokenB::at(token_address).balance_of_private(alice));
    let bob_balance =
        env.execute_utility(TokenB::at(token_address).balance_of_private(bob));

    assert(alice_balance == mint_amount - transfer_amount, "alice should have 2.5 tETH left");
    assert(bob_balance == transfer_amount, "bob should have 2.5 tETH");
}
