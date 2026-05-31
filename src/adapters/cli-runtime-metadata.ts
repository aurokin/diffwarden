import {
  type ResolutionSource,
  effortResolutionMetadata,
  modelResolutionMetadata,
} from "./metadata.js";

type JsonRecord = Record<string, unknown>;

type Resolution = {
  value: string;
  source: Extract<ResolutionSource, "provider-init" | "provider-result">;
};

const modelKeys = [
  "resolvedModel",
  "resolved_model",
  "selectedModel",
  "selected_model",
  "currentModel",
  "current_model",
  "modelId",
  "model_id",
  "model",
] as const;

const effortKeys = [
  "resolvedEffort",
  "resolved_effort",
  "selectedEffort",
  "selected_effort",
  "reasoningEffort",
  "reasoning_effort",
  "modelReasoningEffort",
  "model_reasoning_effort",
  "thinkingLevel",
  "thinking_level",
  "thinking",
  "effort",
] as const;

const nestedKeys = [
  "config",
  "configuration",
  "data",
  "event",
  "metadata",
  "message",
  "msg",
  "part",
  "payload",
  "response",
  "result",
  "runtime",
  "session",
  "settings",
] as const;

export function cliRuntimeResolutionMetadata(raw: string): Record<string, string> {
  const records = parseJsonRecords(raw);
  let model: Resolution | undefined;
  let effort: Resolution | undefined;

  for (const record of records) {
    const source = resolutionSource(record);
    const resolvedModel = extractModel(record);
    const resolvedEffort = extractEffort(record);

    if (resolvedModel !== undefined) {
      model = strongerResolution(model, { value: resolvedModel, source });
    }
    if (resolvedEffort !== undefined) {
      effort = strongerResolution(effort, { value: resolvedEffort, source });
    }
  }

  return {
    ...(model !== undefined
      ? modelResolutionMetadata({ resolved: model.value, source: model.source })
      : {}),
    ...(effort !== undefined
      ? effortResolutionMetadata({ resolved: effort.value, source: effort.source })
      : {}),
  };
}

function parseJsonRecords(raw: string): JsonRecord[] {
  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }

  const whole = parseJson(trimmed);
  if (Array.isArray(whole)) {
    return whole.filter(isRecord);
  }
  if (isRecord(whole)) {
    return [whole];
  }

  return trimmed
    .split(/\r?\n/)
    .map((line) => parseJson(line.trim()))
    .filter(isRecord);
}

function parseJson(value: string): unknown {
  if (!value) {
    return undefined;
  }
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function resolutionSource(
  record: JsonRecord,
): Extract<ResolutionSource, "provider-init" | "provider-result"> {
  if (record.settings !== undefined || record.configuration !== undefined) {
    return "provider-init";
  }

  const type = stringValue(record.type ?? record.event ?? record.kind ?? record.name);
  if (type !== undefined && providerInitEventType(type)) {
    return "provider-init";
  }

  return "provider-result";
}

function providerInitEventType(type: string): boolean {
  const normalized = type.toLowerCase();
  return (
    /(^|[._-])(init|initialized|config|configured|system)([._-]|$)/.test(normalized) ||
    /^(session|thread|runtime)([._-]|$)/.test(normalized)
  );
}

function strongerResolution(current: Resolution | undefined, next: Resolution): Resolution {
  if (current === undefined) {
    return next;
  }
  return sourceRank(next.source) >= sourceRank(current.source) ? next : current;
}

function sourceRank(source: Resolution["source"]): number {
  return source === "provider-result" ? 2 : 1;
}

function extractModel(record: JsonRecord, depth = 0): string | undefined {
  const settingsModel = settingsModelId(record);
  if (settingsModel !== undefined) {
    return settingsModel;
  }

  for (const key of modelKeys) {
    const value = modelString(record[key]);
    if (value !== undefined) {
      return value;
    }
  }

  const nestedModel = extractNested(record, extractModel, depth);
  if (nestedModel !== undefined) {
    return nestedModel;
  }

  return singleModelUsageModel(record);
}

function extractEffort(record: JsonRecord, depth = 0): string | undefined {
  const settingsEffort = settingsReasoningEffort(record);
  if (settingsEffort !== undefined) {
    return settingsEffort;
  }

  for (const key of effortKeys) {
    const value = stringValue(record[key]);
    if (value !== undefined) {
      return value;
    }
  }

  return extractNested(record, extractEffort, depth);
}

function extractNested(
  record: JsonRecord,
  extract: (record: JsonRecord, depth: number) => string | undefined,
  depth: number,
): string | undefined {
  if (depth >= 3) {
    return undefined;
  }

  for (const key of nestedKeys) {
    const nested = record[key];
    if (isRecord(nested)) {
      const value = extract(nested, depth + 1);
      if (value !== undefined) {
        return value;
      }
    }
  }

  return undefined;
}

function settingsModelId(record: JsonRecord): string | undefined {
  const settings = settingsRecord(record);
  if (settings === undefined) {
    return undefined;
  }
  return stringValue(settings.specModeModelId ?? settings.spec_mode_model_id ?? settings.modelId);
}

function settingsReasoningEffort(record: JsonRecord): string | undefined {
  const settings = settingsRecord(record);
  if (settings === undefined) {
    return undefined;
  }
  return stringValue(
    settings.specModeReasoningEffort ??
      settings.spec_mode_reasoning_effort ??
      settings.reasoningEffort,
  );
}

function settingsRecord(record: JsonRecord): JsonRecord | undefined {
  if (isRecord(record.settings)) {
    return record.settings;
  }
  return record.specModeModelId !== undefined ||
    record.spec_mode_model_id !== undefined ||
    record.specModeReasoningEffort !== undefined ||
    record.spec_mode_reasoning_effort !== undefined
    ? record
    : undefined;
}

function singleModelUsageModel(record: JsonRecord): string | undefined {
  if (!isRecord(record.modelUsage)) {
    return undefined;
  }

  const models = Object.keys(record.modelUsage)
    .map(cleanModelUsageModel)
    .filter((model) => model.length > 0);
  return models.length === 1 ? models[0] : undefined;
}

function cleanModelUsageModel(model: string): string {
  return stripAnsiSgr(model)
    .replace(/\[[^\]]+\]$/g, "")
    .trim();
}

function stripAnsiSgr(value: string): string {
  const escapeChar = String.fromCharCode(27);
  let stripped = "";
  let index = 0;

  while (index < value.length) {
    if (value[index] !== escapeChar || value[index + 1] !== "[") {
      stripped += value[index] ?? "";
      index += 1;
      continue;
    }

    let end = index + 2;
    while (end < value.length && /[0-9;]/.test(value[end] ?? "")) {
      end += 1;
    }

    if (value[end] === "m") {
      index = end + 1;
      continue;
    }

    stripped += value[index] ?? "";
    index += 1;
  }

  return stripped;
}

function modelString(value: unknown): string | undefined {
  const direct = stringValue(value);
  if (direct !== undefined) {
    return direct;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  return stringValue(value.id ?? value.modelId ?? value.model_id ?? value.value ?? value.name);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
