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
        pollers[name] = setInterval(loaders[name], name === 'dashboard' ? 2500 : 6000);
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
                    <div class="kpi-value">${totals.trophies.toLocaleString('ru-RU')}</div>
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
                                    <strong>${esc(row.device.model || row.device.serial)}</strong>
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
                ${esc(d.model || d.serial || d.key)}
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

    let settingsSections = {};
    let settingsDraft = {};

    async function loadSettings() {
        const devices = await api('/api/devices');
        const first = (devices.devices || [])[0];
        if (!first) {
            view('settings').innerHTML =
                '<div class="card"><div class="card-body"><div class="empty"><strong>Устройств нет</strong>Настройки появятся, когда появится устройство</div></div></div>';
            return;
        }
        settingsKey = first.key;
        const data = await api(`/api/devices/${encodeURIComponent(settingsKey)}/settings`);
        settingsSections = data.settings || {};
        settingsDraft = JSON.parse(JSON.stringify(settingsSections));

        const names = Object.keys(settingsSections);
        view('settings').innerHTML = `
            <div class="card">
                <div class="card-head">
                    <div>
                        <h3 class="card-title">Настройки</h3>
                        <p class="card-note">Устройство ${esc(settingsKey)} · значения пишутся в его профиль</p>
                    </div>
                    <div class="card-actions">
                        <button class="btn btn-primary" id="saveSettings">Сохранить</button>
                        <button class="btn btn-ghost" id="reloadSettings">Вернуть сохранённые</button>
                    </div>
                </div>
                <div class="card-body is-tight">
                    ${names.length ? names.map((name) => `
                        <div class="settings-group ${name === 'bot_config' ? 'is-open' : ''}" data-group="${esc(name)}">
                            <div class="settings-group-head">
                                <div class="settings-group-title">${esc(SECTION_LABELS[name] || name)}</div>
                                <span class="eyebrow">${esc(name)}.toml</span>
                            </div>
                            <div class="settings-group-body">
                                ${renderSection(name, settingsSections[name] || {})}
                            </div>
                        </div>`).join('')
                        : '<div class="empty">Сервер не вернул настроек</div>'}
                </div>
            </div>
            <div class="card">
                <div class="card-body" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
                    <button class="btn btn-primary" id="saveSettingsBottom">Сохранить настройки</button>
                    <span class="muted" id="settingsState" style="font-size:11.5px"></span>
                </div>
            </div>`;
    }

    function renderSection(section, values) {
        const entries = Object.entries(values);
        if (!entries.length) return '<div class="empty">Файл пуст</div>';
        return entries.map(([key, value]) => renderField(section, key, value)).join('');
    }

    function renderField(section, key, value) {
        const hint = HINTS[key] || [key, ''];
        const label = hint[0];
        const note = hint[1] ? '<small>' + esc(hint[1]) + '</small>' : '';
        const attrs = `data-setting="${esc(key)}" data-section="${esc(section)}"`;
        const id = `set-${section}-${key}`;

        if (typeof value === 'boolean') {
            return `<div class="field">
                <label class="field-label" for="${esc(id)}">${esc(label)}${note}</label>
                <div class="field-control">
                    <label class="switch">
                        <input type="checkbox" id="${esc(id)}" ${attrs} ${value ? 'checked' : ''}>
                        <span class="switch-track"></span>
                    </label>
                </div>
            </div>`;
        }

        if (key === 'brawler_pick_mode' || key === 'game_mode') {
            const list = key === 'game_mode' ? GAME_MODES : PICK_MODES;
            const options = list.map(([v, text]) => `
                <option value="${esc(v)}" ${String(value) === String(v) ? 'selected' : ''}>${esc(text)}</option>`).join('');
            return `<div class="field">
                <label class="field-label" for="${esc(id)}">${esc(label)}${note}</label>
                <div class="field-control">
                    <select class="input" id="${esc(id)}" ${attrs}>${options}</select>
                </div>
            </div>`;
        }

        if (typeof value === 'number') {
            return `<div class="field">
                <label class="field-label" for="${esc(id)}">${esc(label)}${note}</label>
                <div class="field-control">
                    <input class="input" id="${esc(id)}" type="number" step="any" ${attrs}
                           value="${esc(value)}">
                </div>
            </div>`;
        }

        const wide = typeof value === 'string' && value.length > 60;
        return `<div class="field ${wide ? 'is-wide' : ''}">
            <label class="field-label" for="${esc(id)}">${esc(label)}${note}</label>
            <div class="field-control">
                <input class="input" id="${esc(id)}" type="text" ${attrs} value="${esc(value)}">
            </div>
        </div>`;
    }

    document.addEventListener('change', (event) => {
        const field = event.target.closest('[data-setting]');
        if (!field) return;
        const section = field.dataset.section;
        const key = field.dataset.setting;
        if (!settingsDraft[section]) return;
        let value;
        if (field.type === 'checkbox') value = field.checked;
        else if (field.type === 'number') value = field.value === '' ? '' : Number(field.value);
        else value = field.value;
        settingsDraft[section][key] = value;
        const state = document.getElementById('settingsState');
        if (state) state.textContent = 'Есть несохранённые изменения';
    });

    async function saveSettings() {
        const buttons = document.querySelectorAll('#saveSettings, #saveSettingsBottom');
        buttons.forEach((b) => { b.disabled = true; });
        let ok = true;
        for (const [section, values] of Object.entries(settingsDraft)) {
            try {
                await api(`/api/devices/${encodeURIComponent(settingsKey)}/settings`, {
                    method: 'POST',
                    body: { section: `cfg/${section}.toml`, values },
                });
            } catch (error) {
                toast(`${section}: ${error.message}`, 'error');
                ok = false;
            }
        }
        buttons.forEach((b) => { b.disabled = false; });
        if (ok) {
            toast('Настройки сохранены', 'ok');
            const state = document.getElementById('settingsState');
            if (state) state.textContent = '';
            await loadSettings();
        }
    }

    document.addEventListener('click', async (event) => {
        const head = event.target.closest('.settings-group-head');
        if (head) {
            head.parentElement.classList.toggle('is-open');
            return;
        }
        if (event.target.id === 'saveSettings' || event.target.id === 'saveSettingsBottom') {
            await saveSettings();
            return;
        }
        if (event.target.id === 'reloadSettings') {
            await loadSettings();
            toast('Показаны сохранённые значения');
        }
    });

    // ───────────────────────── история ─────────────────────────

    async function loadHistory() {
        const data = await api('/api/history');
        // Этот эндпоинт отвечает сводкой по бойцам, а не списком матчей:
        // каждый элемент - один боец с его трофеями, победами и последней игрой.
        const items = data.items || [];
        const summary = data.summary || {};
        const session = data.session_summary || {};

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
                        <tr><td class="muted">${esc(k)}</td>
                            <td class="num">${esc(typeof v === 'number' ? v.toLocaleString('ru-RU') : v)}</td></tr>`).join('')}
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
                                    ${d.key === logsKey ? 'selected' : ''}>${esc(d.model || d.key)}</option>`).join('')}
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