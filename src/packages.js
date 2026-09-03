/**
 * The tariff. This is the only file you edit to change what you sell.
 *
 * `profile` must match a /ip/hotspot/user/profile name in RouterOS.
 * The profile is what enforces speed and simultaneous-device limits;
 * this file only decides price and duration.
 */

const PACKAGES = [
  {
    id: 'hr3',
    name: '3 hours',
    detail: 'Lecture moja au movie',
    price: 20,
    seconds: 3 * 3600,
    profile: 'standard',
  },
  {
    id: 'day1',
    name: '24 hours',
    detail: 'Siku nzima',
    price: 50,
    seconds: 24 * 3600,
    profile: 'standard',
  },
  {
    id: 'day3',
    name: '3 days',
    detail: 'Weekend imesortiwa',
    price: 120,
    seconds: 3 * 24 * 3600,
    profile: 'standard',
  },
  {
    id: 'wk1',
    name: '1 week',
    detail: 'Bei poa zaidi kwa siku',
    price: 250,
    seconds: 7 * 24 * 3600,
    profile: 'standard',
  },
];

function findPackage(id) {
  return PACKAGES.find((p) => p.id === id) || null;
}

/** RouterOS wants durations as e.g. "3h", "1d 12:00:00". Seconds are accepted
 *  and unambiguous, so we use those. */
function toRouterOsUptime(seconds) {
  return `${Math.round(seconds)}s`;
}

module.exports = { PACKAGES, findPackage, toRouterOsUptime };
