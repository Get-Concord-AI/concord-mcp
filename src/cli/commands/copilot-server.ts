/** Where the launcher tells hooks the embedded Copilot UI server listens. */
export const COPILOT_SERVER_ENV = 'CONCORD_COPILOT_SERVER_URL';

/** The address the launcher exports, when this process descends from it. */
export function copilotServerAddress(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const address = env[COPILOT_SERVER_ENV]?.trim();
  return address === undefined || address === '' ? undefined : address;
}
