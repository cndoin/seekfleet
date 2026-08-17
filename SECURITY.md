# Security Policy

## Supported Versions

| Version | Supported          |
|---------|--------------------|
| 0.1.x   | :white_check_mark: |

## Reporting a Vulnerability

If you discover a security vulnerability in this project, please report it
privately rather than opening a public GitHub issue.

Use GitHub's private security advisory form for the published repository. Until publication, contact the repository owner privately.

Please include:

1. A clear description of the vulnerability
2. Steps to reproduce (or a proof-of-concept)
3. The affected version(s)
4. The potential impact (what an attacker could do)

You should expect an acknowledgement within 72 hours. After triage we will
either:

- Confirm the issue and start working on a fix, or
- Decline with a clear explanation (e.g. out of scope / by design)

We follow a 90-day disclosure policy. Critical issues may be patched faster.

## Threat Model

This SDK is a process wrapper around `@deepseek-ai/dsh`. Its threat model is:

### In scope

- Arbitrary code execution via untrusted task prompts passed to `dsh_run` / `dsh_run_stream`
  - The agent may invoke dsh's own tools (bash, fs, web) which can affect the host
  - **Mitigation**: only run this SDK with dsh profiles and LLM credentials you trust
- Path traversal when `cwd` or `patches` come from untrusted callers
  - **Mitigation**: validate `cwd` against an allowlist before calling `DshClient.run`
- TOML injection into `~/.codex/config.toml` via `codexInstall`
  - **Mitigation**: all values are TOML-escaped; user comments and other sections
    are preserved verbatim; parsed with smol-toml before write
- Process spawn DoS via large `replicas` count or runaway task count
  - **Mitigation**: `MaxInstances` and timeouts; rate-limiting recommended at the
    application layer above this SDK

### Out of scope

- Vulnerabilities in `@deepseek-ai/dsh` itself - please report upstream
- Vulnerabilities in LLM providers (DeepSeek, OpenAI, Anthropic, etc.)
- Vulnerabilities in the user's local dsh home directory or its permissions
- Social-engineering attacks against the user

## Sandboxing Recommendations

When exposing this SDK to an LLM agent:

1. Run the entire process under OS-level sandboxing (Windows Job Objects, Linux
   namespaces, macOS sandbox-exec, Docker, gVisor, firecracker, etc.)
2. Set `DSH_HOME` to an isolated directory the agent cannot escape
3. Never commit API keys; load them from the host's secret manager
4. Set a hard `costBudgetUsd` on every `DshCluster` to prevent runaway spend
5. Review the agent's tool permissions per profile (`cordis.patch.yml`)

## Security Hall of Fame

We thank the following reporters (no vulnerabilities reported yet):

_This section will be updated as responsible disclosures are resolved._

## Cryptography Notice

This SDK does not introduce custom cryptography. It uses Node's built-in
`crypto.createHash("sha256")` only for cache-key derivation and integrity
checksums. Authenticated encryption is delegated to TLS (via the underlying
dsh process and LLM provider SDKs).
