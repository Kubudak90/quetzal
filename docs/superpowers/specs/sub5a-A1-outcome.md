# Sub-5a A1: contractAddressSalt args-independence outcome

**Decision:** FALLBACK (args-DEPENDENT, 3-deploy + set_orderbook)

**Method:** Dynamic probe via `scripts/sub5a-salt-probe.ts` (pure-crypto address
computation — no running Aztec node required), cross-confirmed by static
inspection of `@aztec/stdlib` source code.

---

## Evidence

### Dynamic probe output

```
Salt:               0x1cc10e83aeeaac9b1df153d667b5ce440d6f24fe2beaec507b7baaa4c98d4b08
Instance A address: 0x0727c7da354a2e10e2eeb1ad17a5122adb146a1dac484bde66791a93f633a650
Instance B address: 0x134afe2ae6b1820fe34ad5234a98eaeee744928400a1684399958ca07eb69df4

Result: contractAddressSalt is ARGS-DEPENDENT
Phase A branch: FALLBACK (3-deploy + set_orderbook)
```

Same salt, same deployer, same artifact class ID — but two different Token
constructor arg sets (`("TokenA","TA",6,0,ZERO)` vs `("TokenB","TB",18,0,ZERO)`)
produce **different** addresses.

### Static inspection

File: `node_modules/.pnpm/@aztec+stdlib@4.2.1_typescript@5.9.3/node_modules/@aztec/stdlib/dest/contract/contract_address.js`

Lines 33–38 — `computeSaltedInitializationHash`:
```javascript
export function computeSaltedInitializationHash(instance) {
    return poseidon2HashWithSeparator([
        instance.salt,
        instance.initializationHash,   // ← constructor args hash enters here
        instance.deployer
    ], DomainSeparator.PARTIAL_ADDRESS);
}
```

Lines 23–28 — `computePartialAddress`:
```javascript
export async function computePartialAddress(instance) {
    const saltedInitializationHash = ...await computeSaltedInitializationHash(instance);
    return poseidon2HashWithSeparator([
        instance.originalContractClassId,
        saltedInitializationHash        // ← which feeds the partial address
    ], DomainSeparator.PARTIAL_ADDRESS);
}
```

The full address derivation formula (from the JSDoc at line 8–14):
```
salted_initialization_hash = pedersen([salt, initialization_hash, deployer], ...)
partial_address            = pedersen([contract_class_id, salted_initialization_hash], ...)
address                    = f(public_keys_hash, partial_address, ...)
```

`initialization_hash` is `poseidon2([constructor_selector, args_hash])` (lines 58–63),
so **constructor arguments are baked into the address**. Changing any constructor
arg changes the `initializationHash`, which cascades through
`saltedInitializationHash` → `partialAddress` → `address`.

---

## Implication for Phase A2

**FALLBACK path — 3-deploy ceremony:**

1. Deploy `Orderbook` (no Treasury address yet) → get `orderbook_addr`.
2. Deploy `Treasury(orderbook_addr)` → get `treasury_addr`.
3. Call `Orderbook.set_treasury(treasury_addr)` — one-shot setter with an
   `assert treasury == AztecAddress::zero()` guard so it can only be called once.

**Required contract changes vs current state:**

| Contract | Field | Change |
|---|---|---|
| `Orderbook` | `treasury_addr` | `PublicImmutable` → `PublicMutable` |
| `Orderbook` | — | Add `set_treasury(addr: AztecAddress)` external fn |
| `Treasury` | `orderbook_addr` | stays `PublicImmutable` (Treasury deploy happens 2nd) |

The PREFERRED path (2-deploy, both `PublicImmutable`) is **not achievable** because
precomputing Orderbook's address from `(salt, deployer, class_id)` alone is
insufficient — the constructor args also determine the address.
