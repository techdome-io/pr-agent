import { parse as parseYaml } from "yaml";
import * as v from "valibot";
import { formatValidationIssues } from "../util/formatValidationIssues.ts";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const IDENTITY_NAME = /^[A-Z][A-Z0-9_]{0,39}$/;
const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

const envName = v.pipe(v.string(), v.regex(ENV_NAME));
const command = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(2000));
const image = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200));
const path = v.pipe(v.string(), v.startsWith("/"), v.maxLength(500));

const frontmatterSchema = v.object({
  app: v.object({
    image,
    port: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(65535)),
    setup: v.optional(v.pipe(v.array(command), v.maxLength(20)), []),
    start: command,
    health: path,
    env: v.optional(v.record(envName, v.string()), {}),
    secrets: v.optional(v.pipe(v.array(envName), v.maxLength(20)), []),
  }),
  database: v.optional(
    v.object({
      image,
      urlEnv: v.optional(envName, "DATABASE_URL"),
    }),
  ),
  identities: v.object({
    signIn: v.object({
      method: v.optional(v.picklist(HTTP_METHODS), "POST"),
      path,
      body: v.optional(v.record(v.string(), v.string()), {}),
      tokenField: v.pipe(v.string(), v.minLength(1), v.maxLength(100)),
    }),
    users: v.pipe(
      v.record(v.pipe(v.string(), v.regex(IDENTITY_NAME)), v.pipe(v.string(), v.minLength(1))),
      v.check((users) => Object.keys(users).length > 0, "at least one identity"),
      v.check((users) => Object.keys(users).length <= 20, "at most 20 identities"),
    ),
  }),
});

export type QaConfig = v.InferOutput<typeof frontmatterSchema> & { readonly playbook: string };

export type QaConfigResult =
  | { readonly kind: "ok"; readonly config: QaConfig }
  | { readonly kind: "invalid"; readonly reason: string };

export function parseQaConfig(raw: string): QaConfigResult {
  const text = raw.replace(/^﻿/, "");
  if (!text.startsWith("---")) return { kind: "invalid", reason: "missing YAML frontmatter" };
  const end = text.indexOf("\n---", 3);
  if (end === -1) return { kind: "invalid", reason: "unclosed YAML frontmatter" };
  let parsed: unknown;
  try {
    parsed = parseYaml(text.slice(3, end));
  } catch {
    return { kind: "invalid", reason: "frontmatter is not valid YAML" };
  }
  const validated = v.safeParse(frontmatterSchema, parsed);
  if (!validated.success) {
    return { kind: "invalid", reason: formatValidationIssues(validated.issues, "QA config") };
  }
  const playbook = text
    .slice(end + 4)
    .replace(/^\r?\n/, "")
    .trim();
  return { kind: "ok", config: { ...validated.output, playbook } };
}

export function signInBody(
  template: Readonly<Record<string, string>>,
  login: string,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(template).map(([key, value]) => [key, value.split("{{login}}").join(login)]),
  );
}
