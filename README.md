# Privia

**Confidential invoice financing on the Canton Network.**

Suppliers raise capital against unpaid invoices and financiers advance funds, without either side exposing pricing, counterparties, or positions to competitors. Canton's privacy model keeps every deal private to its parties, while a shared ledger structurally prevents the two classic invoice-financing frauds.

## The problem
- **Fake invoices** — a supplier invents a receivable that does not exist.
- **Double-financing** — a supplier sells the same real invoice to two financiers and pockets both advances.

TradFi has no shared ledger between competing financiers, so double-financing is hard to catch. A transparent chain could share a ledger, but only by leaking every supplier's receivables and every financier's pricing to the market. Canton gives a shared source of truth that prevents the fraud *and* keeps each deal private.

## How it works
1. `Invoice` — issued by the supplier, visible to the buyer.
2. `AcknowledgedInvoice` — the buyer confirms the debt on-chain. Blocks fake invoices.
3. `FinancingOffer` — a financier locks cash and terms. Accepting **consumes** the acknowledged invoice and atomically advances cash to the supplier (delivery-versus-payment in one transaction).
4. `FinancedReceivable` — collection rights pass to the financier; the buyer settles at maturity.

**Double-financing is impossible by construction.** Accepting an offer archives the acknowledged invoice. A second financier accepting an offer on the same invoice exercises a choice on a contract that no longer exists, and the transaction fails. No fraud-detection code — the ledger's consumption semantics enforce it. This is asserted in `daml/Privia/Test.daml` via `submitMustFail`.

## Run

```bash
dpm build
dpm test
```

`dpm build` compiles the Daml model; `dpm test` runs the Daml Script in `daml/Privia/Test.daml`, which proves the same invoice cannot be financed twice.

## Project layout

```
daml/Privia/
  Cash.daml       — minimal cash/IOU for atomic delivery-versus-payment
  Invoice.daml    — Invoice and buyer-acknowledged receivable
  Financing.daml  — financing offers and financed receivables
  Test.daml       — double-financing prevention test
```

## Stack

Daml 3.5 on the Canton Network (dpm 1.0.x, SDK 3.5.2, JDK 17).
