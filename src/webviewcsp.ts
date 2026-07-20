/**
 * The webview Content-Security-Policy, single-sourced.
 *
 * Three webviews (viewer / plot / terminal) each declared their own CSP as a
 * hand-copied array. That drift is a real bug source: when `produces: figure`
 * shipped, the plot began rendering a base64 PNG as a `data:` <img>, but its
 * CSP was never given `img-src ... data:` — so `default-src 'none'` blocked the
 * image and every figure showed a broken-image glyph. The E2E harness serves
 * its own HTML/CSP, so nothing in the suite exercised the real one.
 *
 * This module is the ONE place the policy is built, and it is deliberately
 * vscode-free so a plain `node --test` can assert the invariants that matter
 * (a webview that shows figures must permit data: images) without loading the
 * extension host. See tests/webviewcsp.test.ts.
 */

export interface CspOptions {
  /** The webview's `cspSource` (the vscode-provided origin token). */
  cspSource: string;
  /** The per-render nonce that gates inline <script>/<style>. */
  nonce: string;
  /**
   * Permit `data:` images. Required by any webview that renders a figure PNG
   * as a `data:image/png;base64,...` <img> (the plot) — and harmless on the
   * main viewer, which already carried it.
   */
  allowDataImages?: boolean;
  /** Permit `connect-src` back to the webview origin (the main viewer only). */
  allowConnect?: boolean;
}

/**
 * Build the CSP directive string for a webview. Order is stable so the emitted
 * policy is byte-identical across renders; directives are added only when the
 * caller opts in, keeping each webview's surface as small as it needs to be.
 */
export function buildWebviewCsp(o: CspOptions): string {
  const parts = [
    "default-src 'none'",
    `script-src 'nonce-${o.nonce}' ${o.cspSource}`,
    `style-src ${o.cspSource} 'nonce-${o.nonce}'`,
  ];
  if (o.allowDataImages) parts.push(`img-src ${o.cspSource} data:`);
  if (o.allowConnect) parts.push(`connect-src ${o.cspSource}`);
  return parts.join("; ");
}
