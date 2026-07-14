# Security policy

## Supported versions

The latest `0.1.x` release is supported with security fixes.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's security advisory form:

<https://github.com/Jeecabs/gang/security/advisories/new>

Do not open a public issue for an undisclosed vulnerability. Include the affected version, reproduction steps, impact, and any suggested mitigation. We will acknowledge reports as soon as practical and coordinate disclosure with the reporter.

## Security model

`gang` is a local Pi extension. It runs with the current user's permissions, starts local processes, writes state under `~/.pi/agent/intercom`, and serves mission control on loopback only. Review extension source before installing it, and treat tasks given to spawned agents as code execution with the same local trust boundary as Pi itself.
