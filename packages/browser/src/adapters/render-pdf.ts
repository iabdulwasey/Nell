/**
 * Making a document.
 *
 * The other half of reading one. A user who is told their resume is vague wants
 * the fixed version, not a list of complaints — and Instinct's ability to hand
 * back a new file is most of what makes it feel like an assistant rather than a
 * critic.
 *
 * Chromium is already here for the browser, and Chromium prints PDFs. So this
 * needs no new dependency, no PDF library, and no layout engine of our own: the
 * document is HTML, which a model writes well, and the same engine that renders
 * every page the agent visits renders this one.
 *
 * Deliberately not given the agent's session. A document is rendered in a
 * throwaway context with no cookies and no profile, because the page being
 * printed is text a model just wrote — and a model-authored page inside a
 * browser holding the user's logins is exactly the shape of thing this
 * repository spends its effort preventing.
 */

import { chromium } from "playwright-core";

export interface PdfOptions {
  /** A4 unless a caller has a reason. Letter for a US audience. */
  readonly format?: "A4" | "Letter";
  readonly marginMm?: number;
}

/**
 * Render HTML to a PDF.
 *
 * `setContent` rather than a data URL: a long document exceeds what a URL can
 * carry, and the failure would arrive as a truncated page rather than an error.
 */
export async function renderPdf(html: string, options: PdfOptions = {}): Promise<Buffer> {
  const browser = await chromium.launch({ headless: true });

  try {
    const context = await browser.newContext();
    const page = await context.newPage();

    // `networkidle` would hang on a document with no network at all; the
    // content is already in hand, so waiting for the DOM is the whole wait.
    await page.setContent(wrap(html), { waitUntil: "domcontentloaded" });
    await page.emulateMedia({ media: "print" });

    const margin = `${String(options.marginMm ?? 16)}mm`;
    return await page.pdf({
      format: options.format ?? "A4",
      printBackground: true,
      margin: { top: margin, bottom: margin, left: margin, right: margin },
    });
  } finally {
    await browser.close();
  }
}

/**
 * House styling, so a model does not have to write CSS to produce something
 * that looks like a document rather than a 1996 web page.
 *
 * Applied only when the model did not supply its own `<style>`, so a deliberate
 * design is never overridden by a default.
 */
function wrap(html: string): string {
  if (/<style|<!doctype/iu.test(html)) return html;

  return `<!doctype html><html><head><meta charset="utf-8"><style>
    :root { color-scheme: light }
    body { font: 11pt/1.45 -apple-system, "Helvetica Neue", Arial, sans-serif;
           color: #111; margin: 0 }
    h1 { font-size: 20pt; margin: 0 0 2pt }
    h2 { font-size: 11pt; text-transform: uppercase; letter-spacing: .08em;
         border-bottom: 1px solid #ccc; padding-bottom: 3pt; margin: 16pt 0 6pt }
    h3 { font-size: 11pt; margin: 10pt 0 2pt }
    p, li { margin: 0 0 4pt }
    ul { margin: 0 0 6pt; padding-left: 16pt }
    a { color: inherit }
    .muted { color: #555 }
  </style></head><body>${html}</body></html>`;
}
