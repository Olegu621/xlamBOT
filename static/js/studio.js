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
        const response = await fetch(path, opts);
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
        queue: loadQueue,
        playstyles: loadPlaystyles,
        settings: loadSettings,
        history: loadHistory,
        logs: loadLogs,
    };
    let activeTab = 'dashboard';

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

    // ───────────────────────── очередь ─────────────────────────

    let queueData = { queue: [], brawlers: [] };
    let pickedBrawlers = new Set();

    async function loadQueue() {
        const devices = await api('/api/devices');
        const first = (devices.devices || [])[0];
        if (!first) {
            queueData = { queue: [], brawlers: [] };
            renderQueue();
            return;
        }
        // The roster the bot actually plays from is the device's own queue. The
        // top-level /api/queue is a separate global list and stays empty in the
        // normal single-device case, which is why the tab showed nothing.
        const [queue, brawlers] = await Promise.all([
            api(`/api/devices/${encodeURIComponent(first.key)}/queue`),
            api('/api/devices/brawlers'),
        ]);
        queueData = {
            queue: queue.items || [],
            brawlers: brawlers.brawlers || [],
        };
        pickedBrawlers = new Set(queueData.queue.map((e) => e.brawler));
        renderQueue();
    }

    function renderQueue() {
        const entries = queueData.queue;
        const rows = entries.map((entry, index) => `
            <tr>
                <td class="nowrap">
                    <span class="rank">${index + 1}</span>
                    <span class="brawler-cell">
                        <img class="brawler-icon" src="/api/assets/brawlers/${encodeURIComponent(entry.brawler)}"
                             alt="" onerror="this.style.visibility='hidden'">
                        <span class="brawler-name">${esc(entry.brawler)}</span>
                    </span>
                </td>
                <td class="num">${entry.trophies ?? 0}</td>
                <td class="num">${entry.wins ?? 0}</td>
                <td class="num">${entry.win_streak ?? 0}</td>
                <td>
                    <label class="switch" title="Бот выбирает этого бойца сам">
                        <input type="checkbox" data-auto="${esc(entry.brawler)}"
                            ${entry.automatically_pick ? 'checked' : ''}>
                        <span class="switch-track"></span>
                    </label>
                </td>
                <td class="num">${esc(entry.push_until ?? '—')}</td>
                <td class="actions">
                    <button class="btn btn-sm" data-up="${index}" ${index === 0 ? 'disabled' : ''}>↑</button>
                    <button class="btn btn-sm" data-down="${index}" ${index === entries.length - 1 ? 'disabled' : ''}>↓</button>
                    <button class="btn btn-sm btn-danger" data-remove="${esc(entry.brawler)}">Убрать</button>
                </td>
            </tr>`).join('');

        const pickable = queueData.brawlers
            .filter((b) => !pickedBrawlers.has(b.slug))
            .map((b) => `
                <button class="brawler-chip" data-add="${esc(b.slug)}">
                    <img src="${esc(b.icon_url)}" alt="" onerror="this.style.display='none'">
                    <span>${esc(b.name)}</span>
                </button>`).join('');

        view('queue').innerHTML = `
            <div class="card">
                <div class="card-head">
                    <div>
                        <h3 class="card-title">Очередь бойцов</h3>
                        <p class="card-note">Порядок влияет на то, кого бот поставит первым при ручном выборе</p>
                    </div>
                    <div class="card-actions">
                        <button class="btn btn-primary" id="saveQueue">Сохранить</button>
                        <button class="btn btn-ghost" id="resetQueue">Вернуть как было</button>
                    </div>
                </div>
                <div class="card-body is-tight">
                    <table class="table">
                        <thead><tr>
                            <th>Боец</th><th class="num">Трофеи</th><th class="num">Победы</th>
                            <th class="num">Серия</th><th>Авто</th><th class="num">Цель</th><th></th>
                        </tr></thead>
                        <tbody>${rows || '<tr><td colspan="7" class="empty">Очередь пуста</td></tr>'}</tbody>
                    </table>
                </div>
            </div>

            <div class="card">
                <div class="card-head">
                    <div>
                        <h3 class="card-title">Добавить бойца</h3>
                        <p class="card-note">${pickable ? 'Выберите, кого добавить' : 'Все доступные бойцы уже в очереди'}</p>
                    </div>
                </div>
                <div class="card-body">
                    <div class="brawler-picker">${pickable || '<div class="empty">Добавлять нечего</div>'}</div>
                </div>
            </div>`;
    }

    document.addEventListener('click', async (event) => {
        const target = event.target;

        const add = target.closest('[data-add]');
        if (add) {
            pickedBrawlers.add(add.dataset.add);
            queueData.queue.push({
                brawler: add.dataset.add, trophies: 0, wins: 0,
                win_streak: 0, push_until: 1000, automatically_pick: true,
            });
            renderQueue();
            return;
        }

        const remove = target.closest('[data-remove]');
        if (remove) {
            const name = remove.dataset.remove;
            queueData.queue = queueData.queue.filter((e) => e.brawler !== name);
            pickedBrawlers.delete(name);
            renderQueue();
            return;
        }

        const up = target.closest('[data-up]');
        if (up) {
            const i = Number(up.dataset.up);
            if (i > 0) {
                const tmp = queueData.queue[i - 1];
                queueData.queue[i - 1] = queueData.queue[i];
                queueData.queue[i] = tmp;
                renderQueue();
            }
            return;
        }

        const down = target.closest('[data-down]');
        if (down) {
            const i = Number(down.dataset.down);
            if (i < queueData.queue.length - 1) {
                const tmp = queueData.queue[i + 1];
                queueData.queue[i + 1] = queueData.queue[i];
                queueData.queue[i] = tmp;
                renderQueue();
            }
            return;
        }

        if (target.id === 'saveQueue') {
            if (!settingsKey) {
                toast('Сначала подключите устройство', 'error');
                return;
            }
            try {
                // Пишем в маршрут устройства, откуда читали: глобальный
                // /api/queue в обычной работе остаётся пустым, и правки
                // оттуда просто исчезали бы.
                await api(`/api/devices/${encodeURIComponent(settingsKey)}/queue`, {
                    method: 'POST',
                    body: { items: queueData.queue },
                });
                toast('Очередь сохранена', 'ok');
                await loadQueue();
            } catch (error) {
                toast('Не удалось сохранить: ' + error.message, 'error');
            }
            return;
        }

        if (target.id === 'resetQueue') {
            await loadQueue();
            toast('Очередь перечитана с диска');
            return;
        }
    });

    document.addEventListener('change', async (event) => {
        const auto = event.target.closest('[data-auto]');
        if (!auto) return;
        const name = auto.dataset.auto;
        const entry = queueData.queue.find((e) => e.brawler === name);
        if (entry) {
            entry.automatically_pick = auto.checked;
            toast(`${auto.checked ? 'Добавлен' : 'Убран'} в автовыбор: ${name}`);
        }
    });

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
                const response = await fetch('/api/playstyles/import', {
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
        target_trophies: ['Цель по трофеям', 'Достигнув, бот остановится'],
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

    let settingsKey = '';
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