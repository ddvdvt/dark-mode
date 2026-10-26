// Popup: global switch, the current site (state, on/off, engine) and the brightness/contrast/sepia sliders.
import { t, applyI18n } from '../shared/i18n.js';
import { wireBrandLinks } from '../shared/brand-link.js';
import { S, loadSettings, updateSettings, onSettingsChange } from '../shared/storage.js';

const $ = (id) => /** @type {any} */ (document.getElementById(id));

/** Button text for each site action. */
const ACTION_LABEL = { turnOff: () => t('siteTurnOff'), turnOn: () => t('siteTurnOn'), forceOn: () => t('siteForceOn') };

/** @type {any} */
let settings = null;
/** @type {number | null} */
let tabId = null;
/** @type {any} last status from the page */
let status = null;
/**
 * Access to websites. Chrome grants the content-script hosts at install; in Firefox (MV3) the user
 * can withhold or revoke them, and then no content script runs anywhere.
 */
const ALL_SITES = { origins: ['<all_urls>'] };
let siteAccess = true;

async function activeTabId() {
  const fromUrl = Number(new URLSearchParams(location.search).get('tabId'));
  if (fromUrl) return fromUrl;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab && tab.id != null ? tab.id : null;
}

/** Ask the page's content script for its state; null when there is none (restricted page). */
async function queryStatus() {
  if (tabId == null) return null;
  for (let i = 0; i < 6; i++) {
    try {
      const r = await chrome.tabs.sendMessage(tabId, { type: 'nd:status' }, { frameId: 0 });
      if (r && r.state !== 'loading') return r;
    } catch {
      return null;
    }
    await new Promise((res) => setTimeout(res, 120));
  }
  return null;
}

function engineName(kind) {
  return kind === 'filter' ? t('engineFilter') : t('engineDynamic');
}

function scheduleText(s) {
  if (s.schedule.mode === 'system') return t('scheduleSystemShort');
  if (s.schedule.mode === 'time') return t('scheduleTimeShort', [s.schedule.from, s.schedule.to]);
  return t('scheduleAlwaysShort');
}

function renderSliders() {
  for (const k of ['brightness', 'contrast', 'sepia']) {
    $(k).value = String(settings[k]);
    $(k + 'Out').textContent = settings[k] + '%';
  }
}

function render() {
  if (!settings) return;
  const g = $('global');
  g.setAttribute('aria-checked', String(settings.enabled));
  document.body.classList.toggle('global-off', !settings.enabled);
  $('schedule').textContent = scheduleText(settings);
  renderSliders();

  const dot = $('dot');
  const toggle = $('siteToggle');
  dot.className = 'dot';
  if (!status) {
    $('host').textContent = t('noAccessHost');
    $('status').classList.add('hidden');
    $('siteActions').classList.add('hidden');
    $('engineRow').classList.add('hidden');
    $('restricted').classList.toggle('hidden', !siteAccess);
    $('access').classList.toggle('hidden', siteAccess);
    return;
  }
  $('restricted').classList.add('hidden');
  $('access').classList.add('hidden');
  $('status').classList.remove('hidden');
  $('host').textContent = status.host === 'file' ? t('localFile') : status.host || '—';
  const st = status.state;
  let text = '';
  let action = '';
  if (st === 'on') {
    dot.classList.add('on');
    text = t('statusOn', [engineName(status.engine)]);
    if (status.forcedFilter) text += ' ' + t('statusForcedFilter');
    if (status.appliedMs != null) text += ' ' + t('statusAppliedIn', [String(status.appliedMs)]);
    action = 'turnOff';
  } else if (st === 'already-dark') {
    dot.classList.add('dark');
    text = t('statusAlreadyDark');
    action = 'forceOn';
  } else if (st === 'site-off') {
    text = t('statusSiteOff');
    action = 'turnOn';
  } else if (st === 'global-off') {
    text = t('statusGlobalOff');
  } else if (st === 'schedule') {
    text = settings.schedule.mode === 'system' ? t('statusScheduleSystem') : t('statusScheduleTime', [settings.schedule.from, settings.schedule.to]);
  } else {
    text = t('statusError');
  }
  $('status').textContent = text;
  $('siteActions').classList.toggle('hidden', !action);
  if (action) {
    toggle.textContent = ACTION_LABEL[action]();
    toggle.classList.toggle('secondary', action === 'turnOff');
  }
  const showEngine = st === 'on' || st === 'site-off' || st === 'already-dark';
  $('engineRow').classList.toggle('hidden', !showEngine || status.host === '');
  const found = S.ruleFor(settings, status.host);
  $('siteEngine').value = (found && found.rule.engine) || '';
  $('siteEngine').options[0].textContent = t('engineDefaultNamed', [engineName(settings.engine)]);
}

async function refreshStatus() {
  siteAccess = await chrome.permissions.contains(ALL_SITES).catch(() => true);
  status = await queryStatus();
  render();
  document.body.dataset.ready = '1';
}

/** Re-read the page state shortly after a change (the page reacts to storage.onChanged). */
function refreshSoon() {
  setTimeout(refreshStatus, 150);
}

let saveTimer = 0;
function saveSlidersSoon() {
  clearTimeout(saveTimer);
  const patch = { brightness: Number($('brightness').value), contrast: Number($('contrast').value), sepia: Number($('sepia').value) };
  saveTimer = setTimeout(() => updateSettings((s) => ({ ...s, ...patch })), 120);
}

async function init() {
  applyI18n();
  wireBrandLinks();
  settings = await loadSettings();
  tabId = await activeTabId();
  render();

  $('global').addEventListener('click', async () => {
    settings = await updateSettings((s) => ({ ...s, enabled: !s.enabled }));
    render();
    refreshSoon();
  });
  $('siteToggle').addEventListener('click', async () => {
    if (!status) return;
    settings = await updateSettings((s) => S.toggleSite(s, status.host, status.state));
    refreshSoon();
  });
  $('siteEngine').addEventListener('change', async () => {
    if (!status) return;
    settings = await updateSettings((s) => S.setSiteEngine(s, status.host, $('siteEngine').value || null));
    refreshSoon();
  });
  for (const k of ['brightness', 'contrast', 'sepia']) {
    $(k).addEventListener('input', () => {
      $(k + 'Out').textContent = $(k).value + '%';
      saveSlidersSoon();
    });
  }
  $('resetAdjust').addEventListener('click', async () => {
    settings = await updateSettings((s) => ({ ...s, brightness: 100, contrast: 100, sepia: 0 }));
    render();
  });
  $('grantAccess').addEventListener('click', async () => {
    // called straight from the click: permissions.request needs the user gesture
    const granted = await chrome.permissions.request(ALL_SITES).catch(() => false);
    if (!granted) {
      $('accessMsg').textContent = t('accessDenied');
      return;
    }
    siteAccess = true;
    if (tabId != null) chrome.tabs.reload(tabId).then(() => window.close(), () => {});
  });
  $('reload').addEventListener('click', () => {
    if (tabId != null) chrome.tabs.reload(tabId).then(() => window.close(), () => {});
  });
  onSettingsChange((s) => {
    settings = s;
    render();
  });

  try {
    const cmds = await chrome.commands.getAll();
    const c = cmds.find((x) => x.name === 'toggle-site');
    if (c && c.shortcut) $('shortcut').textContent = t('shortcutHint', [c.shortcut]);
  } catch {
    /* ignore */
  }
  await refreshStatus();
}

init().catch(() => {
  document.body.dataset.ready = 'error';
});
