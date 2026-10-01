/* node test/captive-domain.js - the easy hotspot address (CAPTIVE_DOMAIN). */
const assert = require('assert');
const { captiveHostnames, isCaptiveHost, captiveDomainScript } = require('../src/lib/captive-domain');

let pass = 0;
function t(name, fn) { fn(); pass += 1; console.log(`  ok   ${name}`); }

console.log('Easy hotspot address');

t('the bare name and www. are both answered', () => {
  assert.deepStrictEqual(captiveHostnames('WiFiFiti.net.'), ['wififiti.net', 'www.wififiti.net']);
  assert.deepStrictEqual(captiveHostnames('www.wififiti.net'), ['wififiti.net', 'www.wififiti.net']);
  assert.ok(isCaptiveHost('www.wififiti.net', 'wififiti.net'));
  assert.ok(!isCaptiveHost('cloud.wififiti.co.ke', 'wififiti.net'));
  assert.ok(!isCaptiveHost('wififiti.net', ''));
});

t('off when no domain, and nothing unsafe becomes router code', () => {
  assert.strictEqual(captiveDomainScript(''), '');
  assert.strictEqual(captiveDomainScript('wififiti.net"; /system reset; :put "'), '');
  assert.strictEqual(captiveDomainScript('wifi fiti.net'), '');
  assert.strictEqual(captiveDomainScript('localhost'), '');
});

t('the router block adds local DNS and a status redirect, and leaves dns-name alone', () => {
  const script = captiveDomainScript('wififiti.net');
  assert.match(script, /:local fitiCdName "wififiti\.net\|v\d+"/);
  assert.match(script, /:if \(\$fitiCdAddr = "0\.0\.0\.0"\) do=\{ :set fitiCdAddr "" \}/);
  assert.match(script, /in=\{"wififiti\.net";"www\.wififiti\.net"\}/);
  assert.match(script, /\/ip dns static add name=\$fitiCdN address=\$fitiCdAddr/);
  assert.match(script, /router-login\?page=status/);
  assert.match(script, /dst-path=\(\$fitiCdDir \. "\/status\.html"\)/);
  assert.match(script, /:if \(\$fitiCaptiveApplied != \$fitiCdName\)/);
  assert.ok(!/dns-name/.test(script), 'the HotSpot dns-name alias stays cleared');
  assert.ok(!/allow-remote-requests/.test(script), 'the router DNS service is not opened');
});

console.log(`\n${pass} passed`);
