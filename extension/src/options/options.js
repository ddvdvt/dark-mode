// Options page: default engine, sliders, schedule, shortcuts, per-site list with JSON export/import.
import { t, applyI18n } from '../shared/i18n.js';
import { wireBrandLinks } from '../shared/brand-link.js';
import { S, loadSettings, updateSettings, onSettingsChange, downloadText } from '../shared/storage.js';

const $ = (id) => /** @type {any} */ (document.getElementById(id));

/** @type {any} */
let settings = null;

function engineLabel(e) {
  return e === 'filter' ? t('engineFilter') : t('engineDynamic');
}

function renderGeneral() {
  $('enabled').setAttribute('aria-checked', String(settings.enabled));
  for (const r of document.querySelectorAll('input[name="engine"]')) r.checked = r.value === settings.engine;
  $('detectDark').checked = settings.detectDark;
  for (const k of ['brightness', 'contrast', 'sepia']) {
    $(k).value = String(settings[k]);
    $(k + 'Out').textContent = settings[k] + '%';
  }
  for (const r of document.querySelectorAll('input[name="schedule"]')) r.checked = r.value === settings.schedule.mode;
  if (document.activeElement !== $('from')) $('from').value = settings.schedule.from;
  if (document.activeElement !== $('to')) $('to').value = settings.schedule.to;
  const timed = settings.schedule.mode === 'time';
  $('times').setAttribute('aria-disabled', String(!timed));
  $('from').disabled = $('to').disabled = !timed;
}

/** @param {string} value @param {Array<[string, string]>} options */
function select(value, options, label) {
  const el = document.createElement('select');
  el.setAttribute('aria-label', label);
  for (const [v, text] of options) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = text;
    el.appendChild(o);
  }
  el.value = value;
  return el;
}

function renderSites() {
  const tbody = $('sites');
  tbody.textContent = '';
  const keys = Object.keys(settings.sites).sort();
  $('sitesTable').classList.toggle('hidden', !keys.length);
  $('sitesEmpty').classList.toggle('hidden', !!keys.length);
  for (const host of keys) {
    const rule = settings.sites[host];
    const tr = document.createElement('tr');
    const name = document.createElement('td');
    name.textContent = host === 'file' ? t('localFile') : host;
    const modeTd = document.createElement('td');
    const mode = select(rule.mode || '', [['', t('modeDefault')], ['off', t('modeOff')], ['on', t('modeOn')]], `${t('colMode')}: ${host}`);
    mode.addEventListener('change', () => save((s) => setRule(s, host, { ...s.sites[host], mode: mode.value || undefined })));
    modeTd.appendChild(mode);
    const engTd = document.createElement('td');
    const eng = select(rule.engine || '', [['', t('engineDefaultNamed', [engineLabel(settings.engine)])], ['dynamic', t('engineDynamic')], ['filter', t('engineFilter')]], `${t('colEngine')}: ${host}`);
    eng.addEventListener('change', () => save((s) => S.setSiteEngine(s, host, eng.value || null)));
    engTd.appendChild(eng);
    const del = document.createElement('td');
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn small';
    b.textContent = t('remove');
    b.setAttribute('aria-label', `${t('remove')}: ${host}`);
    b.addEventListener('click', () => save((s) => setRule(s, host, null)));
    del.appendChild(b);
    tr.append(name, modeTd, engTd, del);
    tbody.appendChild(tr);
  }
}

/** @param {any} s @param {string} host @param {any} rule */
function setRule(s, host, rule) {
  const sites = { ...s.sites };
  if (rule && (rule.mode || rule.engine)) {
    const clean = {};
    if (rule.mode) clean.mode = rule.mode;
    if (rule.engine) clean.engine = rule.engine;
    sites[host] = clean;
  } else delete sites[host];
  return { ...s, sites };
}

function render() {
  renderGeneral();
  // the site table is rebuilt: keep keyboard focus on the same control
  const active = document.activeElement;
  const label = active && $('sites').contains(active) ? active.getAttribute('aria-label') : null;
  renderSites();
  if (label) {
    const again = [...$('sites').querySelectorAll('[aria-label]')].find((el) => el.getAttribute('aria-label') === label);
    (again || $('addHost')).focus();
  }
}

/** @param {(s: any) => any} fn */
async function save(fn) {
  settings = await updateSettings(fn);
  render();
}

async function renderShortcuts() {
  const list = $('shortcuts');
  list.textContent = '';
  let cmds = [];
  try {
    cmds = await chrome.commands.getAll();
  } catch {
    /* ignore */
  }
  for (const name of ['toggle-site', 'toggle-global']) {
    const c = cmds.find((x) => x.name === name);
    const li = document.createElement('li');
    const what = t(name === 'toggle-site' ? 'cmdToggleSite' : 'cmdToggleGlobal');
    if (c && c.shortcut) {
      const k = document.createElement('kbd');
      k.textContent = c.shortcut;
      li.append(k, ' — ' + what);
    } else li.textContent = `${t('shortcutNotSet')} — ${what}`;
    list.appendChild(li);
  }
}

function message(text, isError = false) {
  const m = $('ioMsg');
  m.textContent = text;
  m.classList.toggle('error', isError);
}

async function init() {
  applyI18n();
  wireBrandLinks();
  $('version').textContent = 'v' + chrome.runtime.getManifest().version;
  settings = await loadSettings();
  render();
  renderShortcuts();

  $('enabled').addEventListener('click', () => save((s) => ({ ...s, enabled: !s.enabled })));
  for (const r of document.querySelectorAll('input[name="engine"]')) r.addEventListener('change', () => save((s) => ({ ...s, engine: r.value })));
  $('detectDark').addEventListener('change', () => save((s) => ({ ...s, detectDark: $('detectDark').checked })));
  let timer = 0;
  for (const k of ['brightness', 'contrast', 'sepia']) {
    $(k).addEventListener('input', () => {
      $(k + 'Out').textContent = $(k).value + '%';
      clearTimeout(timer);
      const v = Number($(k).value);
      timer = setTimeout(() => save((s) => ({ ...s, [k]: v })), 120);
    });
  }
  $('resetAdjust').addEventListener('click', () => save((s) => ({ ...s, brightness: 100, contrast: 100, sepia: 0 })));
  for (const r of document.querySelectorAll('input[name="schedule"]')) r.addEventListener('change', () => save((s) => ({ ...s, schedule: { ...s.schedule, mode: r.value } })));
  for (const id of ['from', 'to']) {
    $(id).addEventListener('change', () => {
      if (S.parseTime($(id).value) == null) return;
      save((s) => ({ ...s, schedule: { ...s.schedule, [id]: $(id).value } }));
    });
  }
  $('editShortcuts').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));

  $('addForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const host = S.siteKey($('addHost').value);
    const err = $('addError');
    if (!host) {
      err.textContent = t('sitesAddInvalid');
      err.classList.remove('hidden');
      $('addHost').focus();
      return;
    }
    err.classList.add('hidden');
    const mode = $('addMode').value;
    save((s) => setRule(s, host, { ...(s.sites[host] || {}), mode })).then(() => {
      $('addHost').value = '';
    });
  });

  $('export').addEventListener('click', () => {
    const date = new Date().toISOString().slice(0, 10);
    downloadText(S.exportSites(settings), `dark-mode-sites-${date}.json`);
    message(t('exportDone', [String(Object.keys(settings.sites).length)]));
  });
  $('importFile').addEventListener('change', async () => {
    const file = $('importFile').files[0];
    $('importFile').value = '';
    if (!file) return;
    try {
      if (file.size > 2_000_000) throw new Error('too-big');
      const text = await file.text();
      let result = null;
      await save((s) => {
        result = S.importSites(s, text);
        return result.settings;
      });
      message(t('importDone', [String(result.added), String(result.updated), String(result.skipped)]));
    } catch {
      message(t('importFailed'), true);
    }
  });
  $('clearSites').addEventListener('click', () => {
    if (!Object.keys(settings.sites).length) return;
    if (!confirm(t('sitesClearConfirm'))) return;
    save((s) => ({ ...s, sites: {} })).then(() => message(t('sitesCleared')));
  });

  onSettingsChange((s) => {
    settings = s;
    render();
  });
  document.body.dataset.ready = '1';
}

init();
