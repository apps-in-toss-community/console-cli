---
"@ait-co/console-cli": patch
---

Add `aitcc completion <bash|zsh|fish>` to emit shell completion scripts.

Static, shallow design: top-level commands and one level of subcommands (e.g. `aitcc workspace <TAB>` → `ls partner segments show terms use`). Deeper (3rd+ word) completions fall through to the shell's default filename completion, which is fine for positional app/workspace IDs.

Install one-liners per shell:
- bash: `source <(aitcc completion bash)` in `~/.bashrc`
- zsh:  `aitcc completion zsh > "${fpath[1]}/_aitcc"`
- fish: `aitcc completion fish > ~/.config/fish/completions/aitcc.fish`

`install.sh` now detects `$SHELL` and prints the appropriate one-liner after install. User rc files are not modified automatically.

`--json` emits `{ok: false, reason: 'invalid-shell', allowed: [...], message}` on bad input so agent-plugin can capability-probe.
