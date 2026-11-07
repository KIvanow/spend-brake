// The bundle sets this from package.json (scripts/bundle.mjs); running from source says so.
declare const __BRAKE_VERSION__: string | undefined;
export const VERSION = typeof __BRAKE_VERSION__ === 'string' ? __BRAKE_VERSION__ : '0.0.0-dev';
