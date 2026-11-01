// The Stripe events applyEvent (webhooks.ts) acts on: the webhook endpoint subscribes to exactly
// these. On its own, without the database imports, so webhook-setup runs from a fresh checkout
// without a build.
import type Stripe from 'stripe';

export const HANDLED_EVENTS = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
] as const satisfies readonly Stripe.Event.Type[];
