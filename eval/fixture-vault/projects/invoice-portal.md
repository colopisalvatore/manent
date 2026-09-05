---
name: invoice-portal
description: "The customer portal where invoices are issued, paid and reconciled; scope, state and constraints."
type: project
audience: [tech, product]
created: 2026-01-03
status: active
---

A portal where a customer sees their invoices, pays one, and the payment is reconciled against
the ledger without anyone opening a spreadsheet.

State: issuing and paying work end to end; reconciliation matches by amount and reference and
leaves the ambiguous cases in a queue for a person. The queue is the part that decides whether
this saves time, so it is the part that gets measured.

Constraints that shaped it: payments are settled by the provider in batches, so the ledger is
eventually consistent by construction; and a customer must be able to download a paid invoice
years later, which is why storage is boring on purpose. Related: [[oauth-refresh-rotation]],
[[acme-hosting]], [[2026-01-10-load-test-report]].
