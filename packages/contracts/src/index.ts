/**
 * @ca/contracts — versioned schemas, entity types, event contracts and API types.
 *
 * Browser-safe by design: no Node.js built-ins may be imported here.
 */
export * from './primitives';
export * from './states';
export * from './refs';
export * from './content';
export * from './patch';
export * from './diff';
export * from './validation';
export * from './budget';
export * from './model';
export * from './tools';
export * from './plan';
export * from './entities';
export * from './events';
export * from './recipes';
export * from './resolution';
export * from './projection';
export * from './api';

export const CONTRACTS_PACKAGE_VERSION = '0.1.0';
