# Security Policy

## Supported versions

Concord is pre-1.0 and under active development. Security fixes are applied to the
latest published version.

## Reporting a vulnerability

Please **do not** open a public issue for security vulnerabilities.

Instead, report privately via GitHub's
[private vulnerability reporting](https://github.com/Get-Concord-AI/concord-mcp/security/advisories/new)
(Security → Report a vulnerability).

Include steps to reproduce, affected versions, and impact. We aim to acknowledge
reports within a few business days and will keep you updated on remediation.

## Scope

Concord is local-first: the open-source server stores work data in a local SQLite
database and never transmits code, raw file paths, repository remotes, tool
inputs/outputs, task identifiers, or task content. It sends the anonymous,
metadata-only usage events documented in the README to `getconcord.ai` by
default; set `CONCORD_TELEMETRY_DISABLED=1` or `DO_NOT_TRACK=1` to disable them.
Please report anything that contradicts that behavior.
