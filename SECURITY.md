# Security Policy

## Reporting Vulnerabilities

If you discover a security vulnerability, **do not open a public issue**.

Email the maintainer directly or use GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability) feature.

Include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

We aim to acknowledge reports within 48 hours and provide a fix timeline within 7 days.

## Threat Model

This project operates as a **single-user local daemon**:

- The daemon runs on your local machine under your user account
- No network listeners are opened; it connects outbound to Feishu/Lark APIs only
- Authentication is handled by the Feishu/Lark bot token mechanism
- Access control is enforced via allowed user ID lists configured per profile

### Primary threats and mitigations

| Threat | Mitigation |
|--------|------------|
| Token leakage | File permissions (`600`), log redaction, `.gitignore` exclusion |
| Unauthorized message senders | Allowed user ID filtering per Feishu profile |
| Local privilege escalation | Runs as unprivileged user process |
| Sensitive data in chat | Structured input prompts redirect sensitive content to local CLI |

## Credential Storage

All credentials are stored in `~/.agents-to-im/config.env` with file permissions set to `600` (owner read/write only). This file is never committed to version control.

## Log Redaction

All tokens and secrets are masked in log output and terminal display. Only the last 4 characters of any secret are shown (e.g., `****abcd`). This applies to:

- Startup and diagnostic output
- `agents-to-im logs` command
- Error messages and stack traces

## Token Rotation

If a token is compromised or expired:

1. Revoke the old token on the Feishu/Lark platform
2. Generate a new token
3. Update `~/.agents-to-im/config.env`
4. Run `agents-to-im restart`

## Leak Response

If you suspect a token has been leaked:

1. **Immediately revoke** the token on the Feishu/Lark platform
2. Run `agents-to-im stop`
3. Update `config.env` with a new token
4. Review `~/.agents-to-im/logs/` for unauthorized activity
5. Run `agents-to-im start` with the new credentials

## Supported Versions

Security updates are applied to the latest version on `main`. There is no LTS or backporting at this time.
