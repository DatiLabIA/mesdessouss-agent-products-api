# lia-order-lookup-review-fixes

## Objective

Fix what the review of 62 test-flow conversations found in the `order_lookup` tool, so
that Lia never sees internal staff notes, answers returns and refunds with the right
data (voucher vs money included), and stops escalating cases that have a known answer.

## Problem

See `docs/hallazgos-conversaciones-flow-test.md`. In short:

1. Internal staff notes reach Lia in `conversation.messages` and were read to customers.
2. The refund type (voucher / money) is computed but never reaches `facts_to_convey`.
3. State 61 without a credit slip escalates (MAIL_12 misses `processed_date`).
4. Group C (partial shipment) always escalates: `historyHasInfo` is never `true`.
5. Refund states (83, 7, 68) escalate although the refund data is available.
6. MAIL_15 (past lead time) and MAIL_1 have no body; the team wrote the texts.
7. The team's retard text needs a human follow-up ("Zimbra notification"). The
   notification action itself is enabled later; the tool must only flag it.

## Why

Leaking internal notes is a customer-facing incident. The rest are the causes of most
`bad` reviews in the test flow.

## Evidence gathered (25/09/2026, read-only against production PrestaShop)

Authorised by the user: read-only GETs with the project's API key.

### Messages — `customer_messages.private`

Sample: 600 most recent messages (22/09 14:10 → 25/09 05:53).

| id_employee | private | Content | Count |
|---|---|---|---|
| 0 | 1 | Payment-module notes only | 288 |
| >0 | 0 | Shop replies to the customer | 118 |
| 0 | 0 | Customer messages from the website | 62 |
| >0 | 1 | **Mixed**: internal notes, customer e-mails pasted by staff, shop replies sent from the mailbox | 132 |

- Every internal note seen has `private = 1` ("C13FMK 01N - Délai…", "je peux plus me la
  voir cette cliente", "VIREMENT … CE JOUR", "code avoir supprimé", "!! COMMANDE BLOQUÉE…").
- No internal note was found with `private = 0`.
- No other field separates notes from pasted customer e-mails: `ip_address`,
  `user_agent`, `file_name` are empty, `read = 0` and `date_upd = date_add` for all.
- Decision (user instruction): **only `private = 0` messages reach Lia.** Cost: the
  customer e-mails that staff paste by hand (private) are no longer visible.
- Within `private = 0`, `id_employee` is reliable: `0` = customer, `>0` = shop.

### Order states

64 states in `order_states`. Last 8,000 orders (27/07 → 25/09) by current state:
10: 6134 · 61: 483 · 31: 409 · 17: 284 · 9: 225 · 83: 104 · 68: 78 · 5: 67 · 4: 55 ·
2: 47 · 7: 40 · 78: 24 · 14: 23 · 6: 9 · 1: 8 · 18: 5 · 8: 2 · 20: 2 · 70: 1.

The webservice exposes no return resource (`order_returns`, `order_return_states`
do not exist). State 61 is the only return signal.

### Refunds — voucher vs money

300 most recent `order_slip` (10/09 → 24/09):

- `order_slip_type` does **not** tell voucher from money (all three values appear with
  and without a voucher).
- A voucher `V{id}C{customer}O{order}` exists for 81/300 slips (27%): current logic is
  right. Used vouchers keep `active = 1` with `quantity = 0`, so they are still found.
- `V…C…O…-2` codes are the remainder of a partially used voucher; the original code
  is still present, so no slip is misclassified by them. One manual `AVOIR…` code seen.

### State 61 timing

Last 200 orders in 61: previous state is 10 (108) or 31 (87). The credit slip comes
after entering 61: median ~2 h, p75 1.1 days, max 14.1 days, never before.
21/200 are in 61 without a slip: 16 are under a day old, 5 are 2.6–23.7 days old.

## Authorised scope

Code, seed, tests, a new additive migration, and docs in this repository.

**Out of scope (each needs a separate explicit decision):** applying the migration to the
shared database, publishing a new rule set to the database, redeploying the service,
editing the DatiHub prompt or tool configuration, and the Zimbra notification action.

## Constraints

- Rules live in the database; the code seed is the initial seed. Changes here reach
  production only after a new rule set is published.
- Fail-safe stays in code. A missing fact never gets invented.
- ~400 authored lines per task is a planning heuristic, not a cap.

## TDD

Mode: **off** (source: `odd/tasks/lia-order-lookup.md`, "Modo TDD"). Runner exists:
`pnpm test` (`tsx --test "src/**/*.test.ts"`). Tests are written with each change.

## Verification

- `pnpm build`
- `pnpm test`
- `pnpm check:pipeline <REF> <EMAIL>` on real orders (read-only) where noted.

## Tasks

- [x] **T1 — Only public messages reach Lia.** Request `private` in
  `CUSTOMER_MESSAGE_FIELDS`; keep only `private = 0`; authorship from `id_employee`
  (0 = CUSTOMER, >0 = SHOP, certain); keep the payment-note guard as a second barrier;
  recompute `awaitingShopReply` / `historyHasInfo` on public messages. Update tests.
  Route: delegated writer (consolidation + tests are 2 non-trivial files).
  Commit `43425ae`. The writer also closed a second leak: `lastMessage` read the raw
  thread, bypassing the message filter. Risk: medium (writer self-check + parent re-run).
  Checks: `pnpm build` clean; `pnpm test` 202/202. Real data (read-only): LQTQJXTUR,
  NQWWBQUNW and EFUBKXELE no longer carry their notes ("C13FMK 01N…", "07200…",
  "47190 Noir…"); shop replies remain.
  - **Found while verifying — fixed inline, commit `11e8efd`:** `id_customer_thread`
    arrives as a string, the thread map was keyed by it and read with the numeric
    `thread.id`, so `lastMessage` was always `null` (already true before T1) and the
    primary thread was picked blind. Eighth case of the same id-type root cause.
    Test with the real string shape: fails without the fix, passes with it (203/203).
- [x] **T2 — Refund method in the guidance.** Commits `6f0a2c7`, `53ee1b8`.
  Built as one composed `refund_method` fact ("avoir valable jusqu'au …" / "remboursement
  sur le moyen de paiement…"), not a separate `voucher_expires_at`. New outcomes MAIL_10
  (state 61 without slip, text A.6) and MAIL_REFUND (group F), setting
  `return_refund_max_business_days` (7), migration `20260924000000_add_refund_issued`.
  Also fixed: `createRuleDraft` dropped `refundIssued` when cloning. Risk: treated as high
  (schema change; assessment could not run). Checks: build clean, 251/251. Real data
  (read-only): RYOTSAWVN → MAIL_12 with "avoir valable jusqu'au 18/09/2027"; JBIZNYEPA
  (83) → MAIL_REFUND; MUJJABSBJ (61, no slip) → MAIL_10 with "24/09/2026".
  Independent verifier: PASS WITH ISSUES — CRITICAL: the new required setting would make
  the live rule set fail validation → 503 on every lookup after deploy; MEDIUM: MCP
  descriptions miss group F; MEDIUM: `refunded_products` silently partial. All three
  fixed in `d7c6e40` (setting now optional with default 7, MCP descriptions list F /
  MAIL_10 / MAIL_REFUND / MAIL_8, any unnamed refunded line escalates). 274/274.
  Route: delegated writer + independent verifier.
- [x] **T3 — Partial shipment stops escalating.** Commit `b729946`. Group C keyed on
  `hasTracking` instead of `historyHasInfo` (never `true`). MAIL_6 row and template
  removed: its restock date only existed in internal notes.
- [x] **T4 — Template bodies and team follow-up flag.** Commit `97c53b2`. MAIL_15 = A.1,
  MAIL_1 = A.2 (literal, typos kept and flagged for the team), MAIL_8 = A.5 as
  non-matrix template behind `guidance.return_inquiry`. `notify_team` =
  template flag OR `must_escalate`; no notification is sent (Zimbra action comes later).
  Migration `20260925000000_add_notify_team`. Old-shape rule set tests added.
- [x] **T5 — Complete the state catalogue in the seed.** Commit `e410605`. State 5 → B;
  known D states documented. T3–T5 checks: build clean, 272/272.
- [x] **T6 — Docs.** `docs/hallazgos-conversaciones-flow-test.md` §12 (evidence, fixes,
  before/after on real orders, what remains for production) and the summary table.
  Also `bc2d335`: `check:pipeline` prints `notify_team`, template text and return inquiry.

## Final verification

`pnpm build` clean; `pnpm test` 274/274. `pnpm check:pipeline` on 9 real orders
(read-only): ZCQJGLQSK / NQWWBQUNW / EFUBKXELE → MAIL_7; QVRFQFOQB / LQTQJXTUR →
MAIL_15 with body A.1 and `notify_team: true`; LYVYRWCVB → MAIL_3 + return_inquiry
MAIL_8; JBIZNYEPA → MAIL_REFUND; RYOTSAWVN → MAIL_12 with refund_method; MUJJABSBJ →
MAIL_10. None escalate.

## Progress

All tasks done on `feat/lia-order-lookup-review-fixes` (not pushed). Next steps are
user decisions: push/PR, deploy (applies two additive migrations), publish a new rule
set from the seed (`create_rule_draft` → `simulate_rules` → `activate_rule_set`), DatiHub
prompt changes, and the Zimbra notification action on `notify_team`.
