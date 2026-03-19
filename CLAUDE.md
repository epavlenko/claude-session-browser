# CLAUDE.md

Read `AGENTS.md` for project instructions.

## Knowledge Base

Project docs: `$OBSIDIAN_VAULT_PATH/Проекты/Claude Session Browser/`

## Build & Test

```bash
npx tsc -p ./           # compile
npx @vscode/vsce package --no-dependencies  # package vsix
```

Regenerate icon PNG after SVG changes:
```bash
node -e "require('sharp')(require('fs').readFileSync('resources/icon-large.svg')).resize(266,266).png().toFile('resources/icon.png')"
```
