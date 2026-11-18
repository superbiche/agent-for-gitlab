import { readFileSync } from "node:fs";

// Exit status for a missing or invalid credential at startup (sysexits
// EX_CONFIG). The lugus deployment's OpenBao file delivery (infra lane A,
// consumer map "nativeExit": 78) expects the server to refuse to start with it.
export const EX_CONFIG = 78;

// A credential problem found at startup. The message names variables only,
// never a value.
export class ConfigError extends Error {}

// Read a credential from <NAME>_FILE (a path, e.g. /vault/secrets/<NAME>) or
// from <NAME> itself; setting both is refused. A one-line value loses at most
// one trailing newline; a multiline value (a PEM key) is returned as is.
// Returns undefined when neither variable is set (or <NAME> is empty).
export function readSecret(name: string, options: { multiline?: boolean } = {}): string | undefined {
  const filePath = process.env[`${name}_FILE`];
  const direct = process.env[name];
  if (filePath !== undefined && direct !== undefined) {
    throw new ConfigError(`${name} and ${name}_FILE are both set; set one`);
  }
  if (filePath === undefined) return direct || undefined;

  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    throw new ConfigError(`${name}_FILE does not name a readable file`);
  }
  const value = options.multiline ? raw : raw.replace(/\n$/, "");
  if (!value.trim()) throw new ConfigError(`${name}_FILE names an empty file`);
  if (!options.multiline && /[\r\n]/.test(value)) {
    throw new ConfigError(`${name}_FILE holds more than one line`);
  }
  return value;
}
