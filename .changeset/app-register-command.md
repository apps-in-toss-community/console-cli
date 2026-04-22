---
'@ait-co/console-cli': patch
---

Add `aitcc app register` for one-shot mini-app registration from a YAML/JSON manifest.

The command reads a manifest (default `./aitcc.app.yaml` → `./aitcc.app.json`), validates each referenced PNG against the console's dimension rules, uploads the images to `/resource/:wid/upload`, and submits the combined create + review payload to `/workspaces/:wid/mini-app/review`. See CLAUDE.md → "App registration" for the manifest schema and the full `--json` contract.

The submit payload shape is inferred from static bundle analysis and has **not** been observed on the wire yet — the first real submission (dog-food task #23) is expected to either confirm or minor-correct the transform in `src/commands/register-payload.ts` + `src/api/mini-apps.ts`. The manifest shape is stable regardless.
