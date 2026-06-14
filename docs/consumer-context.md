# Consumer Context

Diffwarden consumers are people, scripts, CI jobs, and coding agents that install,
configure, and run Diffwarden from repositories they want reviewed.

Consumers are not developing Diffwarden itself. They should not need this repository's
test commands, release process, adapter internals, or implementation notes unless they are
debugging a setup problem.

## Consumer Goals

- Install or run the published `diffwarden` CLI.
- Configure reviewers, reviewer sets, model choices, effort settings, and auth-backed
  reviewer profiles.
- Run reviews for local changes, branch diffs, single commits, or repository-scoped
  instructions.
- Choose the right output mode:
  - humans use `diffwarden review`;
  - coding agents use `diffwarden review --agent`;
  - scripts and CI use `diffwarden review --json` or `diffwarden review --ndjson`.
- Persist review artifacts or report history only when explicitly requested.

## Consumer Documentation

- `README.md` is the front door: install, quickstart, common commands, output modes, and
  current status.
- `docs/configuration.md` is the setup guide: config discovery, reviewer selection,
  reviewer sets, profiles, env defaults, reporting, and auth-related options.
- `docs/adapters.md` explains reviewer runtime behavior when a consumer needs to
  troubleshoot a specific SDK or CLI.
- `skills/diffwarden/SKILL.md` is the consumer-facing agent skill. It is for agents using
  Diffwarden from another repository, not for agents developing Diffwarden.

## Maintainer Guidance

When a change affects consumer behavior, update the consumer docs in the same change:

- Put high-frequency commands and output-mode guidance in `README.md`.
- Put setup, config, auth, profile, and reporting detail in `docs/configuration.md`.
- Put reviewer-specific runtime and troubleshooting detail in `docs/adapters.md`.
- Update `skills/diffwarden/SKILL.md` when the recommended agent invocation changes.
- Keep contributor-only commands and implementation notes out of consumer docs unless they
  are clearly labeled as local development guidance.
