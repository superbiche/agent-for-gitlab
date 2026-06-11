import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function writeOutput(success, data = {}) {
  const output = {
    success,
    timestamp: new Date().toISOString(),
    ...data,
  };

  const path = process.env.AI_OUTPUT_PATH || (existsSync("/opt/agent") ? "/opt/agent/ai-output.json" : "ai-output.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(output, null, 2));
  return output;
}
