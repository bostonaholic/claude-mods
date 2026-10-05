# bostonaholic/claude-mods

1. Describe this as Matthew Boston's personal Claude Code mods. Keep the introduction short, without a feature list.
2. One mod per `hooks/<module>.mjs`, exporting `register()`. Register every module in `hooks/hooks.json`.
3. Run `claude plugin validate . --strict` and `claude plugin validate .claude-plugin/plugin.json --strict` after editing either manifest or `hooks/hooks.json`.
4. Every commit and tag must be signed and verified. Keep history linear and use conventional commit messages.
5. Repo-level prose avoids em dashes.
