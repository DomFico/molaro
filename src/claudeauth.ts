/**
 * API-key authentication for the assistant backend — VS Code only, never the
 * webview. The key comes from SecretStorage, falling back to the
 * ANTHROPIC_API_KEY environment variable; if neither is present the user is
 * prompted through VS Code's native password input box and the answer is stored
 * in SecretStorage. The key is never logged, echoed, or persisted anywhere
 * else; it reaches the SDK only through the agent subprocess env
 * (buildAgentOptions). A clear/replace command rounds it out.
 *
 * Molaro is a distributed extension: per Anthropic policy it uses API-key auth,
 * NOT the user's claude.ai / Claude Code login.
 */
import * as vscode from "vscode";

export const SECRET_KEY = "molaro.anthropicApiKey";
const ENV_KEY = "ANTHROPIC_API_KEY";

/** Resolve a key without prompting: SecretStorage first, then the environment.
 * null means "no key configured" — the caller drives auth-status disconnected. */
export async function resolveApiKey(context: vscode.ExtensionContext): Promise<string | null> {
  const stored = await context.secrets.get(SECRET_KEY);
  if (stored && stored.trim()) return stored.trim();
  const env = process.env[ENV_KEY];
  if (env && env.trim()) return env.trim();
  return null;
}

/** Prompt for a key through the native password box and store it. Returns the
 * stored key, or null if the user dismissed the box. */
export async function promptAndStoreApiKey(
  context: vscode.ExtensionContext,
): Promise<string | null> {
  const value = await vscode.window.showInputBox({
    title: "Molaro — Anthropic API Key",
    prompt: "Enter your Anthropic API key (stored in VS Code SecretStorage; used only for the analysis assistant).",
    password: true,
    ignoreFocusOut: true,
    placeHolder: "sk-ant-…",
    validateInput: (v) => (v.trim().length === 0 ? "The key cannot be empty." : undefined),
  });
  if (value === undefined) return null; // dismissed
  const key = value.trim();
  await context.secrets.store(SECRET_KEY, key);
  return key;
}

/** Clear the stored key (env-var fallback, if any, is untouched — it is not
 * ours to remove). */
export async function clearApiKey(context: vscode.ExtensionContext): Promise<void> {
  await context.secrets.delete(SECRET_KEY);
}

/** The user-actionable hint shown on the disconnected status line. */
export const NO_KEY_HINT =
  "No Anthropic API key. Run “Molaro: Set Anthropic API Key” (or set ANTHROPIC_API_KEY).";
