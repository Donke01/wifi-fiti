/**
 * The tariff. This is the only file you edit to change what you sell.
 *
 * `profile` must match a /ip hotspot user profile name in RouterOS.
 * That profile enforces speed and how many devices may be online at once;
 * this file only decides price and duration.
 */

const PACKAGES = [
  {
    id: 'hr1',
    name: '1 hour',
    detail: 'Quick browse or a download',
    price: 10,
    seconds: 3600,
    profile: 'standard',
  },
  {
    id: 'hr3',
    name: '3 hours',
    detail: 'A lecture or a movie',
    price: 20,
    seconds: 3 * 3600,
    profile: 'standard',
  },
  {
    id: 'day1',
    name: '24 hours',
    detail: 'Full day',
    price: 50,
    seconds: 24 * 3600,
    profile: 'standard',
  },
  {
    id: 'day3',
    name: '3 days',
    detail: 'Weekend sorted',
    price: 120,
    seconds: 3 * 24 * 3600,
    profile: 'standard',
  },
  {
    id: 'wk1',
    name: '1 week',
    detail: 'Best value per day',
    price: 400,
    seconds: 7 * 24 * 3600,
    profile: 'standard',
  },
];

/**
 * Two devices per purchase, the paying phone included. So the devices
 * table holds at most one extra: phone + TV, or phone + laptop.
 * Each device gets a separate MAC-bound router identity with shared-users=1.
 */
const DEVICES_PER_ACCOUNT = 2;
const EXTRA_DEVICES_ALLOWED = DEVICES_PER_ACCOUNT - 1;

function findPackage(id) {
  return PACKAGES.find((p) => p.id === id) || null;
}

module.exports = {
  PACKAGES,
  findPackage,
  DEVICES_PER_ACCOUNT,
  EXTRA_DEVICES_ALLOWED,
};
