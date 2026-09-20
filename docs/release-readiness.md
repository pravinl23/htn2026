# Public-release readiness

This is a source-availability checklist, not a claim that Shabang is ready for general distribution.

## Must decide before public use

- **License:** the repository currently has no LICENSE file. Choose a license only after deciding what reuse, commercial use, and contributions you intend to permit.
- **Security reporting:** publish a monitored private vulnerability-reporting route or contact before inviting security reports. Do not ask people to disclose sensitive issues in public issues.
- **Maintainers and contributions:** add CONTRIBUTING.md, a code of conduct if community contributions are welcome, and ownership/review expectations.
- **Distribution:** the desktop app is ad-hoc signed. Plan Developer ID signing, notarization, update delivery, and support for revoking or replacing builds before distributing binaries outside a controlled development group.
- **Privacy review:** repeat the data-flow and telemetry review against the exact release commit, enabled provider configuration, and third-party SDK versions.

## Repository actions still worth taking

- Decide whether the historical attic should be published. It contains the removed Chrome extension and may confuse users despite its scope notice.
- Remove, archive, or clearly label internal planning and handoff files before public launch; they are not product documentation.
- Review SETUP.md before presenting it as public installation guidance: it includes maintainer recovery commands that stop processes, reset Accessibility permissions, and remove local development state.
- Add automated secret scanning and dependency/security scanning in CI. The current manual audit found no committed production credentials; token-like strings in tests are fixtures.
- Verify every tracked binary and media asset has a clear source and redistribution right.
- Add a clean-machine CI build for the macOS desktop target and document a release artifact checksum/provenance process.
- Review the installer and uninstall scripts after the Ghost → Shabang rename. The current runtime rename is recent and some internal server/launchd identifiers intentionally remain historical.

## Release gate

Do not call Shabang a supported production app until the signing/notarization, security contact, license, privacy review, and clean-machine install/uninstall checks above have owners and completion evidence.
