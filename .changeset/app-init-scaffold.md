---
'@ait-co/console-cli': patch
---

Add `aitcc app init` to scaffold a well-formed `aitcc.yaml` interactively.
Required fields are validated against the same constraints `register`
enforces; optional fields are pre-laid as commented lines for later
edits. Workspace is selected from the live API list, and the resulting
file pins `workspaceId` so subsequent commands inherit the project
context without flags.
