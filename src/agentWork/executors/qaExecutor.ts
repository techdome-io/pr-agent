import type { WorkExecution, WorkExecutionDependencies } from "../workDefinition.ts";
import type { DurableExecutionResult } from "../durableJob.ts";
import type { QaWorkItem } from "../types.ts";
import { runQa } from "../../agent/qa/qaRun.ts";
import {
  publishQaFailureNotice,
  publishQaProgress,
  publishQaReport,
  renderQaReport,
  type QaOutcome,
  type QaProgressStage,
} from "../../agent/qa/publishQa.ts";
import { pullRequestBranchInfo } from "../../github/listPullRequestFiles.ts";
import type { PrRepositoryView } from "../../prWorkspace/prRepositoryView.ts";
import { createDockerEngine } from "../../qaSandbox/dockerEngine.ts";
import { parseQaConfig } from "../../qaSandbox/qaConfig.ts";
import { withQaSandbox } from "../../qaSandbox/sandbox.ts";
import {
  QA_ARCHIVE_TIMEOUT_MS,
  QA_FAILURE_MESSAGE,
  QA_MAX_ARCHIVE_BYTES,
  QA_MAX_DESCRIPTION_CHARS,
} from "../../settings/index.ts";

type QaExecutionContext = Parameters<WorkExecution<"qa">["execute"]>[1];

async function showProgress(env: QaExecutionContext, stage: QaProgressStage): Promise<void> {
  if (await env.shouldAbortPublish().catch(() => true)) return;
  await publishQaProgress({ prSurface: env.prSurface, headSha: env.headSha, stage });
}

export function createQaWorkExecution({
  cfg,
  pool,
  createSession,
}: WorkExecutionDependencies): WorkExecution<"qa"> {
  async function publish(
    item: QaWorkItem,
    env: QaExecutionContext,
    outcome: QaOutcome,
  ): Promise<DurableExecutionResult> {
    if (await env.shouldAbortPublish()) return { kind: "completed" };
    await publishQaReport({
      prSurface: env.prSurface,
      pool,
      workItemId: item.id,
      resourceKey: item.resourceKey,
      leaseEpoch: env.leaseEpoch,
      signal: env.signal,
      body: renderQaReport(outcome, env.headSha),
    });
    const checks = outcome.kind === "tested" ? outcome.report?.checks : undefined;
    return {
      kind: "completed",
      completion: {
        kind: "qa",
        outcome: "published",
        ...(checks != null
          ? {
              checks: checks.length,
              failedChecks: checks.filter((check) => check.result === "fail").length,
            }
          : {}),
      },
    };
  }

  async function testInSandbox(
    item: QaWorkItem,
    env: QaExecutionContext,
    view: PrRepositoryView,
    pullRequest: { readonly title: string; readonly body: string | null },
  ): Promise<QaOutcome> {
    const source = view.workspace.qaSource;
    if (source == null) return { kind: "config_unavailable" };
    if (source.config.kind === "absent") return { kind: "not_configured" };
    if (source.config.kind === "unavailable") {
      return source.config.reason === "over_cap"
        ? { kind: "config_invalid", reason: "The file is larger than the allowed size." }
        : { kind: "config_unavailable" };
    }
    const parsed = parseQaConfig(source.config.body);
    if (parsed.kind === "invalid") return { kind: "config_invalid", reason: parsed.reason };
    if (source.checkoutMode !== "full") return { kind: "too_large" };

    const archive = await source.archiveHead(QA_MAX_ARCHIVE_BYTES, QA_ARCHIVE_TIMEOUT_MS);
    return withQaSandbox(
      {
        engine: createDockerEngine(cfg.qa.dockerSocket),
        config: parsed.config,
        archive,
        runId: item.id,
        signal: env.signal,
        onStage: (stage) => showProgress(env, stage),
      },
      async (sandbox): Promise<QaOutcome> => {
        if (sandbox.kind !== "ready") return sandbox;
        await showProgress(env, { kind: "testing" });
        const result = await runQa({
          cfg,
          workspace: view.workspace,
          sandbox: sandbox.sandbox,
          owner: item.owner,
          repo: item.repo,
          prNumber: item.prNumber,
          headSha: env.headSha,
          title: pullRequest.title,
          description: (pullRequest.body ?? "").slice(0, QA_MAX_DESCRIPTION_CHARS),
          playbook: parsed.config.playbook,
          userSupplement: item.payload.userSupplement,
          escalation: env.escalation,
          sessionContext: env.durability,
          signal: env.signal,
          createSession,
        });
        return {
          kind: "tested",
          report: result.report,
          requests: result.requests,
          signInFailures: sandbox.sandbox.signInFailures,
        };
      },
    );
  }

  return {
    execute: async (item, env) => {
      const pullRequest = env.pullRequest ?? (await env.prSurface.getHead()).pullRequest;
      if (!pullRequestBranchInfo(pullRequest).sameRepo) {
        return publish(item, env, { kind: "fork" });
      }
      return env.withAdmittedRepositoryView(
        {
          repositorySizeKb: item.payload.repositorySizeKb,
          baseSha: pullRequest.base?.sha ?? undefined,
        },
        async (view) => publish(item, env, await testInSandbox(item, env, view, pullRequest)),
      );
    },
    onTerminalFailure: async (item, prSurface) => {
      if (!prSurface) return;
      await publishQaFailureNotice(prSurface);
      await prSurface.replyAt(
        { kind: "prConversation", prNumber: item.prNumber },
        QA_FAILURE_MESSAGE,
      );
    },
  };
}
