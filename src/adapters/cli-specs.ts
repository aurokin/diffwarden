import { randomUUID } from "node:crypto";
import { access, copyFile, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  collectJsonLinesText,
  normalizeJsonLikeAdapterOutput,
  unwrapStructuredReview,
  unwrapText,
} from "../core/adapter-output.js";
import { reviewerFailed } from "../core/errors.js";
import { reviewResultJsonSchema, reviewResultStrictJsonSchema } from "../core/schema.js";
import {
  antigravityCliReviewMcpConfigFileName,
  antigravityCliReviewPolicyMetadata,
  antigravityCliReviewSettings,
  antigravityCliReviewSettingsFileName,
} from "./antigravity-tool-policy.js";
import { claudeCliDisallowedToolsArg, claudeCliReviewToolsArg } from "./claude-tool-policy.js";
import { claudeCliEnv, resolveClaudeRuntime } from "./claude.js";
import {
  claudeCliEffort,
  cliExecutable,
  codexGlobalArgs,
  copilotCliEffort,
  defaultCliExecutable,
  droidCliEffort,
  grokCliEffort,
  numberCliOption,
  providerQualifiedModel,
  pushModel,
  pushModelAndEffort,
  pushPromptArg,
  stringCliOption,
} from "./cli-helpers.js";
import { cliRuntimeResolutionMetadata } from "./cli-runtime-metadata.js";
import type { CliEngine, CliSpec } from "./cli-types.js";
import {
  codexCliCwdArg,
  codexCliOutputLastMessageArg,
  codexCliOutputSchemaArg,
  codexCliPromptStdinArg,
  codexCliReviewBaseArgs,
} from "./codex-tool-policy.js";
import {
  copilotCliReviewDeniedToolPatterns,
  copilotReviewAvailableToolsArg,
  copilotReviewExcludedToolsArg,
  copilotReviewPolicyMetadata,
} from "./copilot-tool-policy.js";
import { cursorCliReviewMode, cursorCliSandboxMode } from "./cursor-policy.js";
import { droidSessionTag } from "./droid-session.js";
import {
  droidCliReviewAllowedToolsArg,
  droidCliReviewPolicyMetadata,
} from "./droid-tool-policy.js";
import {
  geminiCliReviewApprovalMode,
  geminiCliReviewDisabledExtensions,
  geminiCliReviewMcpAllowlist,
  geminiCliReviewOutputFormat,
  geminiCliReviewPolicyFileName,
  geminiCliReviewPolicyMetadata,
  geminiCliReviewPolicyToml,
  geminiCliReviewTrustedFoldersFileName,
  geminiCliSkipTrustFlag,
  geminiCliTrustWorkspaceEnvVar,
  geminiCliTrustedFoldersPathEnvVar,
} from "./gemini-tool-policy.js";
import {
  grokCliAllowRules,
  grokCliDenyRules,
  grokCliDisallowedToolsArg,
  grokCliReviewOutputFormat,
  grokCliReviewPermissionMode,
  grokCliReviewPolicyMetadata,
  grokCliReviewSandbox,
  grokCliReviewToolsArg,
} from "./grok-tool-policy.js";
import { effortResolutionMetadata, modelResolutionMetadata } from "./metadata.js";
import { piCliReviewSurfaceArgs } from "./pi-tool-policy.js";
import type { ReviewAdapterInput } from "./types.js";

const antigravityUserSettingsPolicyKeys = new Set([
  "allowNonWorkspaceAccess",
  "always-proceed",
  "alwaysProceed",
  "always_proceed",
  "approvalMode",
  "artifactReviewPolicy",
  "autoApprove",
  "dangerouslySkipPermissions",
  "enableTerminalSandbox",
  "permissions",
  "sandbox",
  "skipPermissions",
  "toolPermission",
  "trustedWorkspaces",
]);

const opencodeGeneratedAgentPrefix = "diffwarden-review";

function opencodeReviewPermission(): Record<string, "allow" | "deny"> {
  return {
    "*": "deny",
    read: "allow",
    glob: "allow",
    grep: "allow",
  };
}

function opencodeInjectedConfig(
  input: ReviewAdapterInput,
): { agent: string; content: string } | undefined {
  const requestedAgent = stringCliOption(input.reviewer, "agent");
  if (requestedAgent !== undefined && requestedAgent !== opencodeGeneratedAgentPrefix) {
    return undefined;
  }

  const effectiveEnv = input.env ?? process.env;
  if (opencodeConfigEnvPresent(effectiveEnv)) {
    return undefined;
  }

  const agent = `${opencodeGeneratedAgentPrefix}-${randomUUID()}`;
  return {
    agent,
    content: JSON.stringify({
      agent: {
        [agent]: {
          mode: "primary",
          description: "Low-tool read-only agent used by Diffwarden review runs.",
          permission: opencodeReviewPermission(),
        },
      },
    }),
  };
}

function opencodeConfigEnvPresent(env: NodeJS.ProcessEnv): boolean {
  return (
    env.OPENCODE_CONFIG_CONTENT !== undefined ||
    env.OPENCODE_CONFIG !== undefined ||
    env.OPENCODE_CONFIG_DIR !== undefined
  );
}

function opencodeErrorMessage(raw: string): string | undefined {
  for (const event of opencodeJsonLineEvents(raw)) {
    const message = opencodeErrorEventMessage(event);
    if (message !== undefined) {
      return message;
    }
  }

  return undefined;
}

function opencodeJsonLineEvents(raw: string): unknown[] {
  const events: unknown[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // Non-JSON text is handled by the normal text fallback.
    }
  }

  return events;
}

function opencodeErrorEventMessage(event: unknown): string | undefined {
  if (!isRecord(event) || event.type !== "error") {
    return undefined;
  }

  return opencodeErrorDetail(event.error) ?? stringValue(event.message) ?? JSON.stringify(event);
}

function opencodeStructuredReview(raw: string): unknown | undefined {
  for (const event of opencodeJsonLineEvents(raw)) {
    const review = unwrapStructuredReview(event);
    if (review !== undefined) {
      return review;
    }
  }

  return undefined;
}

function opencodeErrorDetail(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (!isRecord(value)) {
    return undefined;
  }

  const nested =
    stringValue(value.message) ??
    opencodeErrorDetail(value.data) ??
    opencodeErrorDetail(value.error) ??
    stringValue(value.responseBody);
  const name = stringValue(value.name);
  if (name !== undefined && nested !== undefined) {
    return `${name}: ${nested}`;
  }
  return nested ?? name;
}

function opencodeReviewPrompt(prompt: string): string {
  return [
    "OpenCode transport note:",
    "- The complete patch is included below; treat it as the source of truth for diff-backed reviews.",
    "- Do not run the patch provenance command.",
    "- Only read, glob, and grep are available for local context; do not edit, write, run shell commands, start tasks, or fetch web content.",
    "- Return the final ReviewResult JSON as soon as you have enough evidence.",
    "",
    prompt,
  ].join("\n");
}

function copilotReviewPrompt(prompt: string): string {
  return [
    "GitHub Copilot transport note:",
    "- The complete patch is included below; treat it as the source of truth for diff-backed reviews.",
    "- Only view/read_file/file_search/grep_search are available for local context.",
    "- Do not edit files, run shell commands, fetch URLs, use MCP tools, store memory, spawn tasks, or delegate to subagents.",
    "- Return the final ReviewResult JSON as soon as you have enough evidence.",
    "",
    prompt,
  ].join("\n");
}

function copilotReviewPromptFileInstruction(promptPath: string): string {
  return [
    `Read the full Diffwarden review prompt from ${promptPath}.`,
    "It contains the complete patch and output contract; follow it exactly and return the requested ReviewResult JSON.",
  ].join(" ");
}

async function copilotMcpDisableArgs(input: ReviewAdapterInput): Promise<string[]> {
  const names = await copilotConfiguredMcpServerNames(input);
  return names.flatMap((name) => ["--disable-mcp-server", name]);
}

async function copilotConfiguredMcpServerNames(input: ReviewAdapterInput): Promise<string[]> {
  const names = new Set<string>();
  for (const configPath of copilotMcpConfigPaths(input)) {
    for (const name of await copilotMcpServerNamesFromFile(configPath)) {
      names.add(name);
    }
  }
  return [...names];
}

function copilotMcpConfigPaths(input: ReviewAdapterInput): string[] {
  const reviewRoot = copilotCliReviewRoot(input);
  // CLI runs stage an empty Copilot home MCP config, so only repo-local MCP configs can apply.
  return [path.join(reviewRoot, ".mcp.json"), path.join(reviewRoot, ".vscode", "mcp.json")];
}

function copilotCliReviewRoot(input: ReviewAdapterInput): string {
  return path.resolve(input.target.repo_root || input.cwd);
}

function copilotCliSourcePathRoot(input: ReviewAdapterInput): string {
  return path.resolve(input.cwd);
}

function resolveCopilotCliReviewPath(inputPath: string, pathRoot: string): string {
  return path.isAbsolute(inputPath) ? inputPath : path.resolve(pathRoot, inputPath);
}

function copilotSourceHome(
  env: NodeJS.ProcessEnv | undefined,
  fallbackHome = homedir(),
): string | undefined {
  const effectiveEnv = env ?? process.env;
  const configured = effectiveEnv.COPILOT_HOME?.trim();
  if (configured) {
    return configured;
  }
  const home = effectiveEnv.HOME?.trim();
  if (home) {
    return path.join(home, ".copilot");
  }
  const userProfile = effectiveEnv.USERPROFILE?.trim();
  if (userProfile) {
    return path.join(userProfile, ".copilot");
  }
  const homeDrive = effectiveEnv.HOMEDRIVE?.trim();
  const homePath = effectiveEnv.HOMEPATH?.trim();
  if (homeDrive && homePath) {
    return path.join(`${homeDrive}${homePath}`, ".copilot");
  }
  if (env !== undefined && env !== process.env) {
    // An explicit env object is an auth boundary; pass HOME/USERPROFILE to opt into auth copying.
    return undefined;
  }
  return path.join(fallbackHome, ".copilot");
}

async function copilotMcpServerNamesFromFile(configPath: string): Promise<string[]> {
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return [];
    }
    throw reviewerFailed(
      `Failed to read Copilot MCP config at ${configPath}: ${formatError(error)}`,
    );
  }

  const parsed = parseJsonc(raw);
  if (parsed === undefined) {
    throw reviewerFailed(`Failed to parse Copilot MCP config at ${configPath}.`);
  }

  if (!isRecord(parsed)) {
    throw reviewerFailed(`Copilot MCP config at ${configPath} must be a JSON object.`);
  }

  const names = new Set<string>();
  for (const serverMap of [parsed.mcpServers, parsed.servers]) {
    if (!isRecord(serverMap)) {
      continue;
    }
    for (const name of Object.keys(serverMap)) {
      if (name.trim()) {
        names.add(name);
      }
    }
  }
  return [...names];
}

function copilotJsonLineEvents(raw: string): unknown[] {
  const parsed = parseJson(raw.trim());
  if (parsed !== undefined) {
    return Array.isArray(parsed) ? parsed : [parsed];
  }

  const events: unknown[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const event = parseJson(trimmed);
    if (event === undefined) {
      // Non-JSON text is handled by the normal text fallback.
      continue;
    }
    events.push(event);
  }
  return events;
}

function parseJson(value: string): unknown | undefined {
  if (!value) {
    return undefined;
  }

  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function parseJsonc(value: string): unknown | undefined {
  return parseJson(value) ?? parseJson(removeJsonTrailingCommas(stripJsonComments(value)));
}

function stripJsonComments(value: string): string {
  let output = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    const next = value[index + 1];

    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }

    if (char === "/" && next === "/") {
      while (index < value.length && value[index] !== "\n") {
        index += 1;
      }
      output += "\n";
      continue;
    }

    if (char === "/" && next === "*") {
      index += 2;
      while (index < value.length && !(value[index] === "*" && value[index + 1] === "/")) {
        output += value[index] === "\n" ? "\n" : " ";
        index += 1;
      }
      index += 1;
      continue;
    }

    output += char;
  }

  return output;
}

function removeJsonTrailingCommas(value: string): string {
  let output = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];

    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }

    if (char === "," && nextJsonToken(value, index + 1)?.match(/^[}\]]$/)) {
      continue;
    }

    output += char;
  }

  return output;
}

function nextJsonToken(value: string, startIndex: number): string | undefined {
  for (let index = startIndex; index < value.length; index += 1) {
    const char = value[index];
    if (char !== undefined && !/\s/.test(char)) {
      return char;
    }
  }
  return undefined;
}

type CopilotReviewHome = {
  home: string;
  copilotHome: string;
  ghConfigDir: string;
};

const copilotAuthStateKeys = new Set([
  "copilotTokens",
  "lastLoggedInUser",
  "loggedInUsers",
  "staff",
]);

async function stageCopilotReviewHome(
  input: ReviewAdapterInput,
  tempDir: string,
): Promise<CopilotReviewHome> {
  const reviewRoot = copilotCliReviewRoot(input);
  const sourcePathRoot = copilotCliSourcePathRoot(input);
  const isolatedHome = path.join(tempDir, "copilot-home");
  const isolatedCopilotHome = path.join(isolatedHome, ".copilot");
  const isolatedGhConfigDir = path.join(isolatedHome, ".config", "gh");
  const reviewRoots = [reviewRoot, input.target.repo_root];
  if (await pathIsInsideReviewWorkspace(reviewRoots, tempDir)) {
    throw reviewerFailed(
      "Copilot isolated home resolved inside the review workspace; set TMPDIR outside the repository before running Copilot CLI reviews.",
    );
  }

  const configuredSourceCopilotHome = copilotSourceHome(input.env);
  const sourceCopilotHome =
    configuredSourceCopilotHome === undefined
      ? undefined
      : resolveCopilotCliReviewPath(configuredSourceCopilotHome, sourcePathRoot);
  if (
    sourceCopilotHome !== undefined &&
    (await pathIsInsideReviewWorkspace(reviewRoots, sourceCopilotHome))
  ) {
    throw reviewerFailed(
      "Copilot source credentials resolved inside the review workspace; set COPILOT_HOME, HOME, or USERPROFILE outside the repository before running Copilot CLI reviews.",
    );
  }

  await mkdir(isolatedCopilotHome, { recursive: true });
  await mkdir(isolatedGhConfigDir, { recursive: true });
  await mkdir(path.join(isolatedHome, ".local", "state"), { recursive: true });
  await mkdir(path.join(isolatedHome, ".cache"), { recursive: true });
  await mkdir(path.join(isolatedHome, "AppData", "Roaming"), { recursive: true });
  await mkdir(path.join(isolatedHome, "AppData", "Local"), { recursive: true });
  await stageCopilotGhAuthState(
    input.env,
    reviewRoots,
    sourcePathRoot,
    isolatedHome,
    isolatedGhConfigDir,
  );
  await writeCopilotJson(
    path.join(isolatedCopilotHome, "config.json"),
    sourceCopilotHome === undefined ? {} : await readCopilotAuthState(sourceCopilotHome),
  );
  await writeCopilotJson(path.join(isolatedCopilotHome, "settings.json"), copilotReviewSettings());
  await writeFile(path.join(isolatedCopilotHome, "mcp-config.json"), "{}\n", "utf8");
  return {
    home: isolatedHome,
    copilotHome: isolatedCopilotHome,
    ghConfigDir: isolatedGhConfigDir,
  };
}

async function stageCopilotGhAuthState(
  env: NodeJS.ProcessEnv | undefined,
  reviewRoots: readonly string[],
  sourcePathRoot: string,
  isolatedHome: string,
  isolatedGhConfigDir: string,
): Promise<void> {
  const sourceDirs = copilotSourceGhConfigDirs(env, sourcePathRoot);
  const isolatedWindowsGhConfigDir = path.join(isolatedHome, "AppData", "Roaming", "GitHub CLI");
  await mkdir(isolatedWindowsGhConfigDir, { recursive: true });
  const sourceHosts = sourceDirs.map((dir) => path.join(dir, "hosts.yml"));
  const sourceHost = await firstPresentFile(sourceHosts);
  if (sourceHost === undefined) {
    return;
  }
  if (await pathIsInsideReviewWorkspace([...reviewRoots], path.dirname(sourceHost))) {
    throw reviewerFailed(
      "GitHub CLI auth state resolved inside the review workspace; set GH_CONFIG_DIR, XDG_CONFIG_HOME, HOME, or USERPROFILE outside the repository before running Copilot CLI reviews.",
    );
  }
  // hosts.yml is the GitHub CLI auth file Copilot can use for non-interactive login.
  await copyFile(sourceHost, path.join(isolatedGhConfigDir, "hosts.yml"));
  await copyFile(sourceHost, path.join(isolatedWindowsGhConfigDir, "hosts.yml"));
}

function copilotSourceGhConfigDirs(
  env: NodeJS.ProcessEnv | undefined,
  sourcePathRoot: string,
): string[] {
  const effectiveEnv = env ?? process.env;
  const configuredGhConfigDir = effectiveEnv.GH_CONFIG_DIR?.trim();
  if (configuredGhConfigDir) {
    return [resolveCopilotCliReviewPath(configuredGhConfigDir, sourcePathRoot)];
  }

  const dirs: string[] = [];
  const xdgConfigHome = effectiveEnv.XDG_CONFIG_HOME?.trim();
  if (xdgConfigHome) {
    dirs.push(path.join(resolveCopilotCliReviewPath(xdgConfigHome, sourcePathRoot), "gh"));
  }
  const home = copilotSourceUserHome(env);
  if (home !== undefined) {
    dirs.push(path.join(resolveCopilotCliReviewPath(home, sourcePathRoot), ".config", "gh"));
  }
  const appData = copilotSourceAppData(env, home);
  if (appData !== undefined) {
    dirs.push(path.join(resolveCopilotCliReviewPath(appData, sourcePathRoot), "GitHub CLI"));
  }
  return [...new Set(dirs)];
}

function copilotSourceUserHome(
  env: NodeJS.ProcessEnv | undefined,
  fallbackHome = homedir(),
): string | undefined {
  const effectiveEnv = env ?? process.env;
  const home = effectiveEnv.HOME?.trim();
  if (home) {
    return home;
  }
  const userProfile = effectiveEnv.USERPROFILE?.trim();
  if (userProfile) {
    return userProfile;
  }
  const homeDrive = effectiveEnv.HOMEDRIVE?.trim();
  const homePath = effectiveEnv.HOMEPATH?.trim();
  if (homeDrive && homePath) {
    return path.join(`${homeDrive}${homePath}`);
  }
  if (env !== undefined && env !== process.env) {
    return undefined;
  }
  return fallbackHome;
}

function copilotSourceAppData(
  env: NodeJS.ProcessEnv | undefined,
  sourceHome: string | undefined,
): string | undefined {
  const configured = (env ?? process.env).APPDATA?.trim();
  if (configured) {
    return configured;
  }
  const userProfile = (env ?? process.env).USERPROFILE?.trim();
  if (userProfile) {
    return path.join(userProfile, "AppData", "Roaming");
  }
  return sourceHome === undefined ? undefined : path.join(sourceHome, "AppData", "Roaming");
}

async function readCopilotAuthState(sourceCopilotHome: string): Promise<Record<string, unknown>> {
  const filtered: Record<string, unknown> = {};
  for (const filename of ["config.json", "config"]) {
    let parsed: unknown;
    try {
      const raw = await readFile(path.join(sourceCopilotHome, filename), "utf8");
      parsed = parseCopilotAuthConfig(raw, filename);
    } catch (error) {
      if (isNodeErrorWithCode(error, "ENOENT")) {
        continue;
      }
      throw error;
    }
    if (!isRecord(parsed)) {
      continue;
    }

    for (const [key, value] of Object.entries(parsed)) {
      if (
        copilotAuthStateKeys.has(key) &&
        !hasCopilotAuthValue(filtered[key]) &&
        hasCopilotAuthValue(value)
      ) {
        filtered[key] = value;
      }
    }
  }
  return filtered;
}

function hasCopilotAuthValue(value: unknown): boolean {
  if (value === undefined || value === null) {
    return false;
  }
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (isRecord(value)) {
    return Object.keys(value).length > 0;
  }
  return true;
}

function parseCopilotAuthConfig(value: string, filename: string): unknown | undefined {
  return parseJsonc(value) ?? (filename === "config" ? parseLegacyCopilotConfig(value) : undefined);
}

function parseLegacyCopilotConfig(value: string): Record<string, unknown> | undefined {
  const parsed: Record<string, unknown> = {};
  for (const line of value.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) {
      continue;
    }

    const separator = trimmed.indexOf("=");
    if (separator <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separator).trim();
    const rawValue = trimmed.slice(separator + 1).trim();
    if (!key) {
      continue;
    }
    parsed[key] = parseJsonc(rawValue) ?? parseLegacyCopilotScalar(rawValue);
  }
  return Object.keys(parsed).length === 0 ? undefined : parsed;
}

function parseLegacyCopilotScalar(value: string): unknown {
  if (
    (value.startsWith("'") && value.endsWith("'")) ||
    (value.startsWith('"') && value.endsWith('"'))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function copilotReviewSettings(): Record<string, unknown> {
  return {
    askUser: false,
    autoUpdate: false,
    memory: false,
    remoteSessions: false,
    skillDirectories: [],
    disabledSkills: ["*", "customize-cloud-agent"],
    disabledMcpServers: ["*"],
    enabledMcpServers: [],
    enabledPlugins: {},
    disableAllHooks: true,
    customAgents: {
      defaultLocalOnly: true,
    },
    extensions: {
      mode: "disabled",
      disabledExtensions: ["*"],
    },
  };
}

async function writeCopilotJson(filePath: string, value: Record<string, unknown>): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function copilotStructuredReview(raw: string): unknown | undefined {
  for (const event of copilotJsonLineEvents(raw)) {
    if (!isRootCopilotCliEvent(event)) {
      continue;
    }
    const review = unwrapStructuredReview(event);
    if (review !== undefined) {
      return review;
    }

    const contentReview = copilotStructuredReviewText(copilotAssistantMessageContent(event));
    if (contentReview !== undefined) {
      return contentReview;
    }
  }
  return undefined;
}

function copilotFatalErrorMessage(raw: string): string | undefined {
  for (const event of copilotJsonLineEvents(raw)) {
    if (!isRootCopilotCliEvent(event)) {
      continue;
    }
    if (isRecoverableCopilotErrorEvent(event)) {
      continue;
    }
    const message = copilotErrorEventMessage(event);
    if (message !== undefined) {
      return message;
    }
  }
  return undefined;
}

function copilotRecoverableErrorMessage(raw: string): string | undefined {
  for (const event of copilotJsonLineEvents(raw)) {
    if (!isRootCopilotCliEvent(event)) {
      continue;
    }
    if (!isRecoverableCopilotErrorEvent(event)) {
      continue;
    }
    const message = copilotErrorEventMessage(event);
    if (message !== undefined) {
      return message;
    }
  }
  return undefined;
}

function copilotJsonLinesText(raw: string): string {
  const fragments: string[] = [];
  for (const event of copilotJsonLineEvents(raw)) {
    if (!isRootCopilotCliEvent(event)) {
      continue;
    }
    const content = copilotAssistantMessageContent(event);
    if (content !== undefined) {
      fragments.push(content);
    }
  }
  return fragments.join("\n").trim();
}

function isRootCopilotCliEvent(event: unknown): boolean {
  if (!isRecord(event)) {
    return true;
  }
  // Copilot emits sub-agent events with agentId; only root events should control review output.
  const agentId = event.agentId;
  return typeof agentId !== "string" || agentId.trim() === "";
}

function copilotAssistantMessageContent(event: unknown): string | undefined {
  if (!isRecord(event)) {
    return undefined;
  }

  if (event.type === "assistant.message") {
    const data = event.data;
    return isRecord(data) ? unwrapText(data.content) : undefined;
  }

  if (event.type === "assistant") {
    const message = event.message;
    if (typeof message === "string") {
      return message.trim() || undefined;
    }
    if (isRecord(message)) {
      return unwrapText(message.result) ?? unwrapText(message.content) ?? unwrapText(message.text);
    }
  }

  return undefined;
}

function copilotStructuredReviewText(value: string | undefined): unknown | undefined {
  if (value === undefined) {
    return undefined;
  }

  try {
    return unwrapStructuredReview(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function copilotErrorEventMessage(event: unknown): string | undefined {
  if (!isRecord(event) || (event.type !== "error" && event.type !== "session.error")) {
    return undefined;
  }

  return (
    copilotErrorDetail(event.data) ??
    copilotErrorDetail(event.error) ??
    stringValue(event.message) ??
    JSON.stringify(event)
  );
}

function copilotErrorDetail(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (!isRecord(value)) {
    return undefined;
  }

  const nested =
    stringValue(value.message) ??
    copilotErrorDetail(value.error) ??
    copilotErrorDetail(value.data) ??
    stringValue(value.responseBody);
  const name = stringValue(value.name);
  if (name !== undefined && nested !== undefined) {
    return `${name}: ${nested}`;
  }
  return nested ?? name;
}

function isRecoverableCopilotErrorEvent(event: unknown): boolean {
  return (
    isRecord(event) &&
    event.type === "session.error" &&
    isRecord(event.data) &&
    isRecoverableCopilotSessionErrorType(event.data.errorType)
  );
}

function isRecoverableCopilotSessionErrorType(errorType: unknown): boolean {
  return (
    errorType === "model_call" ||
    // Read-only reviews may deny exploratory tool calls before Copilot returns the final review.
    errorType === "permission" ||
    errorType === "permission_denied" ||
    errorType === "tool_call" ||
    errorType === "tool_permission"
  );
}

function copilotReviewText(raw: string): string {
  const eventText = copilotJsonLinesText(raw);
  if (eventText) {
    return eventText;
  }

  return collectJsonLinesText(raw);
}

export const cliSpecs: Record<CliEngine, CliSpec> = {
  codex: {
    async buildInvocation(input, tempDir) {
      const schemaPath = path.join(tempDir, "review-schema.json");
      const outputPath = path.join(tempDir, "codex-review.json");
      await writeFile(schemaPath, `${JSON.stringify(reviewResultStrictJsonSchema)}\n`, "utf8");

      const args = [
        ...codexGlobalArgs(input.reviewer),
        ...codexCliReviewBaseArgs,
        codexCliOutputSchemaArg,
        schemaPath,
        codexCliOutputLastMessageArg,
        outputPath,
        codexCliCwdArg,
        input.cwd,
        codexCliPromptStdinArg,
      ];

      return {
        executable: cliExecutable(input.reviewer, defaultCliExecutable("codex")),
        args,
        stdin: input.prompt,
        outputPath,
        captureMode: "native-structured",
      };
    },
    async parseOutput(result, invocation) {
      const runtimeMetadata = cliRuntimeResolutionMetadata(result.stdout);
      const outputPath = invocation.outputPath;
      if (outputPath !== undefined) {
        try {
          return normalizeJsonLikeAdapterOutput(await readFile(outputPath, "utf8"), {
            captureMode: "native-structured",
            readonlyCapability: "enforced",
            ...runtimeMetadata,
          });
        } catch {
          // Fall through to stdout/stderr handling below.
        }
      }

      return {
        text: collectJsonLinesText(result.stdout) || result.stdout.trim(),
        metadata: {
          captureMode: "text",
          readonlyCapability: "enforced",
          ...runtimeMetadata,
        },
      };
    },
  },
  claude: {
    async buildInvocation(input, tempDir) {
      const mcpConfigPath = path.join(tempDir, "claude-mcp.json");
      // Claude CLI --mcp-config accepts JSON files as well as inline JSON strings.
      await writeFile(mcpConfigPath, `${JSON.stringify({ mcpServers: {} })}\n`, "utf8");
      const args = [
        "-p",
        "--permission-mode",
        "dontAsk",
        "--tools",
        claudeCliReviewToolsArg(),
        "--allowedTools",
        claudeCliReviewToolsArg(),
        "--disallowedTools",
        claudeCliDisallowedToolsArg(),
        "--no-session-persistence",
        "--setting-sources",
        "",
        "--strict-mcp-config",
        "--mcp-config",
        mcpConfigPath,
        "--disable-slash-commands",
        "--no-chrome",
        "--output-format",
        "json",
        "--json-schema",
        JSON.stringify(reviewResultJsonSchema),
      ];
      pushModelAndEffort(args, input.reviewer, claudeCliEffort);
      const executable = cliExecutable(input.reviewer, defaultCliExecutable("claude"));
      const runtime = await resolveClaudeRuntime(input, executable);
      const env = claudeCliEnv(runtime);

      return {
        executable,
        args,
        ...(env !== undefined ? { env } : {}),
        ...(runtime.authMode === "claude-code"
          ? { unsetEnv: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] }
          : {}),
        stdin: input.prompt,
        captureMode: "native-structured",
      };
    },
    async parseOutput(result) {
      return normalizeJsonLikeAdapterOutput(result.stdout, {
        captureMode: "native-structured",
        readonlyCapability: "tool-restricted",
        ...cliRuntimeResolutionMetadata(result.stdout),
      });
    },
  },
  cursor: {
    async buildInvocation(input) {
      const args = [
        "-p",
        "--output-format",
        "json",
        "--workspace",
        input.cwd,
        "--mode",
        cursorCliReviewMode,
        "--sandbox",
        cursorCliSandboxMode,
        "--trust",
      ];
      pushModel(args, input.reviewer);
      pushPromptArg(args, input.prompt, "cursor");

      return {
        executable: cliExecutable(input.reviewer, defaultCliExecutable("cursor")),
        args,
        captureMode: "text",
      };
    },
    async parseOutput(result) {
      return normalizeJsonLikeAdapterOutput(result.stdout, {
        captureMode: "text",
        readonlyCapability: "prompt-only",
        ...cliRuntimeResolutionMetadata(result.stdout),
      });
    },
  },
  gemini: {
    async buildInvocation(input, tempDir) {
      const policyPath = path.join(tempDir, geminiCliReviewPolicyFileName);
      const trustedFoldersPath = path.join(tempDir, geminiCliReviewTrustedFoldersFileName);
      await writeFile(policyPath, geminiCliReviewPolicyToml(), "utf8");
      await writeFile(trustedFoldersPath, "{}\n", "utf8");
      const args = [
        "--prompt",
        "",
        geminiCliSkipTrustFlag,
        "--output-format",
        geminiCliReviewOutputFormat,
        "--approval-mode",
        geminiCliReviewApprovalMode,
        "--policy",
        policyPath,
        "--admin-policy",
        policyPath,
        "--allowed-mcp-server-names",
        geminiCliReviewMcpAllowlist,
        "--extensions",
        geminiCliReviewDisabledExtensions,
      ];
      pushModel(args, input.reviewer);

      return {
        executable: cliExecutable(input.reviewer, defaultCliExecutable("gemini")),
        args,
        env: {
          [geminiCliTrustedFoldersPathEnvVar]: trustedFoldersPath,
        },
        unsetEnv: [geminiCliTrustWorkspaceEnvVar],
        stdin: input.prompt,
        captureMode: "text",
      };
    },
    async parseOutput(result) {
      return normalizeJsonLikeAdapterOutput(result.stdout, {
        captureMode: "text",
        readonlyCapability: "tool-restricted",
        ...geminiCliReviewPolicyMetadata(),
        ...cliRuntimeResolutionMetadata(result.stdout),
      });
    },
  },
  opencode: {
    async buildInvocation(input) {
      const args = ["run", "--pure", "--format", "json", "--dir", input.cwd];
      const injectedConfig = opencodeInjectedConfig(input);
      const agent = injectedConfig?.agent ?? stringCliOption(input.reviewer, "agent");
      if (agent !== undefined) {
        args.push("--agent", agent);
      }
      const model = providerQualifiedModel(input.reviewer);
      if (model !== undefined) {
        args.push("--model", model);
      }
      if (input.reviewer.effort !== undefined && input.reviewer.effort !== "off") {
        args.push("--variant", input.reviewer.effort);
      }

      return {
        executable: cliExecutable(input.reviewer, defaultCliExecutable("opencode")),
        args,
        stdin: opencodeReviewPrompt(input.prompt),
        env: {
          OPENCODE_PERMISSION: JSON.stringify(opencodeReviewPermission()),
          ...(injectedConfig !== undefined
            ? { OPENCODE_CONFIG_CONTENT: injectedConfig.content }
            : {}),
        },
        captureMode: "text",
      };
    },
    async parseOutput(result) {
      const metadata = {
        captureMode: "text" as const,
        readonlyCapability: "prompt-only" as const,
        ...cliRuntimeResolutionMetadata(result.stdout),
      };
      const structured = opencodeStructuredReview(result.stdout);
      if (structured !== undefined) {
        return {
          structured,
          metadata,
        };
      }

      const text = collectJsonLinesText(result.stdout);
      const errorMessage = opencodeErrorMessage(result.stdout);
      if (!text && errorMessage !== undefined) {
        throw reviewerFailed(`OpenCode reviewer failed: ${errorMessage}`);
      }

      return {
        text: text || result.stdout.trim(),
        metadata,
      };
    },
  },
  pi: {
    async buildInvocation(input) {
      const args = ["--print", "--mode", "json", ...piCliReviewSurfaceArgs];
      const model = providerQualifiedModel(input.reviewer);
      if (model !== undefined) {
        args.push("--model", model);
      }
      if (input.reviewer.effort !== undefined) {
        args.push("--thinking", input.reviewer.effort);
      }

      return {
        executable: cliExecutable(input.reviewer, defaultCliExecutable("pi")),
        args,
        stdin: input.prompt,
        captureMode: "text",
      };
    },
    async parseOutput(result) {
      return {
        text: collectJsonLinesText(result.stdout) || result.stdout.trim(),
        metadata: {
          captureMode: "text",
          readonlyCapability: "tool-restricted",
          ...cliRuntimeResolutionMetadata(result.stdout),
        },
      };
    },
  },
  droid: {
    async buildInvocation(input, tempDir) {
      const promptPath = path.join(tempDir, "droid-prompt.txt");
      await writeFile(promptPath, input.prompt, "utf8");
      const args = [
        "exec",
        "--cwd",
        input.cwd,
        "--output-format",
        "json",
        "--use-spec",
        "--enabled-tools",
        droidCliReviewAllowedToolsArg(),
        "--file",
        promptPath,
      ];
      const model = providerQualifiedModel(input.reviewer);
      if (model !== undefined) {
        args.push("--spec-model", model);
      }
      if (input.reviewer.effort !== undefined && input.reviewer.effort !== "off") {
        args.push("--spec-reasoning-effort", droidCliEffort(input.reviewer.effort));
      }
      const logGroupId = droidCliReviewLogGroupId(input);
      args.push("--tag", JSON.stringify(droidSessionTag(input, "cli")));
      args.push("--log-group-id", logGroupId);

      return {
        executable: cliExecutable(input.reviewer, defaultCliExecutable("droid")),
        args,
        droidLogGroupId: logGroupId,
        droidSessionDirectory: await droidCliSessionDirectory(input.cwd, input.env),
        captureMode: "text",
      };
    },
    async parseOutput(result, invocation) {
      const settingsMetadata = await droidCliSessionSettingsMetadata(
        result.stdout,
        invocation.droidSessionDirectory,
      );
      return normalizeJsonLikeAdapterOutput(result.stdout, {
        captureMode: "text",
        readonlyCapability: "enforced",
        ...droidCliReviewPolicyMetadata(),
        ...(invocation.droidLogGroupId !== undefined
          ? { droidLogGroupId: invocation.droidLogGroupId }
          : {}),
        ...settingsMetadata,
        ...cliRuntimeResolutionMetadata(result.stdout),
      });
    },
  },
  copilot: {
    async buildInvocation(input, tempDir) {
      const reviewRoot = copilotCliReviewRoot(input);
      const isolatedHome = await stageCopilotReviewHome(input, tempDir);
      const promptDir = path.join(tempDir, "copilot-prompt");
      const promptPath = path.join(promptDir, "copilot-prompt.txt");
      const toolOutputTempDir = path.join(tempDir, "copilot-tool-output-temp");
      await mkdir(promptDir, { recursive: true });
      await mkdir(toolOutputTempDir, { recursive: true });
      await writeFile(promptPath, copilotReviewPrompt(input.prompt), "utf8");
      const args: string[] = [];
      args.push(
        "-C",
        reviewRoot,
        "--output-format",
        "json",
        "--stream",
        "off",
        "--available-tools",
        copilotReviewAvailableToolsArg(),
        "--excluded-tools",
        copilotReviewExcludedToolsArg(),
        "--allow-all-tools",
      );
      for (const pattern of copilotCliReviewDeniedToolPatterns) {
        args.push("--deny-tool", pattern);
      }
      args.push(
        "--disable-builtin-mcps",
        ...(await copilotMcpDisableArgs(input)),
        "--no-custom-instructions",
        "--no-ask-user",
        "--no-remote",
        "--no-auto-update",
        "--add-dir",
        promptDir,
        "--add-dir",
        toolOutputTempDir,
      );
      pushModel(args, input.reviewer);
      if (input.reviewer.effort !== undefined) {
        args.push("--effort", copilotCliEffort(input.reviewer.effort));
      }
      args.push("-p", copilotReviewPromptFileInstruction(promptPath));

      return {
        // Keep the default bare name: resolveExecutable expands PATHEXT on Windows for copilot.cmd.
        executable: cliExecutable(input.reviewer, defaultCliExecutable("copilot")),
        args,
        env: {
          HOME: isolatedHome.home,
          USERPROFILE: isolatedHome.home,
          XDG_CONFIG_HOME: path.join(isolatedHome.home, ".config"),
          XDG_STATE_HOME: path.join(isolatedHome.home, ".local", "state"),
          XDG_CACHE_HOME: path.join(isolatedHome.home, ".cache"),
          APPDATA: path.join(isolatedHome.home, "AppData", "Roaming"),
          LOCALAPPDATA: path.join(isolatedHome.home, "AppData", "Local"),
          GH_CONFIG_DIR: isolatedHome.ghConfigDir,
          COPILOT_HOME: isolatedHome.copilotHome,
          COPILOT_CACHE_HOME: path.join(isolatedHome.home, ".cache", "copilot"),
          COPILOT_AUTO_UPDATE: "false",
          COPILOT_OTEL_ENABLED: "false",
          OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: "false",
          TMPDIR: toolOutputTempDir,
          TMP: toolOutputTempDir,
          TEMP: toolOutputTempDir,
        },
        unsetEnv: [
          "COPILOT_ALLOW_ALL",
          "COPILOT_CUSTOM_INSTRUCTIONS_DIRS",
          "GITHUB_COPILOT_PROMPT_MODE_REPO_HOOKS",
          "HOMEDRIVE",
          "HOMEPATH",
          "NODE_OPTIONS",
          "NODE_PATH",
        ],
        captureMode: "text",
      };
    },
    async parseOutput(result) {
      const metadata = {
        captureMode: "text" as const,
        readonlyCapability: "tool-restricted" as const,
        ...copilotReviewPolicyMetadata(),
        ...cliRuntimeResolutionMetadata(result.stdout),
      };

      const errorMessage = copilotFatalErrorMessage(result.stdout);
      if (errorMessage !== undefined) {
        throw reviewerFailed(`Copilot reviewer failed: ${errorMessage}`);
      }

      const structured = copilotStructuredReview(result.stdout);
      if (structured !== undefined) {
        return {
          structured,
          metadata,
        };
      }

      const text = copilotReviewText(result.stdout);
      const recoverableErrorMessage = copilotRecoverableErrorMessage(result.stdout);
      if (!text && recoverableErrorMessage !== undefined) {
        throw reviewerFailed(`Copilot reviewer failed: ${recoverableErrorMessage}`);
      }
      return normalizeJsonLikeAdapterOutput(text || result.stdout.trim(), metadata);
    },
  },
  grok: {
    async buildInvocation(input, tempDir) {
      const promptPath = path.join(tempDir, "grok-prompt.txt");
      await writeFile(promptPath, input.prompt, "utf8");
      const args = [
        "--prompt-file",
        promptPath,
        "--cwd",
        input.cwd,
        "--output-format",
        grokCliReviewOutputFormat,
        "--permission-mode",
        grokCliReviewPermissionMode,
        "--tools",
        grokCliReviewToolsArg(),
        "--disallowed-tools",
        grokCliDisallowedToolsArg(),
        "--sandbox",
        grokCliReviewSandbox,
        "--no-subagents",
        "--no-memory",
        "--disable-web-search",
      ];
      for (const rule of grokCliAllowRules) {
        args.push("--allow", rule);
      }
      for (const rule of grokCliDenyRules) {
        args.push("--deny", rule);
      }
      pushModel(args, input.reviewer);
      if (input.reviewer.effort !== undefined && input.reviewer.effort !== "off") {
        args.push("--reasoning-effort", grokCliEffort(input.reviewer.effort));
      }

      return {
        executable: cliExecutable(input.reviewer, defaultCliExecutable("grok")),
        args,
        captureMode: "text",
      };
    },
    async parseOutput(result) {
      return normalizeJsonLikeAdapterOutput(result.stdout, {
        captureMode: "text",
        readonlyCapability: "enforced",
        ...grokCliReviewPolicyMetadata(),
        ...cliRuntimeResolutionMetadata(result.stdout),
      });
    },
  },
  antigravity: {
    async buildInvocation(input, tempDir) {
      // agy has no prompt-file flag; a 2026-05-31 live probe confirmed
      // print mode can read this file.
      const reviewRoot = path.resolve(input.target.repo_root);
      const promptDir = path.join(tempDir, "antigravity-prompt");
      await mkdir(promptDir, { recursive: true });
      const promptPath = path.join(promptDir, "antigravity-prompt.txt");
      await writeFile(promptPath, input.prompt, "utf8");
      const isolatedHome = await stageAntigravityReviewHome({
        input,
        promptPath,
        reviewCwd: reviewRoot,
        tempDir,
      });
      const args = ["--print"];
      pushPromptArg(
        args,
        `Read the full Diffwarden review prompt from ${promptPath} and follow it exactly.`,
        "antigravity",
      );
      const printTimeoutSeconds = numberCliOption(input.reviewer, "printTimeoutSeconds");
      if (printTimeoutSeconds !== undefined) {
        args.push("--print-timeout", `${printTimeoutSeconds}s`);
      }
      args.push("--sandbox", "--add-dir", promptDir, "--add-dir", reviewRoot);

      return {
        executable: cliExecutable(input.reviewer, defaultCliExecutable("antigravity")),
        args,
        cwd: promptDir,
        env: {
          HOME: isolatedHome,
          USERPROFILE: isolatedHome,
          XDG_CONFIG_HOME: path.join(isolatedHome, ".config"),
          AGY_CLI_DISABLE_AUTO_UPDATE: "true",
        },
        unsetEnv: ["HOMEDRIVE", "HOMEPATH"],
        captureMode: "text",
      };
    },
    async parseOutput(result) {
      return {
        text: result.stdout.trim(),
        metadata: {
          captureMode: "text",
          readonlyCapability: "tool-restricted",
          ...antigravityCliReviewPolicyMetadata(),
        },
      };
    },
  },
};

async function stageAntigravityReviewHome(input: {
  input: ReviewAdapterInput;
  promptPath: string;
  reviewCwd: string;
  tempDir: string;
}): Promise<string> {
  const isolatedHome = path.join(input.tempDir, "antigravity-home");
  const reviewRoots = [input.reviewCwd, input.input.target.repo_root];
  if (await antigravityHomeIsInsideReviewWorkspace(reviewRoots, input.tempDir)) {
    throw reviewerFailed(
      "Antigravity isolated home resolved inside the review workspace; set TMPDIR outside the repository before running Antigravity reviews.",
    );
  }
  const geminiDir = path.join(isolatedHome, ".gemini");
  const cliDir = path.join(geminiDir, "antigravity-cli");
  const configDir = path.join(geminiDir, "config");
  await mkdir(cliDir, { recursive: true });
  await mkdir(configDir, { recursive: true });
  await mkdir(path.join(isolatedHome, ".config"), { recursive: true });
  const sourceGeminiDir = antigravitySourceGeminiDir(input.input.env);
  if (
    sourceGeminiDir !== undefined &&
    (await pathIsInsideReviewWorkspace(reviewRoots, sourceGeminiDir))
  ) {
    throw reviewerFailed(
      "Antigravity source credentials resolved inside the review workspace; set HOME or USERPROFILE outside the repository before running Antigravity reviews.",
    );
  }
  await writeFile(
    path.join(cliDir, antigravityCliReviewSettingsFileName),
    `${JSON.stringify(
      {
        ...(await readAntigravityBaseSettings(sourceGeminiDir)),
        ...antigravityCliReviewSettings({ promptPath: input.promptPath, cwd: input.reviewCwd }),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(path.join(configDir, antigravityCliReviewMcpConfigFileName), "{}\n", "utf8");
  await copyAntigravityAuthFiles(geminiDir, cliDir, sourceGeminiDir);
  return isolatedHome;
}

async function copyAntigravityAuthFiles(
  geminiDir: string,
  cliDir: string,
  sourceGeminiDir: string | undefined,
): Promise<void> {
  if (sourceGeminiDir === undefined) {
    return;
  }
  await copyIfPresent(
    path.join(sourceGeminiDir, "oauth_creds.json"),
    path.join(geminiDir, "oauth_creds.json"),
  );
  await copyIfPresent(
    path.join(sourceGeminiDir, "google_accounts.json"),
    path.join(geminiDir, "google_accounts.json"),
  );
  await copyIfPresent(
    path.join(sourceGeminiDir, "installation_id"),
    path.join(geminiDir, "installation_id"),
  );
  await copyIfPresent(
    path.join(sourceGeminiDir, "antigravity-cli", "installation_id"),
    path.join(cliDir, "installation_id"),
  );
}

async function readAntigravityBaseSettings(
  sourceGeminiDir: string | undefined,
): Promise<Record<string, unknown>> {
  if (sourceGeminiDir === undefined) {
    return {};
  }

  try {
    const contents = await readFile(
      path.join(sourceGeminiDir, "antigravity-cli", antigravityCliReviewSettingsFileName),
      "utf8",
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents) as unknown;
    } catch {
      return {};
    }
    return isPlainRecord(parsed) ? antigravityNonPolicySettings(parsed) : {};
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return {};
    }
    throw error;
  }
}

function antigravityNonPolicySettings(settings: Record<string, unknown>): Record<string, unknown> {
  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(settings)) {
    if (!antigravityUserSettingsPolicyKeys.has(key)) {
      filtered[key] = value;
    }
  }
  return filtered;
}

export function antigravitySourceGeminiDir(
  env: NodeJS.ProcessEnv | undefined,
  fallbackHome = homedir(),
): string | undefined {
  const sourceHome = antigravitySourceHome(env, fallbackHome);
  return sourceHome === undefined ? undefined : path.join(sourceHome, ".gemini");
}

function antigravitySourceHome(
  env: NodeJS.ProcessEnv | undefined,
  fallbackHome: string,
): string | undefined {
  const home = env?.HOME?.trim();
  if (home) {
    return home;
  }

  const userProfile = env?.USERPROFILE?.trim();
  if (userProfile) {
    return userProfile;
  }

  const homeDrive = env?.HOMEDRIVE?.trim();
  const homePath = env?.HOMEPATH?.trim();
  if (homeDrive && homePath) {
    return path.win32.join(homeDrive, homePath);
  }

  const hasExplicitHomeBoundary =
    env !== undefined &&
    (env.HOME !== undefined ||
      env.USERPROFILE !== undefined ||
      env.HOMEDRIVE !== undefined ||
      env.HOMEPATH !== undefined);
  if (hasExplicitHomeBoundary) {
    return undefined;
  }

  if (env !== undefined) {
    if (env === process.env) {
      return fallbackHome;
    }
    // An explicit child environment is an auth boundary unless it provides a home path.
    return undefined;
  }

  return fallbackHome;
}

async function antigravityHomeIsInsideReviewWorkspace(
  reviewRoots: string[],
  tempDir: string,
): Promise<boolean> {
  const tempRoot = await realpathOrResolve(tempDir);
  return await pathIsInsideReviewWorkspace(reviewRoots, path.join(tempRoot, "antigravity-home"));
}

async function pathIsInsideReviewWorkspace(
  reviewRoots: string[],
  candidatePath: string,
): Promise<boolean> {
  const candidate = await realpathOrResolve(candidatePath);
  for (const reviewRoot of [...new Set(reviewRoots)]) {
    if (isPathInside(await realpathOrResolve(reviewRoot), candidate)) {
      return true;
    }
  }
  return false;
}

async function realpathOrResolve(inputPath: string): Promise<string> {
  try {
    return await realpath(inputPath);
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      const resolved = path.resolve(inputPath);
      const parent = path.dirname(resolved);
      if (parent === resolved) {
        return resolved;
      }
      return path.join(await realpathOrResolve(parent), path.basename(resolved));
    }
    throw error;
  }
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

async function copyIfPresent(source: string, destination: string): Promise<void> {
  try {
    await copyFile(source, destination);
  } catch (error) {
    if (!isNodeErrorWithCode(error, "ENOENT")) {
      throw error;
    }
  }
}

async function firstPresentFile(sources: readonly string[]): Promise<string | undefined> {
  for (const source of sources) {
    try {
      await access(source);
      return source;
    } catch (error) {
      if (!isNodeErrorWithCode(error, "ENOENT")) {
        throw error;
      }
    }
  }
  return undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function droidCliSessionSettingsMetadata(
  stdout: string,
  sessionDirectory: string | undefined,
): Promise<Record<string, string>> {
  const sessionId = droidCliSessionId(stdout);
  if (sessionId === undefined || sessionDirectory === undefined) {
    return {};
  }

  const settings = await readDroidSessionSettings(sessionDirectory, sessionId);
  if (settings === undefined) {
    return {};
  }

  const model = droidSettingsModel(settings);
  const effort = stringValue(settings.specModeReasoningEffort ?? settings.reasoningEffort);

  return {
    droidSessionId: sessionId,
    ...(model !== undefined ? { droidSessionModel: model } : {}),
    ...(effort !== undefined ? { droidSessionEffort: effort } : {}),
    ...(model !== undefined
      ? modelResolutionMetadata({ resolved: model, source: "provider-local" })
      : {}),
    ...(effort !== undefined
      ? effortResolutionMetadata({ resolved: effort, source: "provider-local" })
      : {}),
  };
}

async function readDroidSessionSettings(
  sessionDirectory: string,
  sessionId: string,
): Promise<Record<string, unknown> | undefined> {
  const fileName = `${sessionId}.settings.json`;
  const directFile = path.join(sessionDirectory, fileName);
  const directSettings = await readJsonRecord(directFile);
  if (directSettings !== undefined) {
    return directSettings;
  }

  try {
    for (const entry of await readdir(path.dirname(sessionDirectory), { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }

      const candidateFile = path.join(path.dirname(sessionDirectory), entry.name, fileName);
      if (candidateFile === directFile) {
        continue;
      }

      const candidateSettings = await readJsonRecord(candidateFile);
      if (candidateSettings !== undefined) {
        return candidateSettings;
      }
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function droidCliSessionId(stdout: string): string | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!isRecord(parsed)) {
      return undefined;
    }
    return stringValue(parsed.session_id ?? parsed.sessionId);
  } catch {
    return undefined;
  }
}

function droidCliReviewLogGroupId(input: { reviewer: { id: string } }): string {
  return `diffwarden-${sanitizeDroidLogGroupPart(input.reviewer.id)}-${randomUUID()}`;
}

function sanitizeDroidLogGroupPart(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return sanitized || "reviewer";
}

async function readJsonRecord(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function droidCliSessionDirectory(
  cwd: string,
  env: NodeJS.ProcessEnv | undefined,
): Promise<string> {
  return path.join(
    droidFactoryHome(env),
    "sessions",
    encodeDroidSessionProjectPath(await realCwd(cwd)),
  );
}

function droidFactoryHome(env: NodeJS.ProcessEnv | undefined): string {
  const home = env?.HOME?.trim() || homedir();
  return path.join(home, ".factory");
}

function encodeDroidSessionProjectPath(cwd: string): string {
  const drivePath = /^[A-Za-z]:[\\/]/.test(cwd) ? cwd : path.resolve(cwd);
  const driveMatch = /^([A-Za-z]):[\\/]*(.*)$/.exec(drivePath);
  if (driveMatch !== null) {
    const [, drive = "", rest = ""] = driveMatch;
    return `-${drive}-${rest.replace(/[\\/]+/g, "-")}`;
  }
  return path.resolve(cwd).replace(/[:\\/]/g, "-");
}

async function realCwd(cwd: string): Promise<string> {
  try {
    return await realpath(cwd);
  } catch {
    return cwd;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function droidSettingsModel(settings: Record<string, unknown>): string | undefined {
  const specModeModel = stringValue(settings.specModeModel);
  const model = stringValue(settings.model);
  return (
    stringValue(settings.specModeModelId) ??
    stableModelId(specModeModel) ??
    stringValue(settings.modelId) ??
    specModeModel ??
    stableModelId(model) ??
    model
  );
}

function stableModelId(value: string | undefined): string | undefined {
  return value !== undefined && !/\s/.test(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
