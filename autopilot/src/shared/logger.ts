// Small prefixed logger. Logs go to the console of the context that produced
// them (service worker, content script or panel); nothing leaves the browser.

export interface Logger {
  info(message: string, detail?: unknown): void;
  warn(message: string, detail?: unknown): void;
  error(message: string, detail?: unknown): void;
}

export function createLogger(scope: string, sink: Pick<Console, 'info' | 'warn' | 'error'> = console): Logger {
  const prefix = `[Autopilot:${scope}]`;
  const write = (level: 'info' | 'warn' | 'error') => (message: string, detail?: unknown) => {
    if (detail === undefined) sink[level](prefix, message);
    else sink[level](prefix, message, detail);
  };
  return { info: write('info'), warn: write('warn'), error: write('error') };
}
