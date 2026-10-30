import type { Pool } from "pg";
import {
  createPublishContext,
  operationIntentMarker,
  publishOnce,
  qaReportOperationKey,
} from "../../agentWork/publishOnce.ts";
import { fenceForEpoch } from "../../agentWork/writeFence.ts";
import { decodeProgressComment } from "../../github/prSurfaceResults.ts";
import { isKnownNoAcceptanceMutationError } from "../../github/mutationErrorContract.ts";
import { recoverMarkedProgressComment } from "../../github/recoverPrSurfaceMutation.ts";
import type { PrSurface } from "../../github/prSurface.ts";
import {
  escapeTableCellContent,
  escapeTableHtml,
  renderGitHubAlert,
} from "../../github/markdownFormat.ts";
import { redactReviewText } from "../../review/findings/reviewPublicOutput.ts";
import { errorMessage } from "../../errors/errorMessage.ts";
import { logWarn } from "../../evlog.ts";
import { sanitizeLogMessage } from "../../security/sanitizeLogMessage.ts";
import type { QaSandboxStage } from "../../qaSandbox/sandbox.ts";
import {
  QA_CONFIG_PATH,
  QA_FAILURE_MESSAGE,
  QA_PUBLISH_LENS,
  QA_REPORT_HEADER,
  QA_REPORT_MAX_CHARS,
} from "../../settings/index.ts";
import type { QaReport, QaRequestLogEntry } from "./qaRun.ts";

export type QaOutcome =
  | {
      readonly kind: "tested";
      readonly report: QaReport | null;
      readonly requests: readonly QaRequestLogEntry[];
      readonly signInFailures: readonly string[];
    }
  | { readonly kind: "not_configured" }
  | { readonly kind: "config_invalid"; readonly reason: string }
  | { readonly kind: "config_unavailable" }
  | { readonly kind: "fork" }
  | { readonly kind: "too_large" }
  | {
      readonly kind: "setup_failed";
      readonly step: string;
      readonly exitCode: number | null;
      readonly outputTail: string;
    }
  | { readonly kind: "start_failed"; readonly reason: string; readonly logTail: string };

const RESULT_LABEL = { pass: "✅ pass", fail: "❌ fail", blocked: "⏸️ blocked" } as const;

function fenced(text: string): string {
  const body = text.trim().length > 0 ? text.trim().replace(/```/g, "ʼʼʼ") : "(no output)";
  return ["```text", body, "```"].join("\n");
}

function renderTested(outcome: Extract<QaOutcome, { kind: "tested" }>, shortSha: string): string[] {
  const lines: string[] = [];
  const report = outcome.report;
  if (report == null) {
    lines.push(
      renderGitHubAlert(
        "WARNING",
        `The QA run on \`${shortSha}\` ended without a report. The requests it sent are listed below.`,
      ),
    );
  } else {
    const count = (result: keyof typeof RESULT_LABEL) =>
      report.checks.filter((check) => check.result === result).length;
    lines.push(
      renderGitHubAlert(
        "NOTE",
        `Advisory. Ran \`${shortSha}\` in a throwaway sandbox: ${count("fail")} failed, ${count("pass")} passed, ${count("blocked")} blocked.`,
      ),
      "",
      report.summary,
      "",
      "| # | Check | Result |",
      "| --- | --- | --- |",
      ...report.checks.map(
        (check, index) =>
          `| ${index + 1} | ${escapeTableCellContent(check.title)} | ${RESULT_LABEL[check.result]} |`,
      ),
      "",
    );
    report.checks.forEach((check, index) => {
      lines.push(
        `<details><summary>${index + 1}. ${escapeTableHtml(check.title)} — ${check.result}</summary>`,
        "",
        `**Expected:** ${check.expected}`,
        "",
        `**Actual:** ${check.actual}`,
        "",
        ...(check.requests.length > 0
          ? [
              "**Requests:**",
              ...check.requests.map((request) => `- \`${request.replace(/`/g, "'")}\``),
            ]
          : []),
        "",
        "</details>",
      );
    });
  }
  lines.push(
    "",
    `<details><summary>All requests (${outcome.requests.length})</summary>`,
    "",
    "| As | Request | Status | Purpose |",
    "| --- | --- | --- | --- |",
    ...outcome.requests.map(
      (entry) =>
        `| ${escapeTableCellContent(entry.identity)} | ${escapeTableCellContent(`${entry.method} ${entry.path}`)} | ${entry.status} | ${escapeTableCellContent(entry.purpose)} |`,
    ),
    "",
    "</details>",
  );
  if (outcome.signInFailures.length > 0) {
    lines.push("", `Identities that could not sign in: ${outcome.signInFailures.join("; ")}.`);
  }
  return lines;
}

function renderNotice(outcome: Exclude<QaOutcome, { kind: "tested" }>, shortSha: string): string[] {
  switch (outcome.kind) {
    case "not_configured":
      return [
        renderGitHubAlert(
          "NOTE",
          `QA needs \`${QA_CONFIG_PATH}\` on the base branch. It says how to build, seed, and start the app, and which test users to sign in as.`,
        ),
      ];
    case "config_invalid":
      return [
        renderGitHubAlert("WARNING", `\`${QA_CONFIG_PATH}\` on the base branch is not valid.`),
        "",
        fenced(outcome.reason),
      ];
    case "config_unavailable":
      return [
        renderGitHubAlert(
          "WARNING",
          `PR Agent could not read \`${QA_CONFIG_PATH}\` from the base branch. Try \`/qa\` again.`,
        ),
      ];
    case "fork":
      return [
        renderGitHubAlert(
          "NOTE",
          "QA runs only for pull requests from branches in this repository. It does not run code from forks.",
        ),
      ];
    case "too_large":
      return [
        renderGitHubAlert(
          "NOTE",
          "This repository is too large for a full checkout, so QA cannot build it in the sandbox.",
        ),
      ];
    case "setup_failed":
      return [
        renderGitHubAlert(
          "WARNING",
          `The app did not build on \`${shortSha}\`. This setup step exited with code ${outcome.exitCode ?? "unknown"}:`,
        ),
        "",
        fenced(outcome.step),
        "",
        "<details><summary>Last output</summary>",
        "",
        fenced(outcome.outputTail),
        "",
        "</details>",
      ];
    case "start_failed":
      return [
        renderGitHubAlert("WARNING", `The app did not start on \`${shortSha}\`. ${outcome.reason}`),
        "",
        "<details><summary>App log</summary>",
        "",
        fenced(outcome.logTail),
        "",
        "</details>",
      ];
    default: {
      const exhaustive: never = outcome;
      return exhaustive;
    }
  }
}

export function renderQaReport(outcome: QaOutcome, headSha: string): string {
  const shortSha = headSha.slice(0, 7);
  const body = [
    QA_REPORT_HEADER,
    "",
    ...(outcome.kind === "tested"
      ? renderTested(outcome, shortSha)
      : renderNotice(outcome, shortSha)),
  ].join("\n");
  const redacted = redactReviewText(body);
  return redacted.length <= QA_REPORT_MAX_CHARS
    ? redacted
    : `${redacted.slice(0, QA_REPORT_MAX_CHARS)}\n\n…report truncated.`;
}

export type QaProgressStage = QaSandboxStage | { readonly kind: "testing" };

const PROGRESS_STEP_CHARS = 80;

function progressLine(stage: QaProgressStage): string {
  switch (stage.kind) {
    case "creating":
      return "Creating the sandbox. The first run also downloads images.";
    case "setup": {
      const step = stage.step.replace(/\s+/g, " ").replace(/`/g, "'").slice(0, PROGRESS_STEP_CHARS);
      return `Setup step ${stage.index} of ${stage.total}: \`${step}\``;
    }
    case "starting_app":
      return "Starting the app and signing in the test users.";
    case "testing":
      return "Testing the app as each test user.";
    default: {
      const exhaustive: never = stage;
      return exhaustive;
    }
  }
}

export function renderQaProgress(stage: QaProgressStage, headSha: string): string {
  return redactReviewText(
    [
      QA_REPORT_HEADER,
      "",
      renderGitHubAlert(
        "NOTE",
        `Running on \`${headSha.slice(0, 7)}\`. This comment updates as the run moves along and is replaced by the report when it ends.`,
      ),
      "",
      `⏳ ${progressLine(stage)}`,
    ].join("\n"),
  );
}

export async function publishQaProgress(params: {
  readonly prSurface: PrSurface;
  readonly headSha: string;
  readonly stage: QaProgressStage;
}): Promise<void> {
  try {
    await params.prSurface.upsertProgressComment(
      renderQaProgress(params.stage, params.headSha),
      QA_REPORT_HEADER,
    );
  } catch (error) {
    logWarn("qa_progress_publish_failed", {
      stage: params.stage.kind,
      message: sanitizeLogMessage(errorMessage(error)),
    });
  }
}

export async function publishQaFailureNotice(prSurface: PrSurface): Promise<void> {
  try {
    const existing = await prSurface.findProgressComment(QA_REPORT_HEADER);
    if (existing == null) return;
    await prSurface.editComment(
      existing.id,
      [QA_REPORT_HEADER, "", renderGitHubAlert("WARNING", QA_FAILURE_MESSAGE)].join("\n"),
    );
  } catch (error) {
    logWarn("qa_failure_notice_failed", { message: sanitizeLogMessage(errorMessage(error)) });
  }
}

export async function publishQaReport(params: {
  readonly prSurface: PrSurface;
  readonly pool: Pool;
  readonly workItemId: string;
  readonly resourceKey: string;
  readonly leaseEpoch: number | null;
  readonly signal?: AbortSignal;
  readonly body: string;
}): Promise<void> {
  const operationKey = qaReportOperationKey(params.resourceKey);
  const operationMarker = operationIntentMarker(operationKey, params.workItemId);
  const result = await publishOnce<{ readonly id: number; readonly updated: boolean }>({
    decodeResult: decodeProgressComment,
    fence: fenceForEpoch(params.leaseEpoch),
    client: params.pool,
    workItemId: params.workItemId,
    leaseEpoch: params.leaseEpoch,
    operationKey,
    mutationKind: "github.qa_report",
    detail: {
      step: "qa_report",
      resourceKey: params.resourceKey,
      reviewLens: QA_PUBLISH_LENS,
      operationMarker,
    },
    recover: () =>
      recoverMarkedProgressComment(params.prSurface, {
        operationMarker,
        sentinel: QA_REPORT_HEADER,
      }),
    isKnownNoAcceptanceError: isKnownNoAcceptanceMutationError,
    signal: params.signal,
    mutate: () =>
      params.prSurface.upsertProgressComment(
        `${params.body}\n${operationMarker}`,
        QA_REPORT_HEADER,
      ),
  });
  await createPublishContext(params.pool, {
    workItemId: params.workItemId,
    leaseEpoch: params.leaseEpoch,
    resourceKey: params.resourceKey,
    reviewLens: QA_PUBLISH_LENS,
    step: "qa_report",
    githubId: result.id,
    detail: { updated: result.updated },
  }).record();
}
