/**
 * Recognising the click that spends the money.
 *
 * The spend gate has been complete and tested since Phase 0 — payload hashing,
 * single-use tokens, TTLs, six adversarial attacks driving it — and nothing in
 * the agent has ever called it. A click on "Place order" went through the
 * executor exactly like a click on "Next".
 *
 * What actually stopped a live booking at the payment page was the model saying
 * *"I should stop here as instructed before anything that spends money."* That
 * is the model being obedient, which is the one thing this codebase says it does
 * not rely on. The README claims purchases are "enforced in code — not by a
 * prompt you hope the model obeys", and until this file existed that sentence
 * was carried by a prompt.
 *
 * **What this is, precisely.** A detector, not a proof. It reads the label of
 * the thing about to be clicked and decides whether that label means money
 * moves. Labels are written by merchants, in many languages, and a determined
 * checkout can call its final button anything — so this catches the ordinary
 * case well and cannot promise the exotic one.
 *
 * The guarantee that does not depend on reading English is the single-use
 * virtual card capped at the approved total, where the limit is enforced by the
 * card network rather than by us. This is the layer in front of it, and it is
 * worth having because it works on merchants that take no card at all.
 *
 * **Erring toward refusing.** A false positive costs one approval the user did
 * not need to give. A false negative spends their money. Those are not
 * comparable, so the list below includes anything that plausibly commits, and
 * deliberately excludes the steps *before* commitment — a basket is not a
 * purchase, and refusing "Add to cart" would make the gate so noisy that people
 * would learn to approve without reading, which is how approval stops meaning
 * anything.
 */

/**
 * Labels that mean money moves when this is clicked.
 *
 * Written as whole-phrase patterns rather than keywords: "pay" appears in
 * "payment method" and "paypal", neither of which commits anything on its own.
 */
const COMMITS: readonly RegExp[] = [
  /\bpay\s*(now|securely)?\s*(£|\$|€|₹|\d)/iu,
  /\b(pay|pay now|pay securely|make payment|submit payment|confirm payment)\b/iu,
  // "Place your order" is Amazon's, and very likely the most-clicked purchase
  // button there is — the first version of this allowed "the" and not "your".
  /\b(place|submit|confirm|complete)\s+((the|your|my)\s+)?(order|booking|purchase|payment|reservation)\b/iu,
  /\b(buy|purchase)\s*(it\s*)?now\b/iu,
  /\bcomplete\s+(my\s+)?(purchase|checkout|booking)\b/iu,
  /\bconfirm\s+(and|&)\s+pay\b/iu,
  /\bbook\s+(and\s+pay|now\s*(£|\$|€|₹|\d))/iu,
  /\bauthori[sz]e\s+payment\b/iu,
  /\bfinali[sz]e\s+(order|booking|purchase)\b/iu,
  /\bplace\s+bid\b/iu,
  /\bsubscribe\s*(£|\$|€|₹|\d|and pay)/iu,
];

/**
 * Labels that look adjacent but commit nothing.
 *
 * Checked first, because several of them contain words the patterns above look
 * for — "payment method" contains "payment", "checkout" precedes a form rather
 * than concluding one. Refusing these would make the gate fire on nearly every
 * shopping page, and an approval people see constantly is an approval they stop
 * reading.
 */
const HARMLESS: readonly RegExp[] = [
  /\badd to (cart|basket|bag)\b/iu,
  /\b(go to|view|proceed to|continue to)\s+(cart|basket|checkout)\b/iu,
  /\b(payment|billing|delivery|shipping)\s+(method|details|address|options|information)\b/iu,
  /\b(edit|change|remove|update|apply|cancel)\b/iu,
  /\bsave\s+(card|details|for later)\b/iu,
  /\b(terms|privacy|refund|cancellation)\s+(and|&|policy|conditions)/iu,
  /\bhow (do i |to )?pay\b/iu,
];

export interface MoneyVerdict {
  readonly commits: boolean;
  /** The label that decided it, so a refusal can name what it was about to click. */
  readonly label?: string;
}

/**
 * Would clicking this spend money?
 *
 * Given the visible label of the element about to be clicked. An empty or
 * unreadable label is *not* treated as a purchase: a gate that refuses
 * everything it cannot read refuses every click on a page it cannot read, which
 * is a broken agent rather than a safe one. That limit is real and stated here
 * rather than hidden — the card cap is what covers it.
 */
export function commitsMoney(label: string): MoneyVerdict {
  const text = label.trim().replaceAll(/\s+/gu, " ").slice(0, 200);
  if (!text) return { commits: false };

  for (const pattern of HARMLESS) {
    if (pattern.test(text)) return { commits: false };
  }

  for (const pattern of COMMITS) {
    if (pattern.test(text)) return { commits: true, label: text };
  }

  return { commits: false };
}

/**
 * What the user is asked.
 *
 * Names the button, because "approve this purchase?" with nothing attached is a
 * question nobody can answer well, and an approval given without knowing what it
 * buys is the failure this whole mechanism exists to prevent.
 */
export function askBeforeSpending(label: string): string {
  return (
    `I'm about to click "${label}", which looks like it spends money. ` +
    `I've stopped. Reply "yes" to go ahead, or tell me what to change.`
  );
}
