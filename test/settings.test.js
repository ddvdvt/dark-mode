import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Lib } from './helpers.js';

const S = Lib.settings;
const env = (minutes = 720, systemDark = false) => ({ minutes, systemDark });

test('defaults and validation', () => {
  const d = S.defaults();
  assert.deepEqual(S.ensureSettings(undefined), d);
  assert.deepEqual(S.ensureSettings('junk'), d);
  const s = S.ensureSettings({
    enabled: false,
    engine: 'filter',
    brightness: 500,
    contrast: '80',
    sepia: -3,
    schedule: { mode: 'time', from: '25:00', to: '06:30' },
    detectDark: 'yes',
    sites: { 'WWW.Example.com': { mode: 'off', engine: 'filter', extra: 1 }, 'bad host!': { mode: 'off' }, 'a.org': { mode: 'maybe' } },
  });
  assert.equal(s.enabled, false);
  assert.equal(s.engine, 'filter');
  assert.equal(s.brightness, 150);
  assert.equal(s.contrast, 80);
  assert.equal(s.sepia, 0);
  assert.deepEqual(s.schedule, { mode: 'time', from: '20:00', to: '06:30' });
  assert.equal(s.detectDark, true);
  assert.deepEqual(s.sites, { 'example.com': { mode: 'off', engine: 'filter' } });
});

test('siteKey normalises urls and hosts', () => {
  assert.equal(S.siteKey('https://www.Example.com/path?q=1'), 'example.com');
  assert.equal(S.siteKey('mail.example.com'), 'mail.example.com');
  assert.equal(S.siteKey('http://127.0.0.1:8080/x'), '127.0.0.1');
  assert.equal(S.siteKey('пример.рф'), 'xn--e1afmkfd.xn--p1ai');
  assert.equal(S.siteKey('file:///C:/a.html'), 'file');
  assert.equal(S.siteKey('chrome://settings'), '');
  assert.equal(S.siteKey(''), '');
  assert.equal(S.siteKey('not a host'), '');
});

test('ruleFor falls back to parent domains but never to a TLD', () => {
  const s = S.ensureSettings({ sites: { 'example.com': { mode: 'off' }, 'docs.example.com': { mode: 'on' }, com: { mode: 'off' } } });
  assert.equal(S.ruleFor(s, 'mail.example.com').key, 'example.com');
  assert.equal(S.ruleFor(s, 'docs.example.com').rule.mode, 'on');
  assert.equal(S.ruleFor(s, 'www.example.com').key, 'example.com');
  assert.equal(S.ruleFor(s, 'other.com'), null);
});

test('schedule', () => {
  const night = { mode: 'time', from: '20:00', to: '07:00' };
  assert.equal(S.scheduleActive(night, 21 * 60, false), true);
  assert.equal(S.scheduleActive(night, 6 * 60 + 59, false), true);
  assert.equal(S.scheduleActive(night, 7 * 60, false), false);
  assert.equal(S.scheduleActive(night, 12 * 60, false), false);
  const day = { mode: 'time', from: '09:00', to: '18:00' };
  assert.equal(S.scheduleActive(day, 9 * 60, false), true);
  assert.equal(S.scheduleActive(day, 18 * 60, false), false);
  assert.equal(S.scheduleActive({ mode: 'time', from: '10:00', to: '10:00' }, 0, false), true);
  assert.equal(S.scheduleActive({ mode: 'system', from: '', to: '' }, 0, true), true);
  assert.equal(S.scheduleActive({ mode: 'system', from: '', to: '' }, 0, false), false);
  assert.equal(S.scheduleActive({ mode: 'always', from: '', to: '' }, 0, false), true);
});

test('msUntilScheduleChange points at the next boundary', () => {
  const night = { mode: 'time', from: '20:00', to: '07:00' };
  assert.equal(S.msUntilScheduleChange(night, new Date(2026, 0, 1, 19, 59, 30)), 30000);
  assert.equal(S.msUntilScheduleChange(night, new Date(2026, 0, 1, 20, 0, 0)), 11 * 3600000);
  assert.equal(S.msUntilScheduleChange(night, new Date(2026, 0, 1, 23, 0, 0)), 8 * 3600000);
  assert.equal(S.msUntilScheduleChange({ mode: 'always', from: '20:00', to: '07:00' }, new Date()), null);
});

test('decide', () => {
  let s = S.defaults();
  assert.deepEqual(S.decide(s, 'example.com', env()), { engine: 'dynamic', force: false, on: true, reason: 'on' });
  assert.equal(S.decide({ ...s, enabled: false }, 'example.com', env()).reason, 'global-off');
  s = S.ensureSettings({ sites: { 'example.com': { mode: 'off' }, 'dark.org': { mode: 'on', engine: 'filter' } } });
  assert.equal(S.decide(s, 'www.example.com', env()).reason, 'site-off');
  assert.deepEqual(S.decide(s, 'dark.org', env()), { engine: 'filter', force: true, on: true, reason: 'on' });
  s = S.ensureSettings({ schedule: { mode: 'time', from: '20:00', to: '07:00' } });
  assert.equal(S.decide(s, 'a.com', env(12 * 60)).reason, 'schedule');
  assert.equal(S.decide(s, 'a.com', env(22 * 60)).on, true);
  assert.equal(S.decide({ ...S.defaults(), detectDark: false }, 'a.com', env()).force, true);
});

test('toggleSite', () => {
  let s = S.defaults();
  s = S.toggleSite(s, 'https://www.example.com/', 'on');
  assert.deepEqual(s.sites, { 'example.com': { mode: 'off' } });
  s = S.toggleSite(s, 'example.com', 'site-off');
  assert.deepEqual(s.sites, {}, 'back to default, no clutter');
  s = S.toggleSite(s, 'night.app', 'already-dark');
  assert.deepEqual(s.sites, { 'night.app': { mode: 'on' } });
  // a parent domain is off: turning the subdomain on needs an explicit "on"
  s = S.ensureSettings({ sites: { 'example.com': { mode: 'off', engine: 'filter' } } });
  s = S.toggleSite(s, 'docs.example.com', 'site-off');
  assert.deepEqual(s.sites['docs.example.com'], { mode: 'on' });
  assert.equal(S.toggleSite(s, 'chrome://newtab', 'on'), s);
});

test('setSiteEngine keeps the mode and cleans empty rules', () => {
  let s = S.ensureSettings({ sites: { 'a.com': { mode: 'off' } } });
  s = S.setSiteEngine(s, 'a.com', 'filter');
  assert.deepEqual(s.sites['a.com'], { mode: 'off', engine: 'filter' });
  s = S.setSiteEngine(s, 'b.com', 'dynamic');
  s = S.setSiteEngine(s, 'b.com', null);
  assert.equal(s.sites['b.com'], undefined);
});

test('filter chain', () => {
  const s = S.defaults();
  assert.equal(S.filterCss(S.filterChain(s)), 'invert(1) hue-rotate(180deg)');
  assert.equal(S.filterCss(S.filterChain({ ...s, brightness: 90, contrast: 110, sepia: 15 })), 'invert(1) hue-rotate(180deg) brightness(0.9) contrast(1.1) sepia(0.15)');
  assert.deepEqual(S.filterChain(s, false), []);
});

test('export / import of the site list', () => {
  const s = S.ensureSettings({ sites: { 'b.com': { mode: 'off' }, 'a.com': { engine: 'filter' } } });
  const json = S.exportSites(s, new Date('2026-10-26T10:00:00Z'));
  const data = JSON.parse(json);
  assert.equal(data.app, 'dark-mode');
  assert.deepEqual(Object.keys(data.sites), ['a.com', 'b.com']);
  const r = S.importSites(S.ensureSettings({ sites: { 'a.com': { mode: 'off' }, 'c.com': { mode: 'on' } } }), json);
  assert.deepEqual(r.settings.sites, { 'a.com': { engine: 'filter' }, 'b.com': { mode: 'off' }, 'c.com': { mode: 'on' } });
  assert.deepEqual([r.added, r.updated, r.skipped], [1, 1, 0]);
  const bare = S.importSites(S.defaults(), JSON.stringify({ 'https://www.x.org/': { mode: 'off' }, 'bad host': { mode: 'off' }, 'y.org': { mode: 'nope' } }));
  assert.deepEqual(bare.settings.sites, { 'x.org': { mode: 'off' } });
  assert.equal(bare.skipped, 2);
  assert.throws(() => S.importSites(S.defaults(), '{oops'), /bad-json/);
  assert.throws(() => S.importSites(S.defaults(), '[1,2]'), /bad-format/);
  assert.throws(() => S.importSites(S.defaults(), JSON.stringify({ app: 'other', sites: {} })), /bad-format/);
});
