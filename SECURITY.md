# Security Policy

## Reporting a vulnerability

Please do not open a public issue for security vulnerabilities.

Send details privately (e.g., via email or a private message to the maintainer) and include:
- What component is affected
- Steps to reproduce
- Impact

## Supported versions

This is an early-stage project. Only the latest `main` branch is supported.

## Hardening notes

- Never commit `.env`.
- Avoid enabling features that ship raw transcripts externally.
- Prefer running the bot with least privileges and in a restricted environment.
