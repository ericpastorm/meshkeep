# Security Policy

Meshkeep is in early development and has no supported release. Do not use it for production availability, private content, or valuable signing keys.

## Reporting A Vulnerability

Use GitHub Private Vulnerability Reporting for this repository: open the repository's **Security** tab and choose **Report a vulnerability**. Include:

- Affected commit, component, and environment
- Reproduction steps or a minimal proof of concept
- Expected and observed behavior
- Security impact and any known preconditions
- Suggested mitigation, if available

Do not include private keys, credentials, personal data, or harmful third-party content. Use generated disposable material for reproductions.

If private vulnerability reporting is unavailable, open a minimal public issue asking maintainers to enable or provide a private security channel. Do not disclose the vulnerability, exploit, affected users, or sensitive logs in that issue. No security email address is currently asserted to be active.

The project does not promise an acknowledgement or remediation SLA, coordinated disclosure date, bounty, or eligibility decision. Maintainers will communicate through the private report when capacity permits. Please avoid public disclosure while a report is being evaluated, but do not interpret this request as an indefinite embargo.

## Security Vulnerabilities

Examples of issues that belong in a private vulnerability report include:

- Signature or identity verification bypass
- Unauthorized IPNS updates, rollback acceptance, or release substitution
- A mismatch between verified content and the content retained or served
- Incomplete-graph handling that is incorrectly reported as a complete pin
- Private-key, credential, path, or sensitive-content disclosure caused by Meshkeep
- Command injection, path traversal, unsafe archive extraction, or arbitrary code execution
- Kubo RPC exposure or privilege bypass caused by Meshkeep defaults or integration
- Malformed records or content graphs that cause practical resource exhaustion
- Dependency vulnerabilities with a demonstrated impact on Meshkeep's supported behavior

Availability loss caused only by all volunteer replicas leaving, normal public IPFS observability, a publisher intentionally signing malicious content, or a gateway serving a stale but valid version are documented trust limitations unless Meshkeep violates a stated guarantee.

## Content And Abuse Reports

Published website content, copyright disputes, illegal material, harassment hosted by third parties, and requests to remove content from IPFS are content or abuse matters, not software vulnerability reports. Meshkeep cannot guarantee deletion from independently operated peers.

**TODO before public operation:** establish and document a non-security abuse-reporting channel, operator responsibilities, and applicable removal process. Do not use GitHub Private Vulnerability Reporting solely for content disputes.

If content also demonstrates a software vulnerability, report only the minimal technical reproduction privately and avoid redistributing the content.

## Operator Baseline

- Keep publisher keys offline or minimally exposed and back them up securely.
- Use disposable keys during development and testing.
- Bind Kubo RPC to loopback or an equivalent private interface; never expose it to the public network or untrusted browser content.
- Assume IPFS content, CIDs, peer identifiers, IP addresses, and request metadata can become public.
- Verify complete recursive retention and signed update identity instead of trusting a gateway response alone.

See [the threat model](docs/threat-model.md) and [privacy notes](docs/privacy.md) for the current assumptions and non-goals.
