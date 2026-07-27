#![no_std]
//! A minimal, permissionless faucet token for testnet.
//!
//! Implements just enough of the SEP-41 token interface for the ObscuraPool to deposit and
//! withdraw it (`transfer` + `balance` + metadata), plus an OPEN `mint` so anyone can fund
//! themselves from the app — no admin, no trustlines. This is a testnet mock; do not use
//! on mainnet.

use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, MuxedAddress, String};

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Balance(Address),
    Decimals,
    Name,
    Symbol,
}

#[contract]
pub struct FaucetToken;

#[contractimpl]
impl FaucetToken {
    pub fn __constructor(env: Env, decimals: u32, name: String, symbol: String) {
        let s = env.storage().instance();
        s.set(&DataKey::Decimals, &decimals);
        s.set(&DataKey::Name, &name);
        s.set(&DataKey::Symbol, &symbol);
    }

    fn read_balance(env: &Env, id: &Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::Balance(id.clone()))
            .unwrap_or(0)
    }

    fn write_balance(env: &Env, id: &Address, amount: i128) {
        env.storage()
            .persistent()
            .set(&DataKey::Balance(id.clone()), &amount);
    }

    /// Permissionless faucet: mint test tokens to any address. Testnet only.
    pub fn mint(env: Env, to: Address, amount: i128) {
        if amount <= 0 {
            panic!("amount must be positive");
        }
        let bal = Self::read_balance(&env, &to);
        Self::write_balance(&env, &to, bal + amount);
    }

    // --- SEP-41 subset used by the pool ---

    pub fn transfer(env: Env, from: Address, to: MuxedAddress, amount: i128) {
        from.require_auth();
        if amount <= 0 {
            panic!("amount must be positive");
        }
        let to_addr = to.address();
        let from_bal = Self::read_balance(&env, &from);
        if from_bal < amount {
            panic!("insufficient balance");
        }
        Self::write_balance(&env, &from, from_bal - amount);
        let to_bal = Self::read_balance(&env, &to_addr);
        Self::write_balance(&env, &to_addr, to_bal + amount);
    }

    pub fn balance(env: Env, id: Address) -> i128 {
        Self::read_balance(&env, &id)
    }

    pub fn decimals(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::Decimals).unwrap_or(7)
    }

    pub fn name(env: Env) -> String {
        env.storage()
            .instance()
            .get(&DataKey::Name)
            .unwrap_or_else(|| String::from_str(&env, "Faucet Token"))
    }

    pub fn symbol(env: Env) -> String {
        env.storage()
            .instance()
            .get(&DataKey::Symbol)
            .unwrap_or_else(|| String::from_str(&env, "TOKEN"))
    }
}
