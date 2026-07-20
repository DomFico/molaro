/**
 * The webview CSP invariants — the guard the E2E suite structurally cannot
 * provide. S45 and the plot harness serve their OWN HTML/CSP, so a drift in
 * the real extension's `renderPlotHtml` CSP (as happened: the plot webview
 * lost `img-src ... data:` while figures render a base64 PNG data: URI, giving
 * every figure a broken-image glyph) is invisible to them. buildWebviewCsp is
 * vscode-free precisely so this can run under `node --test`.
 *
 * Run from viewer/:  node --test tests/webviewcsp.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildWebviewCsp } from "../src/webviewcsp.ts";

const SRC = "vscode-webview://abc";
const NONCE = "N0nce";

// The three webviews, exactly as src/extension.ts constructs them.
const viewerCsp = () =>
  buildWebviewCsp({ cspSource: SRC, nonce: NONCE, allowDataImages: true, allowConnect: true });
const plotCsp = () => buildWebviewCsp({ cspSource: SRC, nonce: NONCE, allowDataImages: true });
const terminalCsp = () => buildWebviewCsp({ cspSource: SRC, nonce: NONCE });

test("every webview locks down to default-src 'none' with a nonce-gated script-src", () => {
  for (const csp of [viewerCsp(), plotCsp(), terminalCsp()]) {
    assert.match(csp, /^default-src 'none'/, "starts closed");
    assert.match(csp, new RegExp(`script-src 'nonce-${NONCE}' ${SRC}`), "scripts nonce+origin only");
    assert.match(csp, new RegExp(`style-src ${SRC} 'nonce-${NONCE}'`));
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|\*/, "no wildcards, no inline/eval");
  }
});

test("THE REGRESSION: the plot webview permits data: images (figures render as data: PNGs)", () => {
  // Without this the figure <img> is blocked by default-src 'none' and shows a
  // broken-image glyph — the exact bug this guard exists to prevent.
  assert.match(plotCsp(), new RegExp(`img-src ${SRC} data:`), "plot MUST allow data: images");
});

test("the main viewer allows data: images and connect-src; the plot allows images but not connect", () => {
  assert.match(viewerCsp(), new RegExp(`img-src ${SRC} data:`));
  assert.match(viewerCsp(), new RegExp(`connect-src ${SRC}`));
  assert.doesNotMatch(plotCsp(), /connect-src/, "the plot never needs connect-src");
});

test("the terminal renders no images and declares no img-src (minimal surface)", () => {
  assert.doesNotMatch(terminalCsp(), /img-src/);
  assert.doesNotMatch(terminalCsp(), /connect-src/);
});

test("allowDataImages is what gates img-src — a webview without it forbids images", () => {
  const noImages = buildWebviewCsp({ cspSource: SRC, nonce: NONCE });
  assert.doesNotMatch(noImages, /img-src/,
    "no img-src means images fall back to default-src 'none' — blocked, by design");
});

test("directive order is stable (byte-identical policy across renders)", () => {
  assert.equal(
    plotCsp(),
    `default-src 'none'; script-src 'nonce-${NONCE}' ${SRC}; style-src ${SRC} 'nonce-${NONCE}'; img-src ${SRC} data:`,
  );
  assert.equal(
    terminalCsp(),
    `default-src 'none'; script-src 'nonce-${NONCE}' ${SRC}; style-src ${SRC} 'nonce-${NONCE}'`,
  );
});
