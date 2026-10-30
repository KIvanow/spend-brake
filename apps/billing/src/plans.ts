// Plans and what each includes. Indie, Team and Agents limits are the design doc's table; the
// Free plan's "1 key, $50/month of protected spend" is from the pricing table, and its other
// limits (1 provider, 20 agent sessions, 10,000 requests, 7 days) are this file's choice.
// Business and Enterprise are self-hosted licenses: their hosted org is only the customer
// record, so it keeps Free limits.

export const HOSTED_PLANS = ['indie', 'team', 'agents'] as const;
export const LICENSE_PLANS = ['business', 'enterprise'] as const;
export const PLANS = ['free', ...HOSTED_PLANS, ...LICENSE_PLANS] as const;
export type Plan = (typeof PLANS)[number];
/** Plans sold through Checkout (Enterprise is invoiced by hand). */
export const CHECKOUT_PLANS = [...HOSTED_PLANS, 'business'] as const;
export type CheckoutPlan = (typeof CHECKOUT_PLANS)[number];

export interface Limits {
  maxKeys: number | null;
  maxProviders: number | null;
  agentSessionsPerMonth: number | null;
  requestsPerMonth: number | null;
  maxOrgMonthCapMicros: bigint | null;
  retentionDays: number;
  sessionAnalytics: boolean;
  customLoopRules: boolean;
  /** OpenTelemetry export of calls to the org's own collector. */
  otelExport: boolean;
}

const FREE: Limits = {
  maxKeys: 1,
  maxProviders: 1,
  agentSessionsPerMonth: 20,
  requestsPerMonth: 10_000,
  maxOrgMonthCapMicros: 50_000_000n,
  retentionDays: 7,
  sessionAnalytics: false,
  customLoopRules: false,
  otelExport: false,
};

export const LIMITS: Record<Plan, Limits> = {
  free: FREE,
  indie: {
    maxKeys: null,
    maxProviders: 2,
    agentSessionsPerMonth: 100,
    requestsPerMonth: 100_000,
    maxOrgMonthCapMicros: null,
    retentionDays: 7,
    sessionAnalytics: false,
    customLoopRules: false,
    otelExport: false,
  },
  team: {
    maxKeys: null,
    maxProviders: 5,
    agentSessionsPerMonth: 500,
    requestsPerMonth: 1_000_000,
    maxOrgMonthCapMicros: null,
    retentionDays: 30,
    sessionAnalytics: false,
    customLoopRules: false,
    otelExport: true,
  },
  agents: {
    maxKeys: null,
    maxProviders: null,
    agentSessionsPerMonth: null,
    requestsPerMonth: 10_000_000,
    maxOrgMonthCapMicros: null,
    retentionDays: 365,
    sessionAnalytics: true,
    customLoopRules: true,
    otelExport: true,
  },
  business: FREE,
  enterprise: FREE,
};

/** Monthly price in USD cents (Enterprise: invoiced, from $10,000 a year). */
export const MONTHLY_CENTS: Record<CheckoutPlan, number> = {
  indie: 900,
  team: 4900,
  agents: 14900,
  business: 29900,
};

export const PLAN_NAMES: Record<Plan, string> = {
  free: 'Free',
  indie: 'Indie',
  team: 'Team',
  agents: 'Agents',
  business: 'Business (self-hosted license)',
  enterprise: 'Enterprise (self-hosted license)',
};

/** Orgs a license allows on one install unless the Stripe customer says otherwise. */
export const DEFAULT_ORG_UNITS: Record<(typeof LICENSE_PLANS)[number], number> = {
  business: 3,
  enterprise: 25,
};

export const lookupKey = (plan: CheckoutPlan) => `spend_brake_${plan}_monthly`;

/** Products and prices carry this metadata key naming the plan. */
export const PLAN_METADATA = 'spend_brake_plan';

export const isPlan = (v: unknown): v is Plan => PLANS.includes(v as Plan);
