/* xlamBOT — страница настроек.

   Написано с нуля под API этого же сервера. Никаких сборщиков и библиотек:
   обычный JavaScript, который обращается к маршрутам /api/devices и /api.

   Разделы: обзор, очередь, плейстайлы, настройки, история, логи. Данные
   обновляются по своему таймеру у каждого раздела, а не одним общим опросом
   всего подряд - иначе страница дёргала бы сервер двадцать раз в минуту ради
   вкладки, которую никто не открыл. */

(function () {
    'use strict';

    const TOKEN = document.querySelector('meta[name="xlam-ui-token"]')?.content || '';

    // ───────────────────────── утилиты ─────────────────────────

    function esc(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    async function api(path, options) {
        const opts = Object.assign({ headers: {} }, options || {});
        opts.headers = Object.assign({ 'X-Xlam-UI-Token': TOKEN }, opts.headers);
        if (opts.body && typeof opts.body !== 'string') {
            opts.headers['Content-Type'] = 'application/json';
            opts.body = JSON.stringify(opts.body);
        }
        const response = await window.XlamSession.fetch(path, opts);
        let data = {};
        try { data = await response.json(); } catch (error) { data = {}; }
        if (!response.ok) {
            throw new Error(data.message || data.error || `Запрос ${path} не удался`);
        }
        return data;
    }

    let toastTimer = null;
    function toast(message, kind) {
        const box = document.getElementById('toast');
        box.textContent = message;
        box.className = 'toast' + (kind ? ' is-' + kind : '');
        box.classList.remove('hidden');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => box.classList.add('hidden'), 3600);
    }

    function plural(n, one, few, many) {
        const abs = Math.abs(n) % 100;
        const tail = abs % 10;
        if (abs > 10 && abs < 20) return many;
        if (tail > 1 && tail < 5) return few;
        if (tail === 1) return one;
        return many;
    }

    function uptime(seconds) {
        if (seconds == null) return '—';
        const total = Math.floor(seconds);
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        if (h) return `${h} ч ${m} мин`;
        if (m) return `${m} мин`;
        return `${total} с`;
    }

    function sign(value) {
        if (value == null) return '';
        return value > 0 ? `+${value}` : String(value);
    }

    const view = (name) => document.getElementById('view-' + name);

    // ───────────────────────── вкладки ─────────────────────────

    const pollers = {};
    const loaders = {
        dashboard: loadDashboard,
        brawlers: loadBrawlersTab,
        playstyles: loadPlaystyles,
        settings: loadSettings,
        history: loadHistory,
        logs: loadLogs,
    };
    let activeTab = 'dashboard';

    // Какое устройство сейчас редактируется. Объявлено здесь, а не рядом с
    // настройками: вкладка выбора бойца читает его раньше, чем доходит до
    // того места, и получал "cannot access before initialization".
    let settingsKey = '';

    function showTab(name) {
        if (!loaders[name]) return;
        activeTab = name;
        document.querySelectorAll('.studio-tab').forEach((button) => {
            button.classList.toggle('is-active', button.dataset.tab === name);
        });
        // Секции перебираем по разметке, а не по таблице в коде: прежний
        // список был пустым, из-за чего вкладка наполнялась содержимым, но
        // оставалась скрытой - .studio-view без .is-active имеет display: none.
        document.querySelectorAll('.studio-view').forEach((el) => {
            el.classList.toggle('is-active', el.id === 'view-' + name);
        });
        // Перезапускаем таймер: у закрытой вкладки опроса быть не должно.
        Object.keys(pollers).forEach((key) => {
            clearInterval(pollers[key]);
            delete pollers[key];
        });
        loaders[name]();
        if (name !== 'settings') pollers[name] = setInterval(loaders[name], name === 'dashboard' ? 2500 : 6000);
    }

    document.getElementById('tabs').addEventListener('click', (event) => {
        const button = event.target.closest('.studio-tab');
        if (button) showTab(button.dataset.tab);
    });

    // ───────────────────────── обзор ─────────────────────────

    async function loadDashboard() {
        const devicesData = await api('/api/devices');
        const devices = devicesData.devices || [];
        // Ростер подставляется ниже, из маршрута устройства: глобальный
        // /api/queue в обычной работе одного устройства пуст.
        let queue = [];
        const running = devices.filter((d) => d.brawl_stars_running).length;

        const rows = [];
        for (const device of devices) {
            // Считаем ростер устройства, а не глобальный список: последний в
            // обычном случае пуст, и сводка показывала ноль при полном списке.
            const [telemetry, roster] = await Promise.all([
                api(`/api/devices/${encodeURIComponent(device.key)}/telemetry`).catch(() => null),
                api(`/api/devices/${encodeURIComponent(device.key)}/queue`).catch(() => null),
            ]);
            if (!queue.length && roster) queue = roster.items || [];
            rows.push({ device, t: telemetry?.telemetry || {} });
        }

        // Итоги считаем после сбора очереди: раньше сумма бралась с пустого
        // массива и «Трофеев в ростере» показывало ноль при полном списке.
        const totals = queue.reduce((acc, entry) => {
            acc.trophies += Number(entry.trophies) || 0;
            acc.wins += Number(entry.wins) || 0;
            return acc;
        }, { trophies: 0, wins: 0 });
        const auto = queue.filter((entry) => entry.automatically_pick).length;

        view('dashboard').innerHTML = `
            <div class="kpi-grid" style="margin-bottom:12px">
                <div class="kpi">
                    <div class="kpi-label">Устройств</div>
                    <div class="kpi-value">${devices.length}</div>
                    <div class="kpi-note">${running} с запущенной игрой</div>
                </div>
                <div class="kpi">
                    <div class="kpi-label">В очереди</div>
                    <div class="kpi-value">${queue.length}</div>
                    <div class="kpi-note">${auto} на автовыборе</div>
                </div>
                <div class="kpi">
                    <div class="kpi-label">Трофеев в ростере</div>
                    <div class="kpi-value">${totals.trophies.toLocaleString(window.XlamI18n?.locale||'ru-RU')}</div>
                    <div class="kpi-note">${totals.wins} побед всего</div>
                </div>
                <div class="kpi">
                    <div class="kpi-label">Ботов в работе</div>
                    <div class="kpi-value">${rows.filter((r) => r.t.state === 'running').length}</div>
                    <div class="kpi-note">по панели бота</div>
                </div>
            </div>

            <div class="card">
                <div class="card-head">
                    <div>
                        <h3 class="card-title">Устройства</h3>
                        <p class="card-note">Состояние видно с панели бота — там же запуск и остановка</p>
                    </div>
                    <div class="card-actions">
                        <a class="btn btn-ghost" href="/panel">Открыть панель бота</a>
                    </div>
                </div>
                <div class="card-body is-tight">
                    <table class="table">
                        <thead><tr>
                            <th>Устройство</th><th>Игра</th>
                            <th class="num">Боец</th><th class="num">Ротация</th>
                            <th class="num">Трофеи</th><th class="num">В работе</th><th>Состояние</th>
                        </tr></thead>
                        <tbody>
                        ${rows.length ? rows.map((row) => {
                            const t = row.t;
                            const state = t.state || 'idle';
                            const tagClass = state === 'running' ? 'is-up'
                                : state === 'error' ? 'is-down'
                                : state === 'paused' ? 'is-warn' : '';
                            return `<tr>
                                <td>
                                    <strong>${esc(row.device.display_name || row.device.model || row.device.serial)}</strong>
                                    <div class="muted mono" style="font-size:10px">${esc(row.device.serial)}</div>
                                </td>
                                <td>${row.device.brawl_stars_running ? 'запущена' : '<span class="muted">нет</span>'}</td>
                                <td class="num">${esc(t.brawler || '—')}</td>
                                <td class="num">${t.games_on_brawler != null && t.switch_after_games != null
                                    ? `${t.games_on_brawler}/${t.switch_after_games}` : '—'}</td>
                                <td class="num">${t.account_total != null ? t.account_total : '—'}</td>
                                <td class="num">${uptime(t.uptime_seconds)}</td>
                                <td><span class="tag ${tagClass}">${esc(state)}</span></td>
                            </tr>`;
                        }).join('') : `<tr><td colspan="7" class="empty">Устройства не найдены</td></tr>`}
                        </tbody>
                    </table>
                </div>
            </div>`;
    }

    // ───────────────────────── выбор бойца ─────────────────────────

    // Вкладка про бойца вместо прежней очереди. Очереди больше нет: бот играет
    // на одном выбранном бойце либо выбирает сам, и список с порядком, целями и
    // счётчиками только путал: он показывал план, которого бот не выполнял.

    async function loadBrawlersTab() {
        const [devices, catalog] = await Promise.all([
            api('/api/devices'),
            api('/api/devices/brawlers'),
        ]);
        const list = devices.devices || [];
        const target = settingsKey || (list[0] && list[0].key) || '';
        const brawlers = catalog.brawlers || [];
        if (!target) {
            view('brawlers').innerHTML = '<div class="empty">Устройство не подключено</div>';
            return;
        }
        const chosen = await api(`/api/devices/${encodeURIComponent(target)}/brawler`);
        const locked = String(chosen.locked_brawlers || chosen.locked_brawler || '');
        const deviceOptions = list.map((d) => `
            <option value="${esc(d.key)}" ${d.key === target ? 'selected' : ''}>
                ${esc(d.display_name || d.model || d.serial || d.key)} · ${esc(d.serial || d.key)}
            </option>`).join('');

        view('brawlers').innerHTML = `
            <div class="card">
                <div class="card-head">
                    <div>
                        <h3 class="card-title">Боец</h3>
                        <p class="card-note">${locked
                            ? `Бот играет только на: <strong>${esc(locked)}</strong>`
                            : 'Бот выбирает бойца сам по сортировке'}</p>
                    </div>
                    <div class="card-actions">
                        <label class="field-label" for="brawlerDevice">Устройство</label>
                        <select class="input" id="brawlerDevice">${deviceOptions}</select>
                        ${locked ? '<button class="btn btn-ghost" id="unlockBrawler">Выбирать автоматически</button>' : ''}
                    </div>
                </div>
                <div class="card-body">
                    <div class="brawler-picker">${brawlers.map((b) => `
                        <button class="brawler-chip${String(b.name).toLowerCase() === locked.toLowerCase() ? ' is-picked' : ''}"
                                data-lock-brawler="${esc(b.name)}" title="${esc(b.name)}">
                            <img src="${esc(b.icon_url)}" alt="" onerror="this.style.display='none'">
                            <span>${esc(b.name)}</span>
                        </button>`).join('') || '<div class="empty">Каталог бойцов недоступен</div>'}</div>
                </div>
            </div>`;
    }

    document.addEventListener('change', async (event) => {
        if (event.target.id === 'brawlerDevice') {
            settingsKey = event.target.value;
            await loadBrawlersTab();
        }
    });

    document.addEventListener('click', async (event) => {
        const pick = event.target.closest('[data-lock-brawler]');
        if (pick) {
            const key = settingsKey || (await currentDeviceKey());
            if (!key) {
                toast('Сначала подключите устройство', 'error');
                return;
            }
            try {
                const done = await api(`/api/devices/${encodeURIComponent(key)}/brawler`, {
                    method: 'POST',
                    body: { brawler: pick.dataset.lockBrawler },
                });
                if (!done.ok) {
                    toast((done && done.message) || 'Не удалось выбрать бойца', 'error');
                    return;
                }
                toast(`Бот будет играть только на ${pick.dataset.lockBrawler}`, 'ok');
                await loadBrawlersTab();
            } catch (error) {
                toast('Не удалось выбрать бойца: ' + error.message, 'error');
            }
            return;
        }

        if (event.target.id === 'unlockBrawler') {
            const key = settingsKey || (await currentDeviceKey());
            if (!key) {
                toast('Сначала подключите устройство', 'error');
                return;
            }
            try {
                await api(`/api/devices/${encodeURIComponent(key)}/brawler`, {
                    method: 'POST', body: { brawler: '' },
                });
                toast('Бот снова выбирает бойца сам', 'ok');
                await loadBrawlersTab();
            } catch (error) {
                toast('Не удалось снять выбор: ' + error.message, 'error');
            }
        }
    });

    async function currentDeviceKey() {
        const devices = await api('/api/devices');
        const list = devices.devices || [];
        return list.length ? list[0].key : '';
    }

    // ───────────────────────── плейстайлы ─────────────────────────

    async function loadPlaystyles() {
        const data = await api('/api/playstyles');
        const items = data.items || [];
        const current = data.current || {};
        const activeName = current.filename || current.name || '';

        view('playstyles').innerHTML = `
            <div class="card">
                <div class="card-head">
                    <div>
                        <h3 class="card-title">Плейстайлы</h3>
                        <p class="card-note">Сейчас выполняется: <strong>${esc(activeName || 'не выбран')}</strong></p>
                    </div>
                    <div class="card-actions">
                        <input class="input" id="playstyleFile" type="file" accept=".xlambot,.pyla" style="max-width:230px">
                        <button class="btn" id="importPlaystyle">Загрузить</button>
                    </div>
                </div>
                <div class="card-body">
                    ${items.length ? `<div class="playstyle-grid">${items.map((item) => `
                        <div class="playstyle-card ${item.filename === activeName ? 'is-active' : ''}">
                            <h4>${esc(item.name || item.filename)}</h4>
                            <p>${esc(item.description || 'Без описания')}</p>
                            <div class="playstyle-meta">
                                ${item.author ? `<span>${esc(item.author)}</span>` : ''}
                                ${item.date ? `<span>${esc(item.date)}</span>` : ''}
                                ${Array.isArray(item.brawlers)
                                    ? `<span>${item.brawlers.includes('all') ? 'все бойцы'
                                        : `${item.brawlers.length} бойцов`}</span>` : ''}
                            </div>
                            <div class="playstyle-actions">
                                <button class="btn btn-sm btn-primary" data-activate="${esc(item.filename)}"
                                    ${item.filename === activeName ? 'disabled' : ''}>Включить</button>
                                <button class="btn btn-sm btn-danger" data-delete-playstyle="${esc(item.filename)}"
                                    ${item.filename === activeName ? 'disabled' : ''}>Удалить</button>
                            </div>
                        </div>`).join('')}</div>`
                        : '<div class="empty"><strong>Плейстайлов нет</strong>Загрузите файл .xlambot</div>'}
                </div>
            </div>`;
    }

    document.addEventListener('click', async (event) => {
        const activate = event.target.closest('[data-activate]');
        if (activate) {
            try {
                await api(`/api/playstyles/active`, {
                    method: 'PUT',
                    body: { filename: activate.dataset.activate },
                });
                toast('Плейстайл включён: ' + activate.dataset.activate, 'ok');
                await loadPlaystyles();
            } catch (error) {
                toast('Не удалось включить: ' + error.message, 'error');
            }
            return;
        }

        const del = event.target.closest('[data-delete-playstyle]');
        if (del) {
            if (!confirm('Удалить плейстайл ' + del.dataset.deletePlaystyle + '?')) return;
            try {
                await api(`/api/playstyles/${encodeURIComponent(del.dataset.deletePlaystyle)}`,
                    { method: 'DELETE' });
                toast('Плейстайл удалён', 'ok');
                await loadPlaystyles();
            } catch (error) {
                toast('Не удалось удалить: ' + error.message, 'error');
            }
            return;
        }

        if (event.target.id === 'importPlaystyle') {
            const input = document.getElementById('playstyleFile');
            if (!input || !input.files || !input.files.length) {
                toast('Сначала выберите файл', 'error');
                return;
            }
            const form = new FormData();
            form.append('file', input.files[0]);
            try {
                const response = await window.XlamSession.fetch('/api/playstyles/import', {
                    method: 'POST',
                    headers: { 'X-Xlam-UI-Token': TOKEN },
                    body: form,
                });
                const data = await response.json();
                if (!response.ok) throw new Error(data.message || 'не удалось');
                toast('Плейстайл загружен', 'ok');
                await loadPlaystyles();
            } catch (error) {
                toast('Не удалось загрузить: ' + error.message, 'error');
            }
        }
    });

    // ───────────────────────── настройки ─────────────────────────

    // Подсказки к полям. Ключ - имя поля; раздел определяется тем, в каком
    // файле сервер его вернул, поэтому здесь только текст.
    const HINTS = {
        brawler_switch_after_games: ['Игр на бойца до смены', '0 — не менять бойца'],
        brawler_pick_mode: ['Как выбирать бойца', 'lowest_trophies, lowest_level, by_name…'],
        brawler_rotation: ['Ротация по списку', 'Бойцы через запятую'],
        current_playstyle: ['Плейстайл', 'Файл .xlambot из папки playstyles'],
        game_mode: ['Режим игры', 'Сверяется с плейстайлом — предупредит, если режим не тот'],
        locked_brawler: ['Играть только на бойце', 'Пусто — выбирать автоматически. Удобнее выбрать на вкладке «Боец»'],
        preview_interval_ms: ['Частота превью, мс', '800 — примерно 1,25 кадра в секунду, 0 — максимально быстро'],
        target_trophies: ['Цель по трофеям (справочно)', 'В этой версии автоостановка по цели отключена'],
        run_for_minutes: ['Длительность работы', '0 — без ограничения, в минутах'],
        max_fps: ['Кадров в секунду', 'auto или число'],
        state_check: ['Пауза между проверками экрана', 'Секунды'],
        super: ['Задержка суперспособности', 'Секунды'],
        hypercharge: ['Задержка гиперзаряда', 'Секунды'],
        gadget: ['Задержка гаджета', 'Секунды'],
        gas_avoidance: ['Обход газа', 'yes — не заходить в газ'],
        gas_sensitivity: ['Чувствительность газа', 'Больше — замечает раньше'],
        minimum_movement_delay: ['Минимальная задержка движения', 'Секунды'],
        unstuck_movement_delay: ['Задержка при застревании', 'Секунды'],
        unstuck_movement_hold_time: ['Длительность при отлипании', 'Секунды'],
        perceived_tile_size: ['Размер клетки на экране', 'Пиксели, зависит от разрешения'],
        play_again_on_win: ['Играть снова после победы', 'yes или no'],
        idle_pixels_minimum: ['Порог простоя', 'Меньше — считается простоем'],
        wall_detection_confidence: ['Уверенность в стенах', 'Порог 0..1'],
        state_detection_confidence: ['Уверенность в состоянии', 'Порог 0..1'],
        after_endscreen_click: ['Пауза после экрана итогов', 'Секунды'],
        before_click_start: ['Пауза перед стартом', 'Секунды'],
        after_game_ends_click: ['Пауза после конца матча', 'Секунды'],
        pop_random_wait: ['Случайная пауза в лобби', 'Максимум, в секундах'],
        brawl_stars_package: ['Пакет игры', 'Оставьте как настроил мастер'],
        interface_mode: ['Интерфейс', 'desktop или browser'],
        ping_when_stuck: ['Писать, когда бот застрял', 'yes или no'],
        ping_when_target_is_reached: ['Писать о цели', 'yes или no'],
        ping_every_x_match: ['Писать каждые N матчей', '0 — выключить'],
        ping_every_x_minutes: ['Писать каждые N минут', '0 — выключить'],
        state_finder_debug: ['Отладка определения экрана', 'Печатать, что видит бот'],
        template_matching_debug: ['Отладка шаблонов', 'Подробный вывод'],
        verbose_debug: ['Подробный вывод', 'Много сообщений в лог'],
        save_debug_frames: ['Сохранять кадры отладки', 'Занимает место на диске'],
    };

    const SECTION_LABELS = {
        bot_config: 'Бот',
        general: 'Общие',
        timers: 'Паузы',
        webhook: 'Уведомления',
        debug: 'Отладка',
        modes_config: 'Режимы',
        lobby_config: 'Распознавание экрана',
        time_tresholds: 'Пороги времени',
    };

    const PICK_MODES = [
        ['', 'по умолчанию'],
        ['lowest_trophies', 'по минимальным трофеям'],
        ['closest_to_rank', 'ближе всех к рангу'],
        ['lowest_level', 'по уровню, с низкого'],
        ['most_trophies', 'по максимальным трофеям'],
        ['by_name', 'по имени'],
    ];

    // Режимы берём из modes_config.toml на сервере, чтобы список не разошёлся
    // с тем, что бот считает своим режимом. Пустое значение - режим не задан,
    // и тогда проверка «плейстайл не для того режима» молчит.
    const GAME_MODES = [
        ['', 'не задан'],
        ['solo_showdown', 'Одиночное шоудаун'],
        ['duo_showdown', 'Парное шоудаун'],
        ['trio_showdown', 'Тройное шоудаун'],
        ['heist', 'Ограбление'],
        ['bounty', 'Охота за баунти'],
        ['gem_grab', 'Сбор кристаллов'],
        ['knockout', 'Нокаут'],
        ['hot_zone', 'Горячая зона'],
        ['siege', 'Осада'],
    ];


    let settingsSections = {}, settingsDraft = {}, settingsDirty = false;
    Object.assign(HINTS, Object.fromEntries(Object.entries(window.XlamSettingsFields).map(([k,v])=>[k,[v[0],v[2]]])));
    Object.assign(SECTION_LABELS,{general_config:'Подключение и производительность',bot_config:'Игра и поведение',time_tresholds:'Интервалы действий',webhook_config:'Уведомления',debug_settings:'Диагностика',buttons_config:'Кнопки и калибровка',login:'Доступ',modes_config:'Выбор игрового режима'});
    const secretKeys=new Set(['key','discord_bot_token','telegram_token','webhook_url']);
    const advancedKeys=new Set(['buttons_config','lobby_config','modes_config','login','debug_settings']);
    const choices={thinking_mode:[['low','Низкий'],['medium','Средний'],['high','Высокий'],['maximum','Максимальный']],cpu_or_gpu:[['auto','Автоматически'],['cpu','CPU — процессор'],['gpu','GPU — видеокарта']],interface_mode:[['browser','Веб-панель'],['desktop','Окно программы']]};
    function languageCard(){return `<div class="card"><div class="card-head"><div><h3 class="card-title">Language</h3><p class="card-note">Язык всех страниц, подсказок и сообщений панели. Общий для всех устройств.</p></div></div><div class="card-body"><label class="field-label" for="languageChoice">Language</label><select id="languageChoice" class="input"><option value="ru" ${document.documentElement.lang==='ru'?'selected':''}>Russian</option><option value="en" ${document.documentElement.lang==='en'?'selected':''}>English</option></select></div></div>`;}
    async function loadSettings() {
        const devicesData=await api('/api/devices');
        const devices=(devicesData.devices||[]).filter(d=>d.key);
        if(!devices.length){view('settings').innerHTML=languageCard()+'<div class="card"><div class="card-body">Подключите эмулятор, чтобы настроить его профиль.</div></div>';return;}
        if(!devices.some(d=>d.key===settingsKey))settingsKey=devices[0].key;
        const data=await api(`/api/devices/${encodeURIComponent(settingsKey)}/settings`);
        settingsSections=data.settings||{};settingsDraft=JSON.parse(JSON.stringify(settingsSections));settingsDirty=false;
        const names=Object.keys(settingsSections).sort((a,b)=>Number(advancedKeys.has(a))-Number(advancedKeys.has(b)));
        view('settings').innerHTML=languageCard()+`
        <div class="card"><div class="card-head"><div><h3 class="card-title">Настройки устройства</h3><p class="card-note">Каждый эмулятор имеет свой профиль. Изменения применяются при следующем запуске бота.</p></div><div class="card-actions"><button class="btn btn-primary" id="saveSettings">Сохранить</button><button class="btn btn-ghost" id="reloadSettings">Вернуть сохранённые</button></div></div>
        <div class="card-body"><label class="field-label" for="settingsDevice">Устройство</label><select class="input" id="settingsDevice">${devices.map(d=>`<option value="${esc(d.key)}" ${d.key===settingsKey?'selected':''}>${esc(d.display_name||d.key)} · ${esc(d.serial)}</option>`).join('')}</select><p class="muted">Начните с режима игры, смены бойцов и обхода газа. Распознавание и таймеры обычно можно оставить по умолчанию.</p><a class="btn btn-secondary" href="/calibration/${encodeURIComponent(settingsKey)}">Калибровка кнопок и кубков</a></div>
        <div class="card-body is-tight">${names.map(name=>`<div class="settings-group ${name==='bot_config'?'is-open':''}" data-group="${esc(name)}"><button type="button" class="settings-group-head" aria-expanded="${name==='bot_config'}"><span class="settings-group-title">${esc(SECTION_LABELS[name]||name)}</span><span class="eyebrow">${advancedKeys.has(name)?'Дополнительно':'Настроить'}</span></button><div class="settings-group-body">${renderSection(name,settingsSections[name])}</div></div>`).join('')}</div></div>
        <div class="card"><div class="card-body"><button class="btn btn-primary" id="saveSettingsBottom">Сохранить настройки</button> <span id="settingsState" role="status" class="muted"></span></div></div>`;
    }
    function renderSection(section,values){
        const simple=Object.entries(values).filter(([k,v])=>!v||typeof v!=='object'||['gas_classes','wall_model_classes'].includes(k));
        const structured=Object.entries(values).filter(([k,v])=>v&&typeof v==='object'&&!['gas_classes','wall_model_classes'].includes(k));
        if(section==='bot_config'){
            const groups=[['Основное',simple.filter(([key])=>!key.startsWith('gas_')&&!['target_trophies','training_classes'].includes(key)&&!/(confidence|pixels_minimum|movement|perceived_tile|seconds_to_hold)/.test(key))],['Обход газа',simple.filter(([key])=>key.startsWith('gas_'))],['Распознавание и готовность способностей',simple.filter(([key])=>/(confidence|pixels_minimum)/.test(key)&&!key.startsWith('gas_'))],['Движение и атака',simple.filter(([key])=>/(movement|perceived_tile|seconds_to_hold)/.test(key))],['Обучение и справочные цели',simple.filter(([key])=>['target_trophies','training_classes'].includes(key))]];
            return groups.map(([title,items],i)=>i===0?items.map(([k,v])=>renderField(section,k,v)).join(''):`<details class="settings-subgroup"><summary>${esc(title)}</summary>${items.map(([k,v])=>renderField(section,k,v)).join('')}</details>`).join('');
        }
        return simple.map(([k,v])=>renderField(section,k,v)).join('')+(structured.length?`<div class="field is-wide"><div><strong>Калибровка и параметры модели</strong><p class="muted">Координаты и области меняйте в калибровке устройства. Здесь показаны сохранённые значения для диагностики.</p><details><summary>Показать технические значения</summary><pre class="settings-json">${esc(JSON.stringify(Object.fromEntries(structured),null,2))}</pre></details></div></div>`:'');
    }
    function renderField(section,key,value){
        const hint=HINTS[key]||[key,'Дополнительный параметр. Меняйте только если знаете его назначение.'];
        const attrs=`data-setting="${esc(key)}" data-section="${esc(section)}"`,id=`set-${section}-${key}`;
        const caption=`<label class="field-label" for="${id}">${esc(hint[0])}<small>${esc(hint[1])}</small></label>`;
        let control;
        if(typeof value==='boolean'||['yes','no'].includes(value))control=`<label class="switch"><input id="${id}" type="checkbox" ${attrs} ${typeof value==='boolean'?'':'data-boolean-string="yes"'} ${value===true||value==='yes'?'checked':''}><span class="switch-track"></span></label>`;
        else if(key==='brawler_pick_mode'||key==='game_mode'||choices[key]){
            const list=key==='game_mode'?GAME_MODES:key==='brawler_pick_mode'?PICK_MODES:choices[key];
            control=`<select class="input" id="${id}" ${attrs}>${!list.some(([v])=>v===value)?`<option value="${esc(value)}" selected>${esc(value)}</option>`:''}${list.map(([v,label])=>`<option value="${esc(v)}" ${v===value?'selected':''}>${esc(label)}</option>`).join('')}</select>`;
        }else if(Array.isArray(value))control=`<input class="input" id="${id}" ${attrs} data-array="yes" value="${esc(value.join(', '))}">`;
        else control=`<input class="input" id="${id}" ${attrs} type="${secretKeys.has(key)?'password':typeof value==='number'?'number':'text'}" ${typeof value==='number'?'min="0" step="any"':''} autocomplete="${secretKeys.has(key)?'new-password':'off'}" value="${esc(value)}" ${secretKeys.has(key)?'placeholder="Сохранённое значение скрыто"':''}>`;
        return `<div class="field">${caption}<div class="field-control">${control}</div></div>`;
    }
    document.addEventListener('change',async event=>{
        if(event.target.id==='languageChoice'){
            await api('/api/ui/preferences',{method:'POST',body:{language:event.target.value}});
            window.XlamI18n.setLanguage(event.target.value,true);return;
        }
        if(event.target.id==='settingsDevice'){
            if(settingsDirty){event.target.value=settingsKey;toast('Сначала сохраните изменения или нажмите «Вернуть сохранённые».','error');return;}
            settingsKey=event.target.value;await loadSettings();return;
        }
        const field=event.target.closest('[data-setting]');if(!field)return;
        const section=field.dataset.section,key=field.dataset.setting;
        let value=field.type==='checkbox'?(field.dataset.booleanString?(field.checked?'yes':'no'):field.checked):field.type==='number'?Number(field.value):field.dataset.array?field.value.split(',').map(v=>v.trim()).filter(Boolean):field.value;
        if(field.type==='number'&&(field.value===''||!Number.isFinite(value)||value<0)){field.setCustomValidity(window.XlamI18n.t('Введите неотрицательное число'));field.reportValidity();return;}
        field.setCustomValidity('');settingsDraft[section][key]=value;settingsDirty=true;
        document.getElementById('settingsState').textContent='Есть несохранённые изменения';
    });
    async function saveSettings(){
        const invalid=view('settings').querySelector(':invalid');if(invalid){invalid.reportValidity();return;}
        const buttons=document.querySelectorAll('#saveSettings,#saveSettingsBottom');buttons.forEach(b=>b.disabled=true);
        let ok=true;
        try{
            for(const [section,values] of Object.entries(settingsDraft)){
                const changed=Object.fromEntries(Object.entries(values).filter(([key,value])=>JSON.stringify(value)!==JSON.stringify(settingsSections[section][key])));
                if(!Object.keys(changed).length)continue;
                await api(`/api/devices/${encodeURIComponent(settingsKey)}/settings`,{method:'POST',body:{section,values:changed}});
                Object.assign(settingsSections[section],changed);
            }
        }catch(error){ok=false;toast(error.message,'error');}
        finally{buttons.forEach(b=>b.disabled=false);}
        if(ok){await loadSettings();toast('Настройки сохранены','ok');}
    }
    document.addEventListener('click',async event=>{
        const head=event.target.closest('.settings-group-head');
        if(head){head.parentElement.classList.toggle('is-open');head.setAttribute('aria-expanded',head.parentElement.classList.contains('is-open'));return;}
        if(['saveSettings','saveSettingsBottom'].includes(event.target.id))await saveSettings();
        if(event.target.id==='reloadSettings'){await loadSettings();toast('Показаны сохранённые значения');}
    });
    window.addEventListener('beforeunload',event=>{if(settingsDirty){event.preventDefault();event.returnValue='';}});

    // ───────────────────────── история ─────────────────────────

    async function loadHistory() {
        const historyDevices=(await api('/api/devices')).devices||[];
        if(!historyDevices.some(d=>d.key===settingsKey))settingsKey=historyDevices[0]?.key||'';
        const data = await api(settingsKey?`/api/devices/${encodeURIComponent(settingsKey)}/history`:'/api/history');
        // Этот эндпоинт отвечает сводкой по бойцам, а не списком матчей:
        // каждый элемент - один боец с его трофеями, победами и последней игрой.
        const items = data.items || [];
        const summary = data.summary || {};
        const session = data.session_summary || {};
        const sessionLabels = {active:'Сессия активна',losses:'Поражений',started_at:'Начало сессии',total_matches:'Матчей',trophy_delta:'Изменение трофеев',win_rate:'Процент побед',wins:'Побед'};
        const sessionValue = (k,v) => {
            if(v==null)return '—';
            if(typeof v==='boolean')return v?'Да':'Нет';
            if(k==='started_at'){
                const date=new Date(typeof v==='number'&&v<1e12?v*1000:v);
                return Number.isNaN(date.getTime())?v:date.toLocaleString(window.XlamI18n?.locale||'ru-RU');
            }
            if(k==='win_rate')return `${Math.round(v)}%`;
            return typeof v==='number'?v.toLocaleString(window.XlamI18n?.locale||'ru-RU'):v;
        };

        const kpis = [
            ['Матчей', summary.total_matches, ''],
            ['Побед', summary.wins, 'is-up'],
            ['Поражений', summary.losses, 'is-down'],
            ['Процент побед', summary.win_rate, ''],
            ['Бойцов отслежено', summary.tracked_brawlers, ''],
        ].map(([label, value, cls]) => `
            <div class="kpi ${cls}">
                <div class="kpi-label">${esc(label)}</div>
                <div class="kpi-value">${value == null ? '—'
                    : esc(typeof value === 'number' ? Math.round(value) : value)}</div>
            </div>`).join('');

        view('history').innerHTML = `
            <div class="kpi-grid" style="margin-bottom:12px">${kpis}</div>
            <div class="card">
                <div class="card-head">
                    <div>
                        <h3 class="card-title">Бойцы</h3>
                        <p class="card-note">${items.length} ${plural(items.length, 'боец', 'бойца', 'бойцев')} в статистике</p>
                    </div>
                    <div><label class="field-label" for="historyDevice">Устройство</label><select class="input" id="historyDevice">${historyDevices.map(d=>`<option value="${esc(d.key)}" ${d.key===settingsKey?'selected':''}>${esc(d.display_name||d.key)}</option>`).join('')}</select></div>
                </div>
                <div class="card-body is-tight">
                    <table class="table">
                        <thead><tr>
                            <th>Боец</th><th class="num">Трофеи</th><th class="num">Матчей</th>
                            <th class="num">Побед</th><th class="num">Лучшая дельта</th>
                            <th class="num">Лучшая серия</th><th>Играл в последний раз</th>
                        </tr></thead>
                        <tbody>${renderHistoryRows(items)}</tbody>
                    </table>
                </div>
            </div>
            ${Object.keys(session).length ? `
            <div class="card">
                <div class="card-head"><h3 class="card-title">Сейчас</h3></div>
                <div class="card-body is-tight">
                    <table class="table"><tbody>${Object.entries(session).map(([k, v]) => `
                        <tr><td class="muted">${esc(sessionLabels[k]||k)}</td>
                            <td class="num">${esc(sessionValue(k,v))}</td></tr>`).join('')}
                    </tbody></table>
                </div>
            </div>` : ''}`;
    }

    function renderHistoryRows(items) {
        if (!items.length) return '<tr><td colspan="7" class="empty">Статистики пока нет</td></tr>';
        const rows = items.slice().sort(
            (a, b) => (b.current_trophies || 0) - (a.current_trophies || 0));
        return rows.map((row) => {
            const matches = row.matches != null ? row.matches
                : (row.wins || 0) + (row.losses || 0);
            return `<tr>
                <td>
                    <span class="brawler-cell">
                        <img class="brawler-icon" src="${esc(row.icon_url || '')}" alt=""
                             onerror="this.style.visibility='hidden'">
                        <span class="brawler-name">${esc(row.brawler || '—')}</span>
                    </span>
                </td>
                <td class="num">${row.current_trophies ?? '—'}</td>
                <td class="num">${matches || '—'}</td>
                <td class="num">${row.wins ?? '—'}</td>
                <td class="num">${row.best_trophy_delta != null ? sign(row.best_trophy_delta) : '—'}</td>
                <td class="num">${row.best_win_streak ?? '—'}</td>
                <td class="nowrap mono" style="font-size:11px">${esc(row.last_played || '—')}</td>
            </tr>`;
        }).join('');
    }

    // ───────────────────────── логи ─────────────────────────

    let logsKey = '';

    async function loadLogs() {
        const devices = await api('/api/devices');
        const list = devices.devices || [];
        if (!logsKey && list.length) logsKey = list[0].key;

        let text = '';
        let count = 0;
        if (logsKey) {
            try {
                const data = await api(`/api/devices/${encodeURIComponent(logsKey)}/logs?limit=1200`);
                text = data.logs || [];
                count = Array.isArray(text) ? text.length : 0;
                if (Array.isArray(text)) text = text.join('\n');
            } catch (error) {
                text = 'Не удалось прочитать логи: ' + error.message;
            }
        } else {
            text = 'Устройств нет';
        }

        const box = document.getElementById('logBox');
        if (box) {
            box.textContent = text || 'Логи пусты';
        } else {
            view('logs').innerHTML = `
                <div class="card">
                    <div class="card-head">
                        <div>
                            <h3 class="card-title">Логи бота</h3>
                            <p class="card-note">Последние записи из работающего процесса</p>
                        </div>
                        <div class="card-actions log-controls">
                            <select class="input" id="logDevice">
                                ${list.map((d) => `<option value="${esc(d.key)}"
                                    ${d.key === logsKey ? 'selected' : ''}>${esc(d.display_name || d.model || d.key)} · ${esc(d.serial || d.key)}</option>`).join('')}
                            </select>
                            <span class="log-count">${count} ${plural(count, 'строка', 'строки', 'строк')}</span>
                            <button class="btn btn-ghost" id="clearLogs">Очистить</button>
                        </div>
                    </div>
                    <div class="card-body">
                        <div class="log-console" id="logBox">${esc(text)}</div>
                    </div>
                </div>`;
        }
        if (box) box.scrollTop = box.scrollHeight;
    }

    document.addEventListener('change', (event) => {
        if (event.target.id === 'logDevice') {
            logsKey = event.target.value;
            loadLogs();
        }
        if(event.target.id==='historyDevice'){settingsKey=event.target.value;loadHistory();}
    });

    document.addEventListener('click', async (event) => {
        if (event.target.id === 'clearLogs') {
            if (!logsKey) return;
            await api(`/api/devices/${encodeURIComponent(logsKey)}/logs`, { method: 'DELETE' });
            toast('Логи очищены', 'ok');
            await loadLogs();
        }
    });

    // ───────────────────────── индикатор связи ─────────────────────────

    function trackPollAge() {
        const el = document.getElementById('pollAge');
        if (!el) return;
        let lastOk = 0;
        setInterval(async () => {
            try {
                await api('/api/devices/status');
                lastOk = Date.now();
                const seconds = Math.round((Date.now() - lastOk) / 1000);
                el.classList.remove('is-dead');
                el.classList.add('is-live');
                el.textContent = 'связь есть';
            } catch (error) {
                const stale = Math.round((Date.now() - lastOk) / 1000);
                el.classList.add('is-dead');
                el.textContent = lastOk
                    ? `нет связи ${stale} с`
                    : 'нет связи';
            }
        }, 4000);
    }

    // ───────────────────────── старт ─────────────────────────

    showTab('dashboard');
    trackPollAge();
})();
