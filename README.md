# Claude Code Mods

The Claude Code mods I use.

Mods run code inside Claude Code; read a mod before you enable it.

## Install

```sh
claude plugin marketplace add bostonaholic/claude-mods
claude plugin install bostonaholic-mods@bostonaholic-mods
```

Then run `/reload-plugins` in an open session.

Update the marketplace first, then the plugin:

```sh
claude plugin marketplace update bostonaholic-mods
claude plugin update bostonaholic-mods@bostonaholic-mods
```

## Local development

```sh
claude --plugin-dir /Users/matthew/code/bostonaholic/claude-mods
```

Claude Code hot-reloads the plugin on each save.

## Contributing

Read [AGENTS.md](AGENTS.md) before making changes.

## License

MIT. See [LICENSE](LICENSE).
