/**
 * Reading a real page into a snapshot.
 *
 * The missing half of the perception design. `perception.ts` decides what a
 * model should be shown and hands out stable refs; nothing until now read an
 * actual page to produce them, and no action could target one — so the whole
 * ref mechanism was two well-tested halves that had never met.
 *
 * That gap mattered more than most, because refs are the entire reason
 * structured driving is safer than coordinates. The claim is that a stale ref
 * *raises* while a stale coordinate silently clicks whatever moved into that
 * spot. A ref nothing can act on cannot raise, and a ref that resolves loosely
 * cannot be stale — so both halves have to exist for the claim to be true.
 *
 * How staleness actually works here: each snapshot stamps every element it saw
 * with `data-nell-ref="<version>:<id>"`, and bumps the version first, clearing
 * the previous stamps. A ref from an earlier snapshot therefore matches nothing
 * — not "matches something else", which is the failure mode being avoided.
 * Acting on it fails loudly, on the page, before anything is clicked.
 */

import type { Page } from "playwright-core";
import { buildSnapshot, type PageSnapshot, type SnapshotNode } from "../perception.js";

/** Attribute the snapshot writes onto the page. Namespaced to avoid collisions. */
export const REF_ATTRIBUTE = "data-nell-ref";

/**
 * Roles worth collecting, and how to recognise them without a full accessibility
 * engine.
 *
 * Deliberately a small mapping rather than a reimplementation of ARIA. An
 * explicit `role` attribute wins; otherwise the tag and input type decide. The
 * cases this gets wrong are exotic, and the cost of getting one wrong is that a
 * model is shown a slightly odd role name, not that anything unsafe happens.
 */
const COLLECTOR = `(version) => {
  const previous = document.querySelectorAll('[data-nell-ref]');
  for (const element of previous) element.removeAttribute('data-nell-ref');

  const roleOf = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : 'generic';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'summary') return 'button';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'li') return 'listitem';
    if (tag === 'table') return 'table';
    if (tag === 'dialog') return 'dialog';
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'range') return 'slider';
      if (type === 'search') return 'searchbox';
      if (['button','submit','reset','image'].includes(type)) return 'button';
      if (['hidden'].includes(type)) return 'none';
      return 'textbox';
    }
    return 'generic';
  };

  const nameOf = (el) => {
    const label = el.getAttribute('aria-label');
    if (label) return label.trim();
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const target = document.getElementById(labelledBy);
      if (target && target.textContent) return target.textContent.trim();
    }
    if (el.id) {
      const forLabel = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (forLabel && forLabel.textContent) return forLabel.textContent.trim();
    }
    const wrapping = el.closest('label');
    if (wrapping && wrapping.textContent) return wrapping.textContent.trim();
    if (el.getAttribute('placeholder')) return el.getAttribute('placeholder').trim();
    if (el.getAttribute('title')) return el.getAttribute('title').trim();
    return (el.textContent || '').trim();
  };

  // Only what a person could actually interact with or read. An element with no
  // box has no presence on the page, whatever the markup says.
  const visible = (el) => {
    const style = window.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    const box = el.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  };

  const nodes = [];
  let counter = 0;

  for (const el of document.querySelectorAll('a,button,input,select,textarea,summary,h1,h2,h3,h4,h5,h6,li,table,dialog,[role]')) {
    const role = roleOf(el);
    if (role === 'none' || role === 'generic') continue;
    if (!visible(el)) continue;

    counter += 1;
    const ref = version + ':e' + counter;
    el.setAttribute('data-nell-ref', ref);

    nodes.push({
      ref,
      role,
      name: nameOf(el).slice(0, 300) || undefined,
      value: el.value === undefined || el.value === '' ? undefined : String(el.value).slice(0, 300),
      disabled: el.disabled === true ? true : undefined,
      checked: el.type === 'checkbox' || el.type === 'radio' ? el.checked === true : undefined,
    });
  }

  return {
    url: location.href,
    title: document.title,
    text: (document.body ? document.body.innerText : '').slice(0, 20000),
    nodes,
  };
}`;

interface RawSnapshot {
  readonly url: string;
  readonly title: string;
  readonly text: string;
  readonly nodes: readonly SnapshotNode[];
}

/**
 * Take a snapshot, stamping the page so the refs can be acted on.
 *
 * The version is supplied by the caller and must increase. It is what makes a
 * ref from a previous look match nothing rather than match the wrong element —
 * the single property that separates this from driving by coordinates.
 */
export async function snapshotPage(
  page: Page,
  version: number,
  maxNodes?: number
): Promise<PageSnapshot> {
  // Invoked rather than passed as an argument: `evaluate` given a string
  // evaluates it as an *expression*, so handing it a function literal returns
  // the function — which is not serialisable, so it arrives as undefined. The
  // collector stays a string so nothing has to survive TypeScript compilation
  // on its way into the page.
  const raw = (await page.evaluate(
    `(${COLLECTOR})(${JSON.stringify(String(version))})`
  )) as RawSnapshot;

  return buildSnapshot({
    url: raw.url,
    title: raw.title,
    candidates: raw.nodes,
    text: raw.text,
    maxNodes,
  });
}

/**
 * Whether a ref belongs to the current snapshot.
 *
 * Checked before the page is touched so a stale ref produces a clear sentence
 * rather than a Playwright timeout thirty seconds later, which is technically a
 * failure and practically a mystery.
 */
export function isCurrentRef(ref: string, version: number): boolean {
  return ref.startsWith(`${String(version)}:`);
}

export function refSelector(ref: string): string {
  return `[${REF_ATTRIBUTE}="${ref.replaceAll('"', '\\"')}"]`;
}
