# Contributing To Meshkeep

Meshkeep is pre-alpha. Keep contributions small, explicit about trust assumptions, and aligned with [ROADMAP.md](ROADMAP.md).

## Before Starting

- Search existing issues before opening a new one.
- Open an issue before substantial implementation, dependency, architecture, or scope work.
- Do not treat an unchecked roadmap item as approval to implement it.
- Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md), not in an issue.
- Follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Issues And Pull Requests

Issues should describe the observed problem, environment, reproduction or use case, expected result, and relevant security/privacy effects. Avoid including secrets, private keys, personal data, or sensitive unpublished content.

Pull requests should:

- Solve one scoped problem and link its issue or accepted decision.
- Explain user-visible and protocol-visible behavior changes.
- Include or update tests, fixtures, and documentation as applicable.
- State the exact validation performed and any check that could not run.
- Avoid unrelated formatting, generated output, dependency churn, or roadmap changes.
- Update `ROADMAP.md` only for a milestone that the pull request implements and verifies end to end.

Maintainers may close proposals that add a central dependency, a new protocol without demonstrated need, blockchain components, or work outside the current phase.

## Development Checks

Install the package workspace and run the aggregate check:

```sh
pnpm install --frozen-lockfile
pnpm check
```

Use `pnpm build`, `pnpm test`, `pnpm typecheck`, `pnpm lint`, and `pnpm format` for focused validation. If a package-specific check or required external tool has not landed, say so in the pull request rather than claiming it passed. Kubo integration work must use isolated repositories, disposable keys, and non-sensitive fixture content.

## Protocol Decisions

Changes to wire formats, canonical encoding, signatures, identity, update ordering, IPNS mapping, UnixFS import behavior, compatibility, or trust boundaries require an issue or RFC and an accepted ADR under `docs/adr/` before implementation. Include deterministic valid and invalid fixtures, downgrade analysis, and migration impact.

## Developer Certificate Of Origin

All commits must include a `Signed-off-by` trailer certifying the [Developer Certificate of Origin 1.1](https://developercertificate.org/):

```sh
git commit -s -m "Describe the change"
```

The sign-off is a certification of contribution rights, not a GPG signature. Contributions without sign-off will need to be corrected before merge.

By contributing code, you agree that it is licensed under MPL-2.0. Do not submit material you do not have the right to license.
