'use strict';

/**
 * Checks that the join address picked for the QR code is the one phones can
 * actually reach, across the device layouts this app gets run on.
 * Run with `npm run test:network`.
 */

const { lanAddresses } = require('../server/network');

const v4 = (address, internal = false) => ({ address, family: 'IPv4', internal });

const cases = [
  {
    name: 'MacBook joined to a phone hotspot',
    nets: {
      lo0: [v4('127.0.0.1', true)],
      en0: [v4('192.168.43.55')],
      awdl0: [v4('169.254.12.3')],
    },
    expect: '192.168.43.55',
  },
  {
    name: 'Android tablet joined to a hotspot, mobile data also on',
    nets: {
      lo: [v4('127.0.0.1', true)],
      rmnet_data0: [v4('10.148.22.7')], // carrier IP, unreachable by players
      wlan0: [v4('192.168.43.120')],
    },
    expect: '192.168.43.120',
  },
  {
    name: 'Samsung tablet acting as the hotspot itself',
    nets: {
      lo: [v4('127.0.0.1', true)],
      rmnet_data0: [v4('10.148.22.7')],
      swlan0: [v4('192.168.43.1')],
    },
    expect: '192.168.43.1',
  },
  {
    name: 'Stock Android acting as the hotspot',
    nets: {
      lo: [v4('127.0.0.1', true)],
      ap0: [v4('192.168.43.1')],
      rmnet_data1: [v4('100.94.3.11')],
    },
    expect: '192.168.43.1',
  },
  {
    name: 'Mobile data only, no LAN at all (nothing better to offer)',
    nets: {
      lo: [v4('127.0.0.1', true)],
      rmnet_data0: [v4('10.148.22.7')],
    },
    expect: '10.148.22.7',
  },
  {
    name: 'MacBook on office Wi-Fi with a VPN tunnel up',
    nets: {
      lo0: [v4('127.0.0.1', true)],
      utun3: [v4('10.8.0.6')],
      en0: [v4('192.168.1.24')],
    },
    expect: '192.168.1.24',
  },
];

let failed = 0;
console.log('\nJoin-address selection\n');

for (const testCase of cases) {
  const [best] = lanAddresses(testCase.nets);
  const got = best ? best.address : '(none)';
  const pass = got === testCase.expect;
  if (!pass) failed += 1;
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${testCase.name}`);
  if (!pass) console.log(`        expected ${testCase.expect}, got ${got}`);
}

// The override must win regardless of what the interfaces say.
process.env.HOST_IP = '192.168.99.99';
delete require.cache[require.resolve('../server/network')];
const { primaryLanAddress } = require('../server/network');
const overridden = primaryLanAddress();
const overrideOk = overridden === '192.168.99.99';
if (!overrideOk) failed += 1;
console.log(`  ${overrideOk ? 'PASS' : 'FAIL'}  HOST_IP override wins (${overridden})`);

console.log(`\n  ${cases.length + 1 - failed}/${cases.length + 1} checks passed\n`);
process.exit(failed ? 1 : 0);
