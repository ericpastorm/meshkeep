# Contributing To Meshkeep

Meshkeep is in early development. Keep contributions small, explicit about trust assumptions, and aligned with [ROADMAP.md](ROADMAP.md) and [ADR 0002](docs/adr/0002-resilient-sites-and-address-book.md).

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

```sh
pnpm install --frozen-lockfile
pnpm check              # lint, typecheck, unit tests, build
pnpm test:integration   # needs Docker; private Kubo network
```

Run the integration tests when you touch Kubo-facing code. If you could not run a check, say so in the pull request. Tests must use generated or fixture keys, non-sensitive content, and isolated Kubo nodes.

## Protocol Decisions

Changes to a data format, address derivation, signing input, record ordering, or trust assumptions need a short ADR in `docs/adr/`, an update to [spec/README.md](spec/README.md), and valid and invalid fixtures. Open an issue first if the change is substantial.

## Developer Certificate Of Origin

All commits must include a `Signed-off-by` trailer certifying the [Developer Certificate of Origin 1.1](https://developercertificate.org/):

```sh
git commit -s -m "Describe the change"
```

The sign-off is a certification of contribution rights, not a GPG signature. Contributions without sign-off will need to be corrected before merge.

By contributing code, you agree that it is licensed under MPL-2.0. Do not submit material you do not have the right to license.
