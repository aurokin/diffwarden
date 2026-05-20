export function isIntegrationDisabled(sdk: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.INTEGRATION_TEST_ON !== "1") {
    return true;
  }

  return integrationDisableList(env).includes(sdk);
}

function integrationDisableList(env: NodeJS.ProcessEnv): string[] {
  return (env.INTEGRATION_DISABLE ?? "")
    .split(",")
    .map((sdk) => sdk.trim())
    .filter((sdk) => sdk.length > 0);
}
