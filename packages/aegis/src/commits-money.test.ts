/**
 * The detector that makes "it asks first" true in code rather than in a prompt.
 *
 * Two failure modes, and they are not comparable. A false positive costs one
 * approval the user did not need to give. A false negative spends their money.
 * So the tests below are weighted accordingly: the "must refuse" list is the one
 * that matters, and the "must not refuse" list exists to stop the gate becoming
 * so noisy that people approve without reading — which is how approval stops
 * meaning anything.
 */

import { describe, expect, it } from "vitest";
import { askBeforeSpending, commitsMoney } from "./commits-money.js";

describe("clicks that spend money", () => {
  it("catches the buttons that actually commit", () => {
    for (const label of [
      "Pay now",
      "Pay £18.50",
      "Pay $42.00",
      "Pay ₹3,499",
      "Place order",
      "Place your order",
      "Submit order",
      "Confirm booking",
      "Complete purchase",
      "Complete my booking",
      "Confirm and pay",
      "Confirm & Pay",
      "Buy now",
      "Buy it now",
      "Make payment",
      "Submit payment",
      "Authorise payment",
      "Authorize payment",
      "Finalise order",
      "Place bid",
      "Pay securely",
    ]) {
      expect(commitsMoney(label).commits, label).toBe(true);
    }
  });

  /**
   * A basket is not a purchase, and "checkout" precedes a form rather than
   * concluding one. Refusing these would make the gate fire on nearly every
   * shopping page.
   */
  it("leaves the steps before commitment alone", () => {
    for (const label of [
      "Add to cart",
      "Add to basket",
      "Add to bag",
      "Go to checkout",
      "Proceed to checkout",
      "View cart",
      "Continue",
      "Next",
      "Select seats",
      "Payment method",
      "Billing address",
      "Delivery options",
      "Edit payment details",
      "Save card for later",
      "Cancel",
      "Apply promo code",
      "Refund policy",
      "How do I pay?",
    ]) {
      expect(commitsMoney(label).commits, label).toBe(false);
    }
  });

  /**
   * The words the naive version gets wrong. "Pay" appears inside "payment
   * method" and "PayPal", neither of which commits anything by itself — a
   * keyword check would refuse both and teach the user to stop reading.
   */
  it("is not fooled by the word 'pay' appearing in something harmless", () => {
    for (const label of ["PayPal", "Payment methods", "Change payment method", "Paypal Checkout"]) {
      expect(commitsMoney(label).commits, label).toBe(false);
    }
  });

  /**
   * A gate that refuses everything it cannot read refuses every click on a page
   * it cannot read, which is a broken agent rather than a safe one. The limit is
   * real; the card cap is what covers it.
   */
  it("does not treat an unreadable label as a purchase", () => {
    for (const label of ["", "   ", "\n\t"]) {
      expect(commitsMoney(label).commits).toBe(false);
    }
  });

  it("normalises whitespace and long labels", () => {
    expect(commitsMoney("  Place    order\n ").commits).toBe(true);
    expect(commitsMoney(`Place order ${"x".repeat(500)}`).commits).toBe(true);
  });

  it("names what it stopped at, so the question can be answered", () => {
    const verdict = commitsMoney("Pay £18.50");
    expect(verdict.label).toBe("Pay £18.50");

    const asked = askBeforeSpending(verdict.label ?? "");
    expect(asked).toContain("Pay £18.50");
    // A question someone can act on, not a yes/no with nothing attached.
    expect(asked.toLowerCase()).toContain("yes");
  });
});
