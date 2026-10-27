import * as v from "valibot";
import {
  type Config,
  MAX_TOOL_ROUNDS_QA,
  QA_HTTP_MAX_REQUEST_BODY_CHARS,
  QA_MAX_CHECKS,
  QA_MAX_HTTP_REQUESTS,
  QA_PRE_SUBMIT_NUDGE_ROUNDS,
  QA_VALIDATION_REPAIR_ROUNDS,
  SUBMIT_ONLY_MAX_TOOL_ROUNDS,
} from "../../settings/index.ts";
import {
  buildQaUserContent,
  qaSystemPrompt,
  QA_SUBMIT_ONLY_NUDGE,
  renderQaRepairPrompt,
} from "../../prompts/qa/prompt.ts";
import type { LocalPrWorkspace } from "../../prWorkspace/localPrWorkspace.ts";
import {
  QA_ANONYMOUS_IDENTITY,
  QA_HTTP_METHODS,
  type QaHttpMethod,
  type QaSandbox,
} from "../../qaSandbox/sandbox.ts";
import { escalatedToolRounds, type EscalationPlan } from "../../agentWork/retryPolicy.ts";
import { errorMessage } from "../../errors/errorMessage.ts";
import { createAskPathGate } from "../ask/askSafety.ts";
import { buildWorkspaceTools } from "../tools/workspaceToolset.ts";
import { defineLocalTool, toExecutor, toPiTool } from "../tools/defineWorkspaceTool.ts";
import { runFeatureAgent } from "../runtime/featureAgent.ts";
import type {
  createFeaturePiSession,
  FeatureSessionContext,
} from "../runtime/createFeatureSession.ts";

const QA_RESULTS = ["pass", "fail", "blocked"] as const;

const text = (max: number) => v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(max));

export const qaReportSchema = v.object({
  summary: text(1500),
  checks: v.pipe(
    v.array(
      v.object({
        title: text(200),
        result: v.picklist(QA_RESULTS),
        expected: text(1500),
        actual: text(2500),
        requests: v.pipe(v.array(text(300)), v.maxLength(30)),
      }),
    ),
    v.minLength(1),
    v.maxLength(QA_MAX_CHECKS),
  ),
});

export type QaReport = v.InferOutput<typeof qaReportSchema>;

export type QaRequestLogEntry = {
  readonly identity: string;
  readonly method: QaHttpMethod;
  readonly path: string;
  readonly purpose: string;
  readonly status: number | "error";
};

export type QaRunResult = {
  readonly report: QaReport | null;
  readonly requests: readonly QaRequestLogEntry[];
};

const httpRequestSchema = v.object({
  identity: v.pipe(v.string(), v.minLength(1), v.maxLength(40)),
  method: v.picklist(QA_HTTP_METHODS),
  path: v.pipe(
    v.string(),
    v.startsWith("/"),
    v.maxLength(2000),
    v.regex(/^[^\s]+$/, "path must not contain whitespace"),
  ),
  body: v.optional(v.unknown()),
  purpose: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(300)),
});

const HTTP_REQUEST_DESCRIPTION =
  "Send one HTTP request to the running app in the QA sandbox as one identity. Give a path only; the host is fixed.";
const SUBMIT_QA_REPORT_DESCRIPTION = "Submit the QA report. Call it once, when testing is done.";

export function qaNativePiTools() {
  return [
    toPiTool("httpRequest", { description: HTTP_REQUEST_DESCRIPTION, schema: httpRequestSchema }),
    toPiTool("submitQaReport", {
      description: SUBMIT_QA_REPORT_DESCRIPTION,
      schema: qaReportSchema,
    }),
  ];
}

export async function runQa(params: {
  readonly cfg: Config;
  readonly workspace: LocalPrWorkspace;
  readonly sandbox: QaSandbox;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly title: string;
  readonly description: string;
  readonly playbook: string;
  readonly userSupplement?: string;
  readonly escalation?: EscalationPlan;
  readonly sessionContext?: FeatureSessionContext;
  readonly signal?: AbortSignal;
  readonly createSession?: typeof createFeaturePiSession;
}): Promise<QaRunResult> {
  const { sandbox } = params;
  const requests: QaRequestLogEntry[] = [];
  const state: { lastValidationError: string | null; payload: QaReport | null } = {
    lastValidationError: null,
    payload: null,
  };

  const httpRequest = defineLocalTool({
    description: HTTP_REQUEST_DESCRIPTION,
    schema: httpRequestSchema,
    run: async (input) => {
      if (!sandbox.identities.includes(input.identity)) {
        return { error: `Unknown identity. Use one of: ${sandbox.identities.join(", ")}` };
      }
      if (requests.length >= QA_MAX_HTTP_REQUESTS) {
        return { error: "Request budget used up. Call submitQaReport with the checks you ran." };
      }
      if (
        input.body !== undefined &&
        JSON.stringify(input.body).length > QA_HTTP_MAX_REQUEST_BODY_CHARS
      ) {
        return { error: "Request body is too large." };
      }
      const entry = {
        identity: input.identity,
        method: input.method,
        path: input.path,
        purpose: input.purpose,
      };
      try {
        const result = await sandbox.request({
          identity: input.identity,
          method: input.method,
          path: input.path,
          body: input.body,
        });
        requests.push({ ...entry, status: result.kind === "response" ? result.status : "error" });
        return result.kind === "response"
          ? { status: result.status, body: result.body }
          : { error: result.message };
      } catch (error) {
        requests.push({ ...entry, status: "error" });
        return { error: errorMessage(error) };
      }
    },
  });

  const submitQaReport = defineLocalTool({
    description: SUBMIT_QA_REPORT_DESCRIPTION,
    schema: qaReportSchema,
    run: async (report) => {
      state.payload = report;
      state.lastValidationError = null;
      return { ok: true };
    },
  });

  const workspaceTools = buildWorkspaceTools(params.workspace.reader, {
    pathGate: createAskPathGate(),
  });
  const submitExecutor = toExecutor("submitQaReport", submitQaReport);

  await runFeatureAgent(
    {
      state,
      shouldContinue: () => state.payload == null,
      userContent: buildQaUserContent({
        owner: params.owner,
        repo: params.repo,
        prNumber: params.prNumber,
        headSha: params.headSha,
        title: params.title,
        description: params.description,
        identities: sandbox.identities,
        anonymousIdentity: QA_ANONYMOUS_IDENTITY,
        signInFailures: sandbox.signInFailures,
        playbook: params.playbook,
        userSupplement: params.userSupplement,
      }),
      investigation: {
        maxToolRounds: escalatedToolRounds(MAX_TOOL_ROUNDS_QA, params.escalation),
        phase: "qa",
        checkpointId: "qa:qa",
      },
      finalize: { maxToolRounds: SUBMIT_ONLY_MAX_TOOL_ROUNDS, phase: "qa", checkpointId: "qa:qa" },
      nudge: QA_SUBMIT_ONLY_NUDGE,
      nudgeRounds: QA_PRE_SUBMIT_NUDGE_ROUNDS,
      repairRounds: QA_VALIDATION_REPAIR_ROUNDS,
      repairPrompt: renderQaRepairPrompt,
    },
    {
      createSession: params.createSession,
      session: {
        role: "qa",
        cfg: params.cfg,
        cwd: params.workspace.agentCwd,
        systemPrompt: qaSystemPrompt,
        tools: [...workspaceTools.piTools, ...qaNativePiTools()],
        executors: {
          ...workspaceTools.executors,
          httpRequest: toExecutor("httpRequest", httpRequest),
          submitQaReport: async (args, ctx) => {
            try {
              return await submitExecutor(args, ctx);
            } catch (error) {
              state.lastValidationError = errorMessage(error);
              throw error;
            }
          },
        },
        sessionContext: params.sessionContext,
        attemptModel: params.escalation?.model,
        hostSignal: params.signal,
      },
    },
  );

  return { report: state.payload, requests };
}
