---
"@ait-co/console-cli": patch
---

Add `aitcc workspace partner` to show the partner (billing/payout) registration state of the selected workspace.

Endpoint: `GET /workspaces/:wid/partner` — returns `{registered, approvalType, rejectMessage, partner}`. A fresh workspace reports `registered: false, approvalType: 'DRAFT', partner: null`; once the owner registers the billing entity the `partner` record is populated (passed through opaquely until a live example is observed).

Flag: `--workspace <id>` to inspect a workspace other than the current selection.
