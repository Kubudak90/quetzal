// TXE tests for the Token contract - two brands (tUSDC 6 dec, tETH 18 dec).
// Run with: pnpm test:noir  (compiles then invokes nargo via Docker)

use crate::Token;
use aztec::{
    protocol::address::{AztecAddress, EthAddress},
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

// aUSDC bridged brand constants
// "aUSDC" + 26 '0' chars = 31 ASCII chars.
global AUSDC_NAME: str<31> = "aUSDC00000000000000000000000000";
global AUSDC_SYMBOL: str<31> = "aUSDC00000000000000000000000000";
global AUSDC_DECIMALS: u8 = 6;

// deploy helpers

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

unconstrained fn deploy_bridged_token(
    env: &mut TestEnvironment,
    deployer: AztecAddress,
    minter: AztecAddress,
    name: str<31>,
    symbol: str<31>,
    decimals: u8,
    portal_addr: EthAddress,
) -> AztecAddress {
    let initializer_call = Token::interface().constructor_with_minter_bridged(
        name,
        symbol,
        decimals,
        minter,
        portal_addr,
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

// -- Sub-5b: bridge-mode TXE tests --

#[test(should_fail_with = "bridged token: use claim_public via portal flow")]
unconstrained fn sub5b_mint_to_public_reverts_in_bridge_mode() {
    let mut env = TestEnvironment::new();
    let admin = env.create_light_account();
    let portal_l1 = EthAddress::from_field(0xabcdef);

    let token_address = deploy_bridged_token(
        &mut env, admin, admin, AUSDC_NAME, AUSDC_SYMBOL, AUSDC_DECIMALS, portal_l1,
    );

    // Admin tries the legacy mint path - must revert in bridge mode
    env.call_public(admin, Token::at(token_address).mint_to_public(admin, 100 as u128));
}

#[test(should_fail_with = "bridged token: use claim_private via portal flow")]
unconstrained fn sub5b_mint_to_private_reverts_in_bridge_mode() {
    let mut env = TestEnvironment::new();
    let admin = env.create_light_account();
    let portal_l1 = EthAddress::from_field(0xabcdef);

    let token_address = deploy_bridged_token(
        &mut env, admin, admin, AUSDC_NAME, AUSDC_SYMBOL, AUSDC_DECIMALS, portal_l1,
    );

    env.call_private(admin, Token::at(token_address).mint_to_private(admin, 100 as u128));
}

#[test(should_fail_with = "non-bridged token: use mint_to_public")]
unconstrained fn sub5b_claim_public_reverts_in_non_bridge_mode() {
    let mut env = TestEnvironment::new();
    let admin = env.create_light_account();

    // Default (non-bridged) constructor
    let token_address = deploy_token(&mut env, admin, admin, TUSDC_NAME, TUSDC_SYMBOL, TUSDC_DECIMALS);

    // claim_public should revert because is_bridged=false
    env.call_public(
        admin,
        Token::at(token_address).claim_public(admin, 100 as u128, 0 as Field, 0 as Field),
    );
}

#[test(should_fail_with = "bridged token requires non-zero portal_addr")]
unconstrained fn sub5b_bridged_constructor_rejects_zero_portal() {
    let mut env = TestEnvironment::new();
    let admin = env.create_light_account();
    let zero_portal = EthAddress::zero();

    let _ = deploy_bridged_token(
        &mut env, admin, admin, AUSDC_NAME, AUSDC_SYMBOL, AUSDC_DECIMALS, zero_portal,
    );
}

#[test(should_fail_with = "non-bridged token: cannot exit_to_l1")]
unconstrained fn sub5b_exit_to_l1_reverts_in_non_bridge_mode() {
    let mut env = TestEnvironment::new();
    let admin = env.create_light_account();
    let token_address = deploy_token(&mut env, admin, admin, TUSDC_NAME, TUSDC_SYMBOL, TUSDC_DECIMALS);

    let l1_recipient = EthAddress::from_field(0xdeadbeef);
    env.call_public(admin, Token::at(token_address).exit_to_l1_public(100 as u128, l1_recipient));
}
