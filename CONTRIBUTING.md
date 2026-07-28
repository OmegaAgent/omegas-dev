# Contributing

Thank you for helping make personal Claude Code and Codex configuration easier to
understand and move.

## Good contribution areas

- clearer local visualization of discovered configuration
- support for documented Claude Code or Codex configuration shapes
- safer redaction and filesystem handling
- cross-platform behavior on macOS, Linux, and Windows
- focused tests for configuration discovery and normalization
- documentation that makes the trust boundary easier to audit

Changes that weaken explicit consent, upload raw configuration, include credentials, add
telemetry, or silently activate imported MCP servers will not be accepted.

## Local workflow

Requires Node.js 20 or newer.

```sh
npm test
npm run check
npm run pack:dry-run
```

For a local-only functional check, run:

```sh
node bin/omegas-dev.js --dry-run --root /path/to/a/test/project
```

Use fixtures or temporary directories. Never attach a real preview, configuration file,
credential, filesystem path, or transfer code to an issue or pull request.

## Pull requests

Keep each pull request focused on one behavior. Include:

- the user problem being solved
- the configuration shape or platform involved
- tests proving both the expected behavior and the relevant privacy boundary
- the commands used to validate the change

Substantive documentation-only changes are welcome when they correct behavior, clarify a
security boundary, or make the tool materially easier to use. Automated bulk edits and
contribution-count padding are not welcome.

## Security reports

Do not open a public issue for a vulnerability or any report containing personal
configuration. Follow the private process in [SECURITY.md](SECURITY.md).
