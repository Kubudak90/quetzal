// TXE tests for the Token contract - two brands (tUSDC 6 dec, tETH 18 dec).
// Run with: pnpm test:noir  (compiles then invokes nargo via Docker)

use crate::Token;
use aztec::{
    protocol::address::AztecAddress,
    test::helpers::test_environment::TestEnvironment,
};

// tUSDC brand constants
// "tUSDC" + 26 '0' chars = 31 ASCII chars.
global TUSDC_NAME: str<31> = "tUSDC00000000000000000000000000";
global TUSDC_SYMBOL: str<31> = "tUSDC00000000000000000000000000";
global TUSDC_DECIMALS: u8 = 6;

// tETH brand constants
// "tETH" + 27 '0' chars = 31 ASCII chars.
global TETH_NAME: str<31> = "tETH000000000000000000000000000";
global TETH_SYMBOL: str<31> = "tETH000000000000000000000000000";
global TETH_DECIMALS: u8 = 18;

// deploy helper

unconstrained fn deploy_token(
    env: &mut TestEnvironment,
    deployer: AztecAddress,
    minter: AztecAddress,
    name: str<31>,
    symbol: str<31>,
    decimals: u8,
) -> AztecAddress {
    let initializer_call = Token::interface().constructor_with_minter(
        name,
        symbol,
        decimals,
        minter,
    );
    env.deploy("@token/Token").with_public_initializer(deployer, initializer_call)
}

// tUSDC tests

#[test]
unconstrained fn mint_to_private_balance_tusdc() {
    let mut env = TestEnvironment::new();
    let admin = env.create_light_account();
    let _other = env.create_light_account();

    let token_address = deploy_token(&mut env, admin, admin, TUSDC_NAME, TUSDC_SYMBOL, TUSDC_DECIMALS);

    // 1000.000000 tUSDC (6 decimals)
    let mint_amount: u128 = 1_000_000_000;
    env.call_private(admin, Token::at(token_address).mint_to_private(admin, mint_amount));

    let balance = env.execute_utility(Token::at(token_address).balance_of_private(admin));
    assert(balance == mint_amount, "tUSDC: minted balance mismatch");
}

#[test]
unconstrained fn private_transfer_moves_balance_tusdc() {
    let mut env = TestEnvironment::new();
    let alice = env.create_light_account();
    let bob = env.create_light_account();

    let token_address = deploy_token(&mut env, alice, alice, TUSDC_NAME, TUSDC_SYMBOL, TUSDC_DECIMALS);

    let mint_amount: u128 = 100_000_000;
    env.call_private(alice, Token::at(token_address).mint_to_private(alice, mint_amount));

    let transfer_amount: u128 = 30_000_000;
    env.call_private(
        alice,
        Token::at(token_address).transfer_private_to_private(alice, bob, transfer_amount, 0),
    );

    let alice_balance = env.execute_utility(Token::at(token_address).balance_of_private(alice));
    let bob_balance = env.execute_utility(Token::at(token_address).balance_of_private(bob));

    assert(alice_balance == mint_amount - transfer_amount, "alice should have 70 tUSDC");
    assert(bob_balance == transfer_amount, "bob should have 30 tUSDC");
}

// tETH tests

#[test]
unconstrained fn mint_to_private_balance_teth() {
    let mut env = TestEnvironment::new();
    let admin = env.create_light_account();
    let _other = env.create_light_account();

    let token_address = deploy_token(&mut env, admin, admin, TETH_NAME, TETH_SYMBOL, TETH_DECIMALS);

    // 1 tETH (18 decimals)
    let mint_amount: u128 = 1_000_000_000_000_000_000;
    env.call_private(admin, Token::at(token_address).mint_to_private(admin, mint_amount));

    let balance = env.execute_utility(Token::at(token_address).balance_of_private(admin));
    assert(balance == mint_amount, "tETH: minted balance mismatch");
}

#[test]
unconstrained fn private_transfer_moves_balance_teth() {
    let mut env = TestEnvironment::new();
    let alice = env.create_light_account();
    let bob = env.create_light_account();

    let token_address = deploy_token(&mut env, alice, alice, TETH_NAME, TETH_SYMBOL, TETH_DECIMALS);

    // Mint 5 tETH to Alice.
    let mint_amount: u128 = 5_000_000_000_000_000_000;
    env.call_private(alice, Token::at(token_address).mint_to_private(alice, mint_amount));

    // Transfer 2.5 tETH from Alice to Bob (private -> private).
    let transfer_amount: u128 = 2_500_000_000_000_000_000;
    env.call_private(
        alice,
        Token::at(token_address).transfer_private_to_private(alice, bob, transfer_amount, 0),
    );

    let alice_balance = env.execute_utility(Token::at(token_address).balance_of_private(alice));
    let bob_balance = env.execute_utility(Token::at(token_address).balance_of_private(bob));

    assert(alice_balance == mint_amount - transfer_amount, "alice should have 2.5 tETH left");
    assert(bob_balance == transfer_amount, "bob should have 2.5 tETH");
}
