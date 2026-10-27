import { request as httpRequest } from "node:http";
import type { Readable } from "node:stream";
import { AppError } from "../errors/appError.ts";
import { isRecord } from "../util/typeGuards.ts";

const ENGINE_API_VERSION = "v1.43";
const ENGINE_CONTROL_TIMEOUT_MS = 30_000;
const ENGINE_ERROR_BODY_CHARS = 500;

export type EngineResponse = { readonly status: number; readonly body: Buffer };

export type ContainerSpec = {
  readonly name: string;
  readonly image: string;
  readonly env: Readonly<Record<string, string>>;
  readonly cmd?: readonly string[];
  readonly networkName: string;
  readonly networkAlias: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly memoryBytes: number;
  readonly nanoCpus: number;
  readonly pidsLimit: number;
};

export type ExecRequest = {
  readonly cmd: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly workdir?: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
};

export type ExecResult = { readonly exitCode: number | null; readonly output: string };

export type DockerEngine = {
  readonly ensureImage: (image: string, timeoutMs: number) => Promise<void>;
  readonly createNetwork: (
    name: string,
    labels: Readonly<Record<string, string>>,
  ) => Promise<string>;
  readonly removeNetwork: (id: string) => Promise<void>;
  readonly createContainer: (spec: ContainerSpec) => Promise<string>;
  readonly startContainer: (id: string) => Promise<void>;
  readonly removeContainer: (id: string) => Promise<void>;
  readonly putArchive: (
    id: string,
    path: string,
    archive: Readable,
    timeoutMs: number,
  ) => Promise<void>;
  readonly exec: (id: string, request: ExecRequest) => Promise<ExecResult>;
  readonly execDetached: (
    id: string,
    request: Omit<ExecRequest, "timeoutMs" | "maxOutputBytes">,
  ) => Promise<void>;
};

type SendOptions = {
  readonly json?: unknown;
  readonly archive?: Readable;
  readonly timeoutMs: number;
  readonly maxBodyBytes?: number;
};

function engineError(
  kind: "docker_request_failed" | "docker_timeout",
  message: string,
  context: Record<string, unknown>,
  cause?: unknown,
): AppError {
  return new AppError({ domain: "qa", kind, message, context, cause });
}

function engineRequest(
  socketPath: string,
  method: string,
  path: string,
  options: SendOptions,
): Promise<EngineResponse> {
  return new Promise((resolve, reject) => {
    const payload = options.json === undefined ? null : Buffer.from(JSON.stringify(options.json));
    const headers: Record<string, string> = {};
    if (payload) {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(payload.length);
    } else if (options.archive) {
      headers["content-type"] = "application/x-tar";
    }
    const maxBodyBytes = options.maxBodyBytes ?? Number.POSITIVE_INFINITY;
    const req = httpRequest(
      { socketPath, method, path: `/${ENGINE_API_VERSION}${path}`, headers },
      (res) => {
        const chunks: Buffer[] = [];
        let kept = 0;
        res.on("data", (chunk: Buffer) => {
          if (kept >= maxBodyBytes) return;
          const room = maxBodyBytes - kept;
          const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
          chunks.push(part);
          kept += part.length;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
        res.on("error", reject);
      },
    );
    const timer = setTimeout(() => {
      req.destroy(
        engineError("docker_timeout", "Docker Engine request timed out", {
          method,
          path,
          timeoutMs: options.timeoutMs,
        }),
      );
    }, options.timeoutMs);
    req.on("close", () => clearTimeout(timer));
    req.on("error", (error) => {
      clearTimeout(timer);
      reject(
        error instanceof AppError
          ? error
          : engineError(
              "docker_request_failed",
              "Docker Engine request failed",
              { method, path },
              error,
            ),
      );
    });
    if (payload) {
      req.end(payload);
    } else if (options.archive) {
      options.archive.on("error", (error) => req.destroy(error));
      options.archive.pipe(req);
    } else {
      req.end();
    }
  });
}

function engineMessage(body: Buffer): string {
  const text = body.toString("utf8");
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed) && typeof parsed.message === "string") return parsed.message;
  } catch {
    return text.slice(0, ENGINE_ERROR_BODY_CHARS);
  }
  return text.slice(0, ENGINE_ERROR_BODY_CHARS);
}

function expectStatus(
  response: EngineResponse,
  accepted: readonly number[],
  operation: string,
): EngineResponse {
  if (accepted.includes(response.status)) return response;
  throw engineError("docker_request_failed", `Docker Engine ${operation} failed`, {
    operation,
    status: response.status,
    engineMessage: engineMessage(response.body),
  });
}

function readId(response: EngineResponse, operation: string): string {
  const parsed: unknown = JSON.parse(response.body.toString("utf8"));
  if (isRecord(parsed) && typeof parsed.Id === "string") return parsed.Id;
  throw engineError("docker_request_failed", `Docker Engine ${operation} returned no id`, {
    operation,
  });
}

function pullStreamError(body: Buffer): string | null {
  for (const line of body.toString("utf8").split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRecord(parsed) && typeof parsed.error === "string") return parsed.error;
    } catch {
      continue;
    }
  }
  return null;
}

function envList(env: Readonly<Record<string, string>> | undefined): string[] {
  return Object.entries(env ?? {}).map(([key, value]) => `${key}=${value}`);
}

export function createDockerEngine(socketPath: string): DockerEngine {
  const control = (method: string, path: string, json?: unknown) =>
    engineRequest(socketPath, method, path, { json, timeoutMs: ENGINE_CONTROL_TIMEOUT_MS });

  async function createExec(
    id: string,
    request: Omit<ExecRequest, "timeoutMs" | "maxOutputBytes">,
  ) {
    const created = expectStatus(
      await control("POST", `/containers/${encodeURIComponent(id)}/exec`, {
        AttachStdout: true,
        AttachStderr: true,
        Tty: true,
        Cmd: request.cmd,
        Env: envList(request.env),
        ...(request.workdir ? { WorkingDir: request.workdir } : {}),
      }),
      [201],
      "exec create",
    );
    return readId(created, "exec create");
  }

  return {
    async ensureImage(image, timeoutMs) {
      const inspected = await control("GET", `/images/${encodeURIComponent(image)}/json`);
      if (inspected.status === 200) return;
      const pulled = expectStatus(
        await engineRequest(
          socketPath,
          "POST",
          `/images/create?fromImage=${encodeURIComponent(image)}`,
          {
            timeoutMs,
          },
        ),
        [200],
        "image pull",
      );
      const streamError = pullStreamError(pulled.body);
      if (streamError) {
        throw engineError("docker_request_failed", "Docker Engine image pull failed", {
          image,
          engineMessage: streamError,
        });
      }
    },

    async createNetwork(name, labels) {
      const created = expectStatus(
        await control("POST", "/networks/create", {
          Name: name,
          Labels: labels,
          CheckDuplicate: true,
        }),
        [201],
        "network create",
      );
      return readId(created, "network create");
    },

    async removeNetwork(id) {
      expectStatus(
        await control("DELETE", `/networks/${encodeURIComponent(id)}`),
        [204, 404],
        "network remove",
      );
    },

    async createContainer(spec) {
      const created = expectStatus(
        await control("POST", `/containers/create?name=${encodeURIComponent(spec.name)}`, {
          Image: spec.image,
          Env: envList(spec.env),
          ...(spec.cmd ? { Cmd: spec.cmd } : {}),
          Labels: spec.labels,
          HostConfig: {
            NetworkMode: spec.networkName,
            Memory: spec.memoryBytes,
            MemorySwap: spec.memoryBytes,
            NanoCpus: spec.nanoCpus,
            PidsLimit: spec.pidsLimit,
            SecurityOpt: ["no-new-privileges"],
          },
          NetworkingConfig: {
            EndpointsConfig: { [spec.networkName]: { Aliases: [spec.networkAlias] } },
          },
        }),
        [201],
        "container create",
      );
      return readId(created, "container create");
    },

    async startContainer(id) {
      expectStatus(
        await control("POST", `/containers/${encodeURIComponent(id)}/start`),
        [204, 304],
        "container start",
      );
    },

    async removeContainer(id) {
      expectStatus(
        await control("DELETE", `/containers/${encodeURIComponent(id)}?force=true&v=true`),
        [204, 404],
        "container remove",
      );
    },

    async putArchive(id, path, archive, timeoutMs) {
      expectStatus(
        await engineRequest(
          socketPath,
          "PUT",
          `/containers/${encodeURIComponent(id)}/archive?path=${encodeURIComponent(path)}`,
          { archive, timeoutMs },
        ),
        [200],
        "archive upload",
      );
    },

    async exec(id, request) {
      const execId = await createExec(id, request);
      const started = await engineRequest(
        socketPath,
        "POST",
        `/exec/${encodeURIComponent(execId)}/start`,
        {
          json: { Detach: false, Tty: true },
          timeoutMs: request.timeoutMs,
          maxBodyBytes: request.maxOutputBytes,
        },
      );
      expectStatus(started, [200], "exec start");
      const inspected = expectStatus(
        await control("GET", `/exec/${encodeURIComponent(execId)}/json`),
        [200],
        "exec inspect",
      );
      const parsed: unknown = JSON.parse(inspected.body.toString("utf8"));
      const exitCode =
        isRecord(parsed) && typeof parsed.ExitCode === "number" ? parsed.ExitCode : null;
      return { exitCode, output: started.body.toString("utf8") };
    },

    async execDetached(id, request) {
      const execId = await createExec(id, request);
      expectStatus(
        await control("POST", `/exec/${encodeURIComponent(execId)}/start`, {
          Detach: true,
          Tty: true,
        }),
        [200],
        "exec start",
      );
    },
  };
}
