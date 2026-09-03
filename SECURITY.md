# Security policy

## Supported version

Security fixes are applied to the latest commit on the default branch.

## Reporting a vulnerability

Do not disclose credentials, private conversation content, internal document
links, or personal data in a public issue. Report vulnerabilities privately to
the repository maintainers through GitHub's private vulnerability reporting.

## Deployment baseline

- Keep all API keys and Feishu/Lark credentials outside Git.
- Expose the web application only through HTTPS and authentication.
- Keep the Harness and Gateway ports bound to localhost or a private network.
- Use a separate database and credential set for each deployment.
- Rotate any credential that has appeared in logs, screenshots, commits, or chat.
