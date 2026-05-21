export function isIntegrationDisabled(sdk: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.INTEGRATION_TEST_ON !== "1") {
    return true;
  }

  return integrationDisableList(env).includes(sdk);
}

export function enabledIntegrationItems(
  items: string[],
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (env.INTEGRATION_TEST_ON !== "1") {
    return [];
  }

  const disabled = new Set(integrationDisableList(env));
  return items.filter((item) => !disabled.has(item));
}

export function isLiveCliDisabled(sdk: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (isIntegrationDisabled(sdk, env)) {
    return true;
  }

  const selected = liveCliList(env);
  return selected.length > 0 && !selected.includes(sdk);
}

function integrationDisableList(env: NodeJS.ProcessEnv): string[] {
  return (env.INTEGRATION_DISABLE ?? "")
    .split(",")
    .map((sdk) => sdk.trim())
    .filter((sdk) => sdk.length > 0);
}

function liveCliList(env: NodeJS.ProcessEnv): string[] {
  return (env.DIFFWARDEN_LIVE_CLI ?? "")
    .split(",")
    .map((sdk) => sdk.trim())
    .filter((sdk) => sdk.length > 0);
}
