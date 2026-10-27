import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { AppError } from "../errors/appError.ts";
import { logWarn } from "../evlog.ts";
import {
  QA_APP_MEMORY_BYTES,
  QA_APP_NANO_CPUS,
  QA_APP_READY_TIMEOUT_MS,
  QA_ARCHIVE_UPLOAD_TIMEOUT_MS,
  QA_DATABASE_MEMORY_BYTES,
  QA_DATABASE_NANO_CPUS,
  QA_DATABASE_READY_TIMEOUT_MS,
  QA_EXEC_MAX_OUTPUT_BYTES,
  QA_HTTP_MAX_BODY_CHARS,
  QA_HTTP_TIMEOUT_MS,
  QA_IMAGE_PULL_TIMEOUT_MS,
  QA_PIDS_LIMIT,
  QA_READY_POLL_MS,
  QA_SETUP_OUTPUT_TAIL_CHARS,
  QA_SETUP_STEP_TIMEOUT_MS,
  QA_WORKSPACE_DIR,
} from "../settings/index.ts";
import { isRecord } from "../util/typeGuards.ts";
import type { DockerEngine } from "./dockerEngine.ts";
import { signInBody, type QaConfig } from "./qaConfig.ts";

export const QA_ANONYMOUS_IDENTITY = "ANONYMOUS";
export const QA_HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type QaHttpMethod = (typeof QA_HTTP_METHODS)[number];

const APP_LOG_PATH = "/tmp/pr-agent-qa-app.log";
const DATABASE_USER = "qa";
const DATABASE_NAME = "qa";
const DATABASE_ALIAS = "db";
const JWT_SHAPE = /eyJ[\w-]+\.[\w-]+\.[\w-]+/g;

const IN_CONTAINER_FETCH = [
  "const a=JSON.parse(process.argv[1]);",
  "fetch(a.url,{method:a.method,headers:a.headers,body:a.body,signal:AbortSignal.timeout(a.timeoutMs)})",
  ".then(async r=>{const t=await r.text();process.stdout.write(JSON.stringify({status:r.status,body:t.slice(0,a.maxChars)}))})",
  ".catch(e=>{process.stdout.write(JSON.stringify({error:String((e&&e.message)||e)}))})",
].join("");

export type QaHttpCall = {
  readonly identity: string;
  readonly method: QaHttpMethod;
  readonly path: string;
  readonly body?: unknown;
};

export type QaHttpResult =
  | { readonly kind: "response"; readonly status: number; readonly body: string }
  | { readonly kind: "error"; readonly message: string };

export type QaSandbox = {
  readonly identities: readonly string[];
  readonly signInFailures: readonly string[];
  readonly request: (call: QaHttpCall) => Promise<QaHttpResult>;
};

export type QaSandboxOutcome =
  | { readonly kind: "ready"; readonly sandbox: QaSandbox }
  | {
      readonly kind: "setup_failed";
      readonly step: string;
      readonly exitCode: number | null;
      readonly outputTail: string;
    }
  | { readonly kind: "start_failed"; readonly reason: string; readonly logTail: string };

export type QaSandboxParams = {
  readonly engine: DockerEngine;
  readonly config: QaConfig;
  readonly archive: Buffer;
  readonly runId: string;
  readonly signal?: AbortSignal;
};

function tail(text: string): string {
  return text.length <= QA_SETUP_OUTPUT_TAIL_CHARS
    ? text
    : text.slice(text.length - QA_SETUP_OUTPUT_TAIL_CHARS);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new AppError({ domain: "qa", kind: "aborted", message: "QA run was aborted" });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readField(value: unknown, field: string): unknown {
  let current = value;
  for (const key of field.split(".")) {
    if (!isRecord(current) || !Object.hasOwn(current, key)) return undefined;
    current = current[key];
  }
  return current;
}

function parseFetchOutput(output: string): QaHttpResult {
  try {
    const parsed: unknown = JSON.parse(output.trim());
    if (isRecord(parsed) && typeof parsed.status === "number" && typeof parsed.body === "string") {
      return { kind: "response", status: parsed.status, body: parsed.body };
    }
    if (isRecord(parsed) && typeof parsed.error === "string") {
      return { kind: "error", message: parsed.error };
    }
  } catch {
    return { kind: "error", message: tail(output.trim()) || "no output from the sandbox request" };
  }
  return { kind: "error", message: "unexpected sandbox request output" };
}

function redactTokens(text: string, tokens: readonly string[]): string {
  let out = text;
  for (const token of tokens) {
    if (token.length > 0) out = out.split(token).join("[token]");
  }
  return out.replace(JWT_SHAPE, "[jwt]");
}

export async function withQaSandbox<T>(
  params: QaSandboxParams,
  run: (outcome: QaSandboxOutcome) => Promise<T>,
): Promise<T> {
  const { engine, config, signal } = params;
  const baseName = `pr-agent-qa-${params.runId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 24)}`;
  const labels = { "pr-agent.qa": params.runId };
  const containers: string[] = [];
  let networkId: string | null = null;

  try {
    await engine.ensureImage(config.app.image, QA_IMAGE_PULL_TIMEOUT_MS);
    if (config.database) await engine.ensureImage(config.database.image, QA_IMAGE_PULL_TIMEOUT_MS);
    throwIfAborted(signal);
    networkId = await engine.createNetwork(baseName, labels);

    const env: Record<string, string> = { ...config.app.env };
    for (const name of config.app.secrets) env[name] = randomBytes(32).toString("hex");

    if (config.database) {
      const databaseId = await engine.createContainer({
        name: `${baseName}-db`,
        image: config.database.image,
        env: {
          POSTGRES_USER: DATABASE_USER,
          POSTGRES_PASSWORD: DATABASE_USER,
          POSTGRES_DB: DATABASE_NAME,
        },
        networkName: baseName,
        networkAlias: DATABASE_ALIAS,
        labels,
        memoryBytes: QA_DATABASE_MEMORY_BYTES,
        nanoCpus: QA_DATABASE_NANO_CPUS,
        pidsLimit: QA_PIDS_LIMIT,
      });
      containers.push(databaseId);
      await engine.startContainer(databaseId);
      const ready = await waitFor(QA_DATABASE_READY_TIMEOUT_MS, signal, async () => {
        const probe = await engine.exec(databaseId, {
          cmd: ["pg_isready", "-h", "127.0.0.1", "-U", DATABASE_USER, "-d", DATABASE_NAME],
          timeoutMs: QA_HTTP_TIMEOUT_MS,
          maxOutputBytes: QA_EXEC_MAX_OUTPUT_BYTES,
        });
        return probe.exitCode === 0;
      });
      if (!ready) {
        return await run({
          kind: "start_failed",
          reason: "The database did not become ready in time.",
          logTail: "",
        });
      }
      env[config.database.urlEnv] =
        `postgresql://${DATABASE_USER}:${DATABASE_USER}@${DATABASE_ALIAS}:5432/${DATABASE_NAME}`;
    }

    const appId = await engine.createContainer({
      name: `${baseName}-app`,
      image: config.app.image,
      env,
      cmd: ["sleep", "infinity"],
      networkName: baseName,
      networkAlias: "app",
      labels,
      memoryBytes: QA_APP_MEMORY_BYTES,
      nanoCpus: QA_APP_NANO_CPUS,
      pidsLimit: QA_PIDS_LIMIT,
    });
    containers.push(appId);
    await engine.startContainer(appId);
    await engine.exec(appId, {
      cmd: ["mkdir", "-p", QA_WORKSPACE_DIR],
      timeoutMs: QA_HTTP_TIMEOUT_MS,
      maxOutputBytes: QA_EXEC_MAX_OUTPUT_BYTES,
    });
    await engine.putArchive(
      appId,
      QA_WORKSPACE_DIR,
      Readable.from(params.archive),
      QA_ARCHIVE_UPLOAD_TIMEOUT_MS,
    );

    for (const step of config.app.setup) {
      throwIfAborted(signal);
      const result = await engine.exec(appId, {
        cmd: ["sh", "-lc", step],
        workdir: QA_WORKSPACE_DIR,
        timeoutMs: QA_SETUP_STEP_TIMEOUT_MS,
        maxOutputBytes: QA_EXEC_MAX_OUTPUT_BYTES,
      });
      if (result.exitCode !== 0) {
        return await run({
          kind: "setup_failed",
          step,
          exitCode: result.exitCode,
          outputTail: tail(result.output),
        });
      }
    }

    throwIfAborted(signal);
    await engine.execDetached(appId, {
      cmd: ["sh", "-lc", `${config.app.start} > ${APP_LOG_PATH} 2>&1`],
      workdir: QA_WORKSPACE_DIR,
    });

    const fetchInApp = async (
      method: QaHttpMethod,
      path: string,
      headers: Record<string, string>,
      body: string | undefined,
    ): Promise<QaHttpResult> => {
      const request = {
        url: `http://127.0.0.1:${config.app.port}${path}`,
        method,
        headers,
        body,
        timeoutMs: QA_HTTP_TIMEOUT_MS,
        maxChars: QA_HTTP_MAX_BODY_CHARS,
      };
      const result = await engine.exec(appId, {
        cmd: ["node", "-e", IN_CONTAINER_FETCH, JSON.stringify(request)],
        timeoutMs: QA_HTTP_TIMEOUT_MS + 5_000,
        maxOutputBytes: QA_EXEC_MAX_OUTPUT_BYTES,
      });
      return parseFetchOutput(result.output);
    };

    const healthy = await waitFor(QA_APP_READY_TIMEOUT_MS, signal, async () => {
      const probe = await fetchInApp("GET", config.app.health, {}, undefined);
      return probe.kind === "response" && probe.status >= 200 && probe.status < 400;
    });
    if (!healthy) {
      const log = await engine.exec(appId, {
        cmd: ["sh", "-lc", `tail -c ${QA_SETUP_OUTPUT_TAIL_CHARS} ${APP_LOG_PATH} 2>/dev/null`],
        timeoutMs: QA_HTTP_TIMEOUT_MS,
        maxOutputBytes: QA_EXEC_MAX_OUTPUT_BYTES,
      });
      return await run({
        kind: "start_failed",
        reason: `The app did not answer ${config.app.health} in time.`,
        logTail: tail(log.output),
      });
    }

    const tokens = new Map<string, string>();
    const signInFailures: string[] = [];
    const { signIn } = config.identities;
    for (const [identity, login] of Object.entries(config.identities.users)) {
      const response = await fetchInApp(
        signIn.method,
        signIn.path,
        { "content-type": "application/json" },
        JSON.stringify(signInBody(signIn.body, login)),
      );
      if (response.kind !== "response" || response.status >= 400) {
        signInFailures.push(
          `${identity} (${response.kind === "response" ? `HTTP ${response.status}` : response.message})`,
        );
        continue;
      }
      let token: unknown;
      try {
        token = readField(JSON.parse(response.body), signIn.tokenField);
      } catch {
        token = undefined;
      }
      if (typeof token !== "string" || token.length === 0) {
        signInFailures.push(`${identity} (no ${signIn.tokenField} in the response)`);
        continue;
      }
      tokens.set(identity, token);
    }
    const tokenValues = [...tokens.values()];

    const sandbox: QaSandbox = {
      identities: [...tokens.keys(), QA_ANONYMOUS_IDENTITY],
      signInFailures,
      async request(call) {
        const token = tokens.get(call.identity);
        if (call.identity !== QA_ANONYMOUS_IDENTITY && token == null) {
          return { kind: "error", message: `Unknown identity ${call.identity}` };
        }
        const headers: Record<string, string> = { accept: "application/json" };
        if (token != null) headers.authorization = `Bearer ${token}`;
        let body: string | undefined;
        if (call.body !== undefined) {
          headers["content-type"] = "application/json";
          body = JSON.stringify(call.body);
        }
        const result = await fetchInApp(call.method, call.path, headers, body);
        return result.kind === "response"
          ? { ...result, body: redactTokens(result.body, tokenValues) }
          : { kind: "error", message: redactTokens(result.message, tokenValues) };
      },
    };
    return await run({ kind: "ready", sandbox });
  } finally {
    for (const id of containers.toReversed()) {
      await engine.removeContainer(id).catch((error: unknown) => {
        logWarn("qa_sandbox_container_remove_failed", { runId: params.runId, error });
      });
    }
    if (networkId != null) {
      await engine.removeNetwork(networkId).catch((error: unknown) => {
        logWarn("qa_sandbox_network_remove_failed", { runId: params.runId, error });
      });
    }
  }
}

async function waitFor(
  timeoutMs: number,
  signal: AbortSignal | undefined,
  probe: () => Promise<boolean>,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    if (await probe()) return true;
    await sleep(QA_READY_POLL_MS);
  }
  return false;
}
