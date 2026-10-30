# ADR 0062 — QA sandbox work type

## Status

Accepted. Narrows [ADR 0033](0033-code-mode-execution.md) decision 2 for one slash-only work type. Review, ask, verification, description, and triage keep their read-only harness.

## Context

Review reads code and cannot tell whether a change works when it runs. CI runs the project's own tests, and those cover only what the author wrote tests for. Operators asked PR Agent to exercise a pull request the way a user would: boot the backend against a throwaway database, call its endpoints as each role, and report what works and what breaks.

That means running pull request code. ADR 0033 keeps every model-visible tool inside a QuickJS cell with no process, network, or shell. That rule stays for every existing work type. This work type runs the code in a separate container and gives the model one bounded tool to reach it.

## Decision

1. **Sixth work type, slash-only.** `/qa` on the pull request conversation enqueues one `qa` work item for the current head. `FEATURE_QA` is `off` (default) or `manual`. There is no automatic trigger.

2. **Same-repo pull requests only.** A fork head is refused with a report-only notice. Running a stranger's code needs its own trust decision.

3. **Repository configuration comes from the base commit.** The executor reads `.pr-agent/qa.md` from the recorded base commit, never from the head. YAML frontmatter names the app image, the database image, setup commands, the start command, the health path, environment values, and the sign-in recipe for each QA identity. The markdown body is the playbook given to the model. A missing or invalid file ends the run with a notice and no sandbox.

4. **The sandbox is Docker, reached through the Engine API.** `src/qaSandbox/` talks to the Docker Engine socket over HTTP. It creates one network, one database container, and one app container per run, labelled with the work item id. The head commit is copied in with `git archive`. Containers get memory, CPU, and process limits and no worker environment, credentials, or mounts. Setup and start commands run inside the app container. Every container and the network are removed when the run ends, including on failure.

5. **One model tool reaches the app.** The model keeps the read-only workspace tools description uses, plus `httpRequest`, which sends one request to the app as a named identity. The request runs inside the app container against `127.0.0.1` through `node`, so the worker never joins the sandbox network and the model cannot name another host. The app image must therefore ship Node 18 or later. Responses are truncated and token values are redacted before the model sees them. A run sends at most `QA_MAX_HTTP_REQUESTS` requests. The model ends with `submitQaReport`, which only validates and stores the report; the executor publishes it.

6. **Publish is one upserted conversation comment.** While the run moves along, `## PR Agent QA` shows the current stage: creating the sandbox, each setup step, starting the app, and testing. Progress edits are best effort and never fail the run. The final report replaces that text and lists each check as pass, fail, or blocked, with the requests behind it. A terminal failure edits the comment to a not-finished notice when one exists. The comment is advisory. It sets no check run and no commit status.

## Failure modes

1. Pull request code reaches the worker or its secrets. The app container has no mounts, no worker environment, and no route to the worker; the worker reaches it only through Engine exec.
2. A runaway build or app exhausts the host. Memory, CPU, and process limits apply, and every setup command and the whole run have deadlines.
3. Containers outlive the run. Cleanup runs in a `finally` path, and every object carries the work item label so an operator can remove leftovers by label.
4. The model calls an outside host. The tool accepts a path only and resolves it against the app's loopback port inside the container.
5. Prompt injection in the diff, description, or responses widens what the model does. Its only tools are `http_request` against the sandbox and the report submit.
6. A head commit changes the setup to read secrets. The configuration is read from the base commit, and the sandbox holds no secrets to read.

## Consequences

- The worker needs access to a Docker Engine socket (`QA_DOCKER_SOCKET`). Access to that socket is equivalent to root on the Docker host. Operators who enable `FEATURE_QA` accept that for the worker process. The production image does not ship a Docker client.
- The app container can reach the internet so setup can install dependencies.
- A run costs a model session plus container build time, so it stays manual.

## Reversal

Set `FEATURE_QA=off`, then remove the work type, its queue, `src/qaSandbox/`, and its migration.
