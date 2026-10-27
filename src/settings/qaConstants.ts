export const QA_CONFIG_PATH = ".pr-agent/qa.md";
export const QA_CONFIG_MAX_BYTES = 32 * 1024;
export const QA_REPORT_HEADER = "## PR Agent QA";
export const QA_FAILURE_MESSAGE =
  "PR Agent could not finish the QA run for this pull request after retries. Try `/qa` again later.";
export const QA_ALREADY_IN_PROGRESS =
  "A `/qa` run is already queued or in progress for this pull request.";

export const QA_MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
export const QA_ARCHIVE_TIMEOUT_MS = 120_000;
export const QA_IMAGE_PULL_TIMEOUT_MS = 600_000;
export const QA_ARCHIVE_UPLOAD_TIMEOUT_MS = 300_000;
export const QA_SETUP_STEP_TIMEOUT_MS = 900_000;
export const QA_SETUP_OUTPUT_TAIL_CHARS = 4_000;
export const QA_EXEC_MAX_OUTPUT_BYTES = 1024 * 1024;
export const QA_DATABASE_READY_TIMEOUT_MS = 120_000;
export const QA_APP_READY_TIMEOUT_MS = 180_000;
export const QA_READY_POLL_MS = 2_000;
export const QA_HTTP_TIMEOUT_MS = 30_000;
export const QA_HTTP_MAX_BODY_CHARS = 6_000;
export const QA_HTTP_MAX_REQUEST_BODY_CHARS = 20_000;
export const QA_MAX_HTTP_REQUESTS = 80;
export const QA_APP_MEMORY_BYTES = 4 * 1024 * 1024 * 1024;
export const QA_DATABASE_MEMORY_BYTES = 1024 * 1024 * 1024;
export const QA_APP_NANO_CPUS = 2_000_000_000;
export const QA_DATABASE_NANO_CPUS = 1_000_000_000;
export const QA_PIDS_LIMIT = 1024;
export const QA_WORKSPACE_DIR = "/workspace";

export const MAX_TOOL_ROUNDS_QA = 60;
export const QA_VALIDATION_REPAIR_ROUNDS = 2;
export const QA_PRE_SUBMIT_NUDGE_ROUNDS = 2;
export const QA_MAX_CHECKS = 20;
export const QA_MAX_DIFF_CHARS = 60_000;
export const QA_MAX_DESCRIPTION_CHARS = 8_000;
export const QA_REPORT_MAX_CHARS = 60_000;
