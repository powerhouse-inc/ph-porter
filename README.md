# @powerhousedao/ph-porter

CLI for migrating Powerhouse Reactor projects between stack versions and surfacing/fixing the issues a migration leaves behind.

## Quick start

No install needed — invoke directly via your package manager:

```sh
cd /path/to/your/reactor-project
npx @powerhousedao/ph-porter migrate --version latest # migrate to latest
```

If you'd rather have a persistent install:

```sh
npm  install -g @powerhousedao/ph-porter
```

After that, `ph-porter <command>` works directly. Use `ph-porter selfUpdate` to bump it later.

## Commands

All commands run against the current working directory unless `--workdir <path>` is passed. Pass `--help` to any command for full options.

- **`status`** — inspects the project and reports its current state. Run this first when you walk into an unfamiliar project.
- **`migrate <version>`** — migrates the project to the target stack version (e.g. `latest`, `staging`, `dev`, or an exact semver like `6.0.2`). **Destructive** — requires a clean git working tree. Rollback with `git restore .`.
- **`validate`** — runs lint, typecheck, build, and publint, then prints a per-step summary.
- **`selfUpdate`** — updates the installed CLI to the latest npm version.

## Interactive mode

Run `ph-porter -i` to interact with an agent. It can run the commands for you, read the output, and answer questions in plain language.
You need to configure the model and API key to use.

| Setting | Description | Default |
|---|---|---|
| `model` | LLM model in `provider/id` form | `anthropic/claude-haiku-4-5` |
| `anthropicApiKey` | Anthropic API key | — |

Set them with the built-in `config` command:

```sh
ph-porter config --name anthropicApiKey --write sk-ant-...                # this project
ph-porter config --name anthropicApiKey --write sk-ant-... --scope user   # user-wide
ph-porter config --list                                                   # show all
ph-porter config --help                                                   # full reference
```

## Use with an AI agent

This repo ships an [Agent skill](https://www.anthropic.com/news/skills) so AI agents, like Claude Code, can run ph-porter for you. Install it into the current project with:

```sh
npx skills add powerhouse-inc/ph-porter
```

After that, asking the agent to "migrate this reactor project" or "validate this powerhouse project" activates the skill.

## Caveats

- **No dry-run.** A clean git working tree is the rollback mechanism — `git restore .` undoes a failed migration.
- **Custom `package.json` exports are overwritten.** `migrate` rewrites the `exports` field — re-apply any custom subpath exports afterwards.
- **Renamed or removed modules leave their old directories behind.** Delete them by hand.

## License

AGPL-3.0-only.
