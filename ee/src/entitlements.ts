import { ApiError } from '@spend-brake/api';
import { type Db, desc } from '@spend-brake/db';
import { LICENSE_PUBLIC_KEY } from './license/keys.js';
import {
  type Feature,
  type License,
  type LicenseState,
  allows,
  licenseState,
  verifyLicense,
} from './license/license.js';
import { eeLicenses } from './schema.js';

/**
 * The install's license, read from Postgres and verified offline on every load (a short cache
 * keeps it off the request path). Nothing here can stop the proxy or caps: it only gates ee/.
 */
export class Entitlements {
  private cached: { until: number; license: License | null } | null = null;

  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
    readonly publicKey: string = LICENSE_PUBLIC_KEY,
    private readonly ttlMs = 30_000,
  ) {}

  async state(): Promise<LicenseState> {
    const at = this.now();
    if (!this.cached || this.cached.until <= Date.now()) {
      this.cached = { until: Date.now() + this.ttlMs, license: await this.load() };
    }
    return licenseState(this.cached.license, at);
  }

  private async load(): Promise<License | null> {
    const rows = await this.db.select().from(eeLicenses).orderBy(desc(eeLicenses.installedAt));
    // The newest one that still verifies (a row edited in the database does not).
    for (const row of rows) {
      try {
        return verifyLicense(row.raw, this.publicKey);
      } catch {
        continue;
      }
    }
    return null;
  }

  forget(): void {
    this.cached = null;
  }

  async can(feature: Feature, mode: 'read' | 'write'): Promise<boolean> {
    return allows(await this.state(), feature, mode);
  }

  /** Throw the API error that explains why a feature is not available. */
  async require(feature: Feature, mode: 'read' | 'write'): Promise<void> {
    const state = await this.state();
    if (allows(state, feature, mode)) return;
    if (state.license?.features.includes(feature)) {
      throw new ApiError(
        403,
        'license_expired',
        `The license expired; ${feature} has been read-only since ${state.readOnlyAt}. Install a renewed license.`,
      );
    }
    throw new ApiError(
      403,
      'license_required',
      `This needs a Business or Enterprise license that includes ${feature}.`,
    );
  }
}
