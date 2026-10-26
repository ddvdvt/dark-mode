// Source of truth for extension/_locales/*/messages.json. Run: node scripts/locales.src.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** key: [ru, en, kk] */
const M = {
  extName: ['Тёмный режим — быстрая тёмная тема для любых сайтов', 'Dark Mode — fast dark theme for any website', 'Түнгі режим — кез келген сайтқа жылдам қараңғы тақырып'],
  extShortName: ['Тёмный режим', 'Dark Mode', 'Түнгі режим'],
  extDescription: [
    'Тёмная тема на любом сайте без белой вспышки и тормозов. Два режима, яркость, расписание, список сайтов. Бесплатно.',
    'Dark theme for any website with no white flash and no lag. Two engines, brightness, schedule, per-site list. Free.',
    'Кез келген сайтқа ақ жарқылсыз әрі кідіріссіз қараңғы тақырып. Екі режим, жарықтық, кесте, сайттар тізімі. Тегін.',
  ],
  actionTitle: ['Тёмный режим', 'Dark Mode', 'Түнгі режим'],
  cmdToggleSite: ['Включить или выключить на текущем сайте', 'Turn on or off for the current site', 'Ағымдағы сайтта қосу не өшіру'],
  cmdToggleGlobal: ['Включить или выключить везде', 'Turn on or off everywhere', 'Барлық жерде қосу не өшіру'],
  globalSwitch: ['Включить или выключить везде', 'Turn on or off everywhere', 'Барлық жерде қосу не өшіру'],

  statusLoading: ['Проверяю страницу…', 'Checking the page…', 'Бет тексерілуде…'],
  statusOn: ['Тёмная тема включена · $1 режим.', 'Dark theme is on · $1 engine.', 'Қараңғы тақырып қосулы · $1 режим.'],
  statusForcedFilter: ['Страница очень большая, поэтому работает быстрый режим.', 'The page is very large, so the fast engine is used.', 'Бет өте үлкен, сондықтан жылдам режим қолданылады.'],
  statusAppliedIn: ['Применена за $1 мс.', 'Applied in $1 ms.', '$1 мс ішінде қолданылды.'],
  statusAlreadyDark: ['Сайт уже тёмный — оставили как есть.', 'This site is already dark, so it is left as is.', 'Сайт онсыз да қараңғы — өзгертілмеді.'],
  statusSiteOff: ['Выключено на этом сайте.', 'Turned off for this site.', 'Бұл сайтта өшірілген.'],
  statusGlobalOff: ['Расширение выключено на всех сайтах.', 'Turned off on all sites.', 'Барлық сайтта өшірілген.'],
  statusScheduleSystem: ['Сейчас выключено: в системе светлая тема.', 'Off right now: the system theme is light.', 'Қазір өшірулі: жүйеде ашық тақырып.'],
  statusScheduleTime: ['Сейчас выключено по расписанию (тёмная тема с $1 до $2).', 'Off right now by schedule (dark from $1 to $2).', 'Кесте бойынша қазір өшірулі (қараңғы тақырып $1 – $2).'],
  statusError: ['Не удалось применить тему на этой странице.', 'Could not apply the theme on this page.', 'Бұл бетте тақырыпты қолдану мүмкін болмады.'],
  noAccessHost: ['Страница недоступна', 'Page not available', 'Бет қолжетімсіз'],
  localFile: ['Локальные файлы', 'Local files', 'Жергілікті файлдар'],
  restricted: [
    'Здесь браузер не даёт расширениям менять страницу (служебные страницы, магазин расширений). Если это обычный сайт, открытый до установки, перезагрузите его.',
    'The browser does not let extensions change this page (browser pages, the extension store). If it is a regular site opened before installation, reload it.',
    'Браузер бұл бетті өзгертуге рұқсат бермейді (қызметтік беттер, кеңейтімдер дүкені). Егер бұл орнатудан бұрын ашылған кәдімгі сайт болса, оны қайта жүктеңіз.',
  ],
  reload: ['Перезагрузить страницу', 'Reload the page', 'Бетті қайта жүктеу'],
  siteTurnOff: ['Выключить на этом сайте', 'Turn off for this site', 'Бұл сайтта өшіру'],
  siteTurnOn: ['Включить на этом сайте', 'Turn on for this site', 'Бұл сайтта қосу'],
  siteForceOn: ['Всё равно затемнить', 'Darken anyway', 'Бәрібір қараңғылау'],
  siteEngine: ['Режим на этом сайте', 'Engine for this site', 'Бұл сайттағы режим'],
  engineDefault: ['Как везде', 'Default', 'Әдепкі'],
  engineDefaultNamed: ['Как везде ($1)', 'Default ($1)', 'Әдепкі ($1)'],
  engineDynamic: ['Умный', 'Smart', 'Ақылды'],
  engineFilter: ['Быстрый', 'Fast', 'Жылдам'],

  adjustTitle: ['Настройка темы', 'Adjust the theme', 'Тақырыпты баптау'],
  brightness: ['Яркость', 'Brightness', 'Жарықтық'],
  contrast: ['Контраст', 'Contrast', 'Контраст'],
  sepia: ['Сепия', 'Sepia', 'Сепия'],
  resetAdjust: ['Сбросить', 'Reset', 'Қалпына келтіру'],
  scheduleAlwaysShort: ['Тёмная тема: всегда', 'Dark theme: always', 'Қараңғы тақырып: әрқашан'],
  scheduleSystemShort: ['Тёмная тема: как в системе', 'Dark theme: follows the system', 'Қараңғы тақырып: жүйедегідей'],
  scheduleTimeShort: ['Тёмная тема: с $1 до $2', 'Dark theme: from $1 to $2', 'Қараңғы тақырып: $1 – $2'],
  change: ['изменить', 'change', 'өзгерту'],
  settings: ['Настройки', 'Settings', 'Баптаулар'],
  shortcutHint: ['$1 — вкл/выкл на сайте', '$1 toggles this site', '$1 — сайтта қосу/өшіру'],
  otherExtensions: ['Другие расширения автора', 'More extensions by the author', 'Автордың басқа кеңейтімдері'],

  optionsTitle: ['Тёмный режим — настройки', 'Dark Mode — settings', 'Түнгі режим — баптаулар'],
  optionsLead: [
    'Быстрая тёмная тема для любых сайтов. Бесплатно, без аккаунта, всё хранится только в вашем браузере.',
    'A fast dark theme for any website. Free, no account, everything stays in your browser.',
    'Кез келген сайтқа жылдам қараңғы тақырып. Тегін, тіркелусіз, бәрі тек сіздің браузеріңізде сақталады.',
  ],
  globalTitle: ['Тёмная тема на сайтах', 'Dark theme on websites', 'Сайттардағы қараңғы тақырып'],
  globalHint: ['Главный выключатель. Сайты из списка ниже настраиваются отдельно.', 'The main switch. Sites in the list below have their own settings.', 'Басты қосқыш. Төмендегі тізімдегі сайттар бөлек бапталады.'],
  engineTitle: ['Режим по умолчанию', 'Default engine', 'Әдепкі режим'],
  engineDynamicHint: [
    'Перекрашивает цвета самого сайта. Картинки и видео не трогает. Подходит большинству сайтов.',
    'Recolors the site’s own styles. Images and video stay untouched. Best for most sites.',
    'Сайттың өз түстерін қайта бояйды. Суреттер мен бейнеге тимейді. Көп сайтқа сәйкес келеді.',
  ],
  engineFilterHint: [
    'Инвертирует страницу одним CSS-фильтром, а картинки возвращает в исходные цвета. Почти нулевая нагрузка, хорош для тяжёлых страниц.',
    'Inverts the page with a single CSS filter and turns images back to their original colors. Almost zero load, great for heavy pages.',
    'Бетті бір CSS сүзгісімен инверттейді, суреттерді бастапқы түстеріне қайтарады. Жүктеме жоқтың қасы, ауыр беттерге жақсы.',
  ],
  detectDark: ['Не трогать сайты, которые уже тёмные', 'Leave sites that are already dark alone', 'Онсыз да қараңғы сайттарға тимеу'],
  scheduleTitle: ['Когда включать', 'When to turn on', 'Қашан қосу'],
  scheduleAlways: ['Всегда', 'Always', 'Әрқашан'],
  scheduleSystem: ['Как в системе (когда в Windows, macOS или Linux включена тёмная тема)', 'Follow the system (when Windows, macOS or Linux uses a dark theme)', 'Жүйедегідей (Windows, macOS не Linux-та қараңғы тақырып қосулы болса)'],
  scheduleTime: ['По времени', 'By time', 'Уақыт бойынша'],
  scheduleFrom: ['с', 'from', 'басы'],
  scheduleTo: ['до', 'to', 'соңы'],
  shortcutsTitle: ['Горячие клавиши', 'Keyboard shortcuts', 'Жылдам пернелер'],
  shortcutsEdit: ['Изменить сочетания', 'Change shortcuts', 'Пернелерді өзгерту'],
  shortcutNotSet: ['не назначено', 'not set', 'тағайындалмаған'],
  sitesTitle: ['Сайты', 'Sites', 'Сайттар'],
  sitesHint: [
    'Правило для example.com действует и на его поддомены. Включать и выключать сайты удобнее из окна расширения.',
    'A rule for example.com also covers its subdomains. It is easiest to switch sites from the extension popup.',
    'example.com ережесі оның ішкі домендеріне де қолданылады. Сайттарды кеңейтім терезесінен қосып-өшірген ыңғайлы.',
  ],
  sitesAddLabel: ['Адрес сайта', 'Site address', 'Сайт мекенжайы'],
  sitesAddPlaceholder: ['example.com', 'example.com', 'example.com'],
  sitesAdd: ['Добавить', 'Add', 'Қосу'],
  sitesAddInvalid: ['Введите адрес сайта, например example.com', 'Enter a site address, e.g. example.com', 'Сайт мекенжайын енгізіңіз, мысалы example.com'],
  modeDefault: ['Как везде', 'Default', 'Әдепкі'],
  modeOff: ['Не затемнять', 'Never darken', 'Қараңғыламау'],
  modeOn: ['Затемнять всегда', 'Always darken', 'Әрқашан қараңғылау'],
  colSite: ['Сайт', 'Site', 'Сайт'],
  colMode: ['Тёмная тема', 'Dark theme', 'Қараңғы тақырып'],
  colEngine: ['Режим', 'Engine', 'Режим'],
  colActions: ['Действия', 'Actions', 'Әрекеттер'],
  remove: ['Удалить', 'Remove', 'Жою'],
  sitesEmpty: ['Пока нет ни одного правила — тёмная тема работает на всех сайтах одинаково.', 'No rules yet: the dark theme works the same on every site.', 'Әзірге ереже жоқ — қараңғы тақырып барлық сайтта бірдей жұмыс істейді.'],
  sitesExport: ['Экспорт в JSON', 'Export to JSON', 'JSON-ға экспорттау'],
  sitesImport: ['Импорт из JSON', 'Import from JSON', 'JSON-нан импорттау'],
  sitesClear: ['Очистить список', 'Clear the list', 'Тізімді тазалау'],
  sitesClearConfirm: ['Удалить все правила для сайтов?', 'Remove all site rules?', 'Сайттарға арналған барлық ережені жою керек пе?'],
  sitesCleared: ['Список очищен.', 'The list is cleared.', 'Тізім тазаланды.'],
  exportDone: ['Сохранено правил: $1.', 'Saved $1 rules.', 'Сақталған ережелер: $1.'],
  importDone: ['Импорт: добавлено $1, обновлено $2, пропущено $3.', 'Import: $1 added, $2 updated, $3 skipped.', 'Импорт: қосылды $1, жаңартылды $2, өткізілді $3.'],
  importFailed: ['Файл не подходит: нужен JSON со списком сайтов.', 'This file does not fit: a JSON site list is expected.', 'Файл сәйкес емес: сайттар тізімі бар JSON қажет.'],
  aboutTitle: ['О расширении', 'About', 'Кеңейтім туралы'],
  aboutPrivacy: [
    'Расширение не делает сетевых запросов, не собирает статистику и не показывает рекламу. Настройки хранятся только в этом браузере.',
    'The extension makes no network requests, collects no statistics and shows no ads. Settings are stored only in this browser.',
    'Кеңейтім желіге сұрау жібермейді, статистика жинамайды және жарнама көрсетпейді. Баптаулар тек осы браузерде сақталады.',
  ],
  privacyLink: ['Политика конфиденциальности', 'Privacy policy', 'Құпиялылық саясаты'],
};

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension', '_locales');
['ru', 'en', 'kk'].forEach((lang, i) => {
  /** @type {Record<string, {message: string}>} */
  const out = {};
  for (const [k, v] of Object.entries(M)) out[k] = { message: v[i] };
  mkdirSync(join(root, lang), { recursive: true });
  writeFileSync(join(root, lang, 'messages.json'), JSON.stringify(out, null, 2) + '\n');
});
console.log('locales written:', Object.keys(M).length, 'keys');
