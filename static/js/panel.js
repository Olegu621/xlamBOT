/* xlamBOT multi-device control panel */
(function () {
    'use strict';

    const TOKEN = document.querySelector('meta[name="xlam-ui-token"]').content;
    const POLL_MS = 2000;
    const LOG_POLL_MS = 2500;
    // The preview is a still image of a match; it does not need 2 Hz. Gas and the
    // trophy rate change over minutes, so a slower preview is invisible and costs
    // one frame grab plus one JPEG encode less per cycle.
    const SNAPSHOT_POLL_MS = 5000;

    const grid = document.getElementById('deviceGrid');
    const noDevices = document.getElementById('noDevices');
    const deviceCountEl = document.getElementById('deviceCount');
    const runningCountEl = document.getElementById('runningCount');
    const toastEl = document.getElementById('toast');

    let devices = [];
    const liveByKey = {};
    let lastLogs = {};       // key -> last line count we rendered
    let lastLogText = {};    // key -> last log array (to avoid re-render churn)
    let expanded = {};       // key -> logs open?
    let cardKeys = '';       // signature of the rendered device set

    const STATE_LABELS = {
        idle: 'ожидает', running: 'работает', paused: 'пауза',
        pausing: 'пауза…', starting: 'старт…', stopping: 'стоп…', error: 'ошибка',
    };

    // What get_state() reports about the screen, in words. Falling through to the
    // raw string is fine, but "brawler_selection" tells an operator nothing.
    const GAME_STATE_LABELS = {
        lobby: 'лобби', match: 'матч', match_making: 'поиск матча',
        brawler_selection: 'выбор бойца', shop: 'магазин', popup: 'окно',
        connection_lost: 'нет связи', prestige_milestone: 'престиж',
        trophy_reward: 'награда', star_drop_regular: 'звёздное дропание',
        star_drop_angelic: 'звёздное дропание', star_drop_demonic: 'звёздное дропание',
        star_drop_starr_nova: 'звёздное дропание',
    };
    function gameStateLabel(state) {
        if (!state) return '—';
        if (GAME_STATE_LABELS[state]) return GAME_STATE_LABELS[state];
        if (/^end_/.test(state)) {
            const map = { 0: '1 место', 1: '2 место', 2: '3 место', 3: '4 место' };
            const tail = state.split('_').pop();
            return map[tail] !== undefined ? 'итоги: ' + map[tail] : 'итоги матча';
        }
        return state;
    }

    // A stuck video encoder is the quietest failure there is: the bot thread is
    // alive, the panel keeps polling, and the preview just quietly stops
    // changing. Surfacing the frame age turns it into something visible.
    const STALE_FRAME_SECONDS = 10;

    /* ------------------------------------------------------------------ api */
    async function api(path, options) {
        options = options || {};
        const headers = Object.assign({ 'X-Xlam-UI-Token': TOKEN }, options.headers || {});
        if (options.body !== undefined && typeof options.body !== 'string') {
            headers['Content-Type'] = 'application/json';
            options.body = JSON.stringify(options.body);
        }
        const response = await fetch(path, { method: options.method || 'GET', headers, body: options.body });
        const contentType = response.headers.get('content-type') || '';
        let payload = {};
        if (contentType.includes('application/json')) {
            payload = await response.json();
        }
        return { ok: response.ok, status: response.status, data: payload };
    }

    async function apiBlob(path) {
        const response = await fetch(path, { headers: { 'X-Xlam-UI-Token': TOKEN } });
        if (!response.ok) return null;
        return await response.blob();
    }

    let toastTimer = null;
    function toast(message, kind) {
        toastEl.textContent = message;
        toastEl.className = 'toast ' + (kind === 'error' ? 'is-error' : kind === 'ok' ? 'is-ok' : '');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 4200);
    }

    /* Окно подтверждения на нативном <dialog>: фокус заперт внутри, Escape
       закрывает, backdrop с размытием рисует сам браузер. Возвращает true,
       если подтвердили. Пока окно открыто,Escape и клик по фону его закрывают. */
    function askConfirm({ title, text, okLabel }) {
        const dialog = document.getElementById('confirmDialog');
        if (!dialog) return Promise.resolve(window.confirm(text || title));
        document.getElementById('confirmTitle').textContent = title || 'Подтвердите действие';
        document.getElementById('confirmText').textContent = text || '';
        document.getElementById('confirmOk').textContent = okLabel || 'Подтвердить';
        return new Promise((resolve) => {
            // close срабатывает и по кнопке, и по Escape, и по клику на фон.
            dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true });
            dialog.showModal();
        });
    }

    function plural(n) {
        const abs = Math.abs(n) % 100;
        const last = abs % 10;
        if (abs > 10 && abs < 20) return 'матчей';
        if (last === 1) return 'матч';
        if (last >= 2 && last <= 4) return 'матча';
        return 'матчей';
    }

    function escapeHtml(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function formatUptime(seconds) {
        if (!seconds && seconds !== 0) return '—';
        seconds = Math.floor(seconds);
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = seconds % 60;
        if (h) return `${h}ч ${m}м`;
        if (m) return `${m}м ${s}с`;
        return `${s}с`;
    }

    function formatMinutes(minutes) {
        const m = Number(minutes) || 0;
        if (m < 60) return `${Math.round(m)} мин`;
        const h = Math.floor(m / 60);
        const rest = Math.round(m % 60);
        return rest ? `${h}ч ${rest}м` : `${h}ч`;
    }

    /* ------------------------------------------------------------- rendering */
    function stateBadge(runtime) {
        const state = (runtime && runtime.state) || 'idle';
        return `<span class="badge badge-${escapeHtml(state)}">${STATE_LABELS[state] || escapeHtml(state)}</span>`;
    }

    function deviceCard(device) {
        const key = device.key;
        const runtime = device.runtime || {};
        const online = device.state === 'device';
        const status = online ? (runtime.state || 'idle') : 'offline';

        let cardClass = 'device-card';
        if (online && runtime.is_running) cardClass += ' is-running';
        if (status === 'error') cardClass += ' is-error';

        const running = !!runtime.is_running;
        const paused = runtime.state === 'paused' || runtime.state === 'pausing';

        const isRunning = online && running;
        const startDisabled = isRunning || !online;
        const pauseLabel = paused ? 'Продолжить' : 'Пауза';
        const pauseAction = paused ? 'resume' : 'pause';
        const pauseClass = paused ? 'btn-ok' : 'btn-warn';

        return `
        <article class="${cardClass}" data-key="${escapeHtml(key)}">
            <header class="device-head">
                <div class="device-id">
                    <span class="status-dot"></span>
                    <div>
                        <div class="device-name">
                            ${escapeHtml(device.model || 'Неизвестное устройство')}
                        </div>
                        <div class="device-serial">${escapeHtml(device.serial)}</div>
                    </div>
                </div>
                <div class="device-head-right">
                    <div class="device-meta">
                        <span>Android ${escapeHtml(device.android_version || '?')} · ${escapeHtml(device.resolution || 'разрешение ?')}</span>
                        <span class="${device.brawl_stars_running ? 'is-good' : 'is-bad'}">${device.brawl_stars_running ? 'BS запущена' : 'BS не запущена'}</span>
                        <span data-playstyle="${escapeHtml(key)}" hidden></span>
                    </div>
                    ${online ? stateBadge({ state: status }) : '<span class="badge badge-offline">офлайн</span>'}
                </div>
            </header>

            <div class="device-main">
                <div class="preview-wrap">
                    <img class="preview-img" data-preview="${escapeHtml(key)}" alt="Превью ${escapeHtml(device.serial)}">
                    <div class="preview-placeholder" data-placeholder="${escapeHtml(key)}">Превью при запуске</div>
                    <div class="preview-state" data-state="${escapeHtml(key)}">—</div>
                    <div class="preview-gas" data-gas="${escapeHtml(key)}"></div>
                </div>

                <div class="stat-grid" data-stats="${escapeHtml(key)}">
                    <div class="stat-box"><div class="stat-box-label">Боец</div><div class="stat-box-value">—</div></div>
                    <div class="stat-box"><div class="stat-box-label">Трофеи</div><div class="stat-box-value">—</div></div>
                    <div class="stat-box"><div class="stat-box-label">В час</div><div class="stat-box-value">—</div></div>
                    <div class="stat-box"><div class="stat-box-label">Ротация</div><div class="stat-box-value">—</div></div>
                    <div class="stat-box"><div class="stat-box-label">За матч</div><div class="stat-box-value">—</div></div>
                    <div class="stat-box"><div class="stat-box-label">Серия</div><div class="stat-box-value">—</div></div>
                    <div class="stat-box"><div class="stat-box-label">В работе</div><div class="stat-box-value">—</div></div>
                    <div class="stat-box gas-box"><div class="stat-box-label">Газ</div><div class="stat-box-value">—</div></div>
                </div>
            </div>

            <div class="device-body">
                ${device.mode_warning ? `<div class="warn-box">${escapeHtml(device.mode_warning)}</div>` : ''}
                ${runtime.last_error ? `<div class="error-box">${escapeHtml(runtime.last_error)}</div>` : ''}

                <div class="controls">
                    <button class="btn btn-primary" data-action="start" data-key="${escapeHtml(key)}" ${startDisabled ? 'disabled' : ''}>Старт</button>
                    <button class="btn ${pauseClass}" data-action="${pauseAction}" data-key="${escapeHtml(key)}" ${isRunning ? '' : 'disabled'}>${pauseLabel}</button>
                    <button class="btn btn-danger" data-action="stop" data-key="${escapeHtml(key)}" ${running ? '' : 'disabled'}>Стоп</button>
                </div>

                <div class="rotate-bar">
                    <div class="rotate-field">
                        <label class="rotate-label" for="switch-after-${escapeHtml(key)}">Смена</label>
                        <input id="switch-after-${escapeHtml(key)}" class="input rotate-input"
                               type="number" min="0" max="100" step="1" inputmode="numeric"
                               data-switch-input="${escapeHtml(key)}"
                               aria-describedby="switch-after-hint-${escapeHtml(key)}">
                        <span class="rotate-label">игр</span>
                    </div>
                    <div class="rotate-field">
                        <label class="rotate-label" for="sort-mode-${escapeHtml(key)}">Сортировка</label>
                        <select id="sort-mode-${escapeHtml(key)}" class="input rotate-select"
                                data-sort-mode="${escapeHtml(key)}">${SORT_MODE_OPTIONS}</select>
                    </div>
                    <button class="btn btn-sm btn-primary" type="button"
                            data-action="save-rotate" data-key="${escapeHtml(key)}">Применить</button>
                    <span class="rotate-hint" id="switch-after-hint-${escapeHtml(key)}"></span>
                    <span class="rotate-hint" id="sort-mode-hint-${escapeHtml(key)}"></span>
                </div>

                <div class="toggle-row">
                    <details class="disclosure" data-queue-details="${escapeHtml(key)}">
                        <summary>Очередь бойцов</summary>
                        <div class="section-title">Бойцы выбираются автоматически</div>
                        <div class="queue-list" data-queue="${escapeHtml(key)}">
                            <div class="queue-empty">Загрузка…</div>
                        </div>
                        <div class="auto-note">
                            Сортировка по минимальным трофеям,
                            <span data-switch-after="${escapeHtml(key)}">7</span> боёв на бойца, затем переключение.
                        </div>
                    </details>

                    <details class="disclosure" data-details="${escapeHtml(key)}" ${expanded[key] ? 'open' : ''}>
                        <summary>Логи</summary>
                        <div class="log-console" data-logs="${escapeHtml(key)}">—</div>
                        <div><button class="btn btn-sm btn-ghost" data-action="clear-logs" data-key="${escapeHtml(key)}">Очистить</button></div>
                    </details>
                </div>
            </div>
        </article>`;
    }

    function renderDevices() {
        deviceCountEl.textContent = devices.length;
        const live = devices.filter((d) => d.runtime && d.runtime.is_running).length;
        runningCountEl.textContent = live;
        const chip = document.getElementById('runningChip');
        if (chip) chip.classList.toggle('is-live', live > 0);

        if (!devices.length) {
            grid.innerHTML = '';
            cardKeys = '';
            noDevices.classList.remove('hidden');
            return;
        }
        noDevices.classList.add('hidden');

        // Only rebuild when the device set actually changes. Re-rendering every
        // poll would detach inputs, close dropdowns and lose focus.
        const signature = devices.map((d) => d.key).join('|');
        if (signature !== cardKeys) {
            cardKeys = signature;
            grid.innerHTML = devices.map(deviceCard).join('');
            devices.forEach((d) => {
                if (queues[d.key]) renderQueue(d.key, queues[d.key], liveByKey[d.key]);
                else loadQueue(d.key);
                if (lastLogText[d.key]) renderLogs(d.key, lastLogText[d.key]);
                applyStoredRotation(d.key);
            });
        }
        devices.forEach(updateCard);
    }

    /* Квота и сортировка хранятся в настройках устройства, а не в телеметрии.
       Раньше поля заполнялись только из телеметрии, поэтому у остановленного
       или упавшего бота «Смена» была пустой, а список сортировки - вовсе без
       вариантов. Настройки читаются независимо от состояния бота, так что
       поля показывают сохранённые значения всегда. */
    async function applyStoredRotation(key) {
        let settings = {};
        try {
            const { data } = await api(
                `/api/devices/${encodeURIComponent(key)}/settings`);
            settings = (data && data.settings) || {};
        } catch (err) {
            return;
        }
        const bot = settings.bot_config || {};
        const input = grid.querySelector(`[data-switch-input="${cssEscape(key)}"]`);
        if (input && document.activeElement !== input && bot.brawler_switch_after_games != null) {
            input.value = bot.brawler_switch_after_games;
            input.dataset.applied = String(bot.brawler_switch_after_games);
        }
        const select = grid.querySelector(`[data-sort-mode="${cssEscape(key)}"]`);
        if (select && document.activeElement !== select && bot.brawler_pick_mode) {
            select.value = bot.brawler_pick_mode;
            select.dataset.applied = bot.brawler_pick_mode;
        }
    }

    function updateCard(device) {
        const key = device.key;
        const card = grid.querySelector(`[data-key="${cssEscape(key)}"]`);
        if (!card) return;
        const online = device.state === 'device';
        const runtime = device.runtime || {};
        const status = online ? (runtime.state || 'idle') : 'offline';
        const running = !!runtime.is_running;
        const paused = runtime.state === 'paused' || runtime.state === 'pausing';

        card.className = 'device-card'
            + (online && running ? ' is-running' : '')
            + (status === 'error' ? ' is-error' : '');

        const badge = card.querySelector('.device-head .badge');
        if (badge) {
            badge.className = 'badge badge-' + (online ? escapeHtml(status) : 'offline');
            badge.textContent = online ? (STATE_LABELS[status] || status) : 'офлайн';
        }

        // The mode warning follows the settings, so it can change without the
        // device list changing. Update it in place instead of leaving whatever
        // was true when the card was first drawn.
        const warnSlot = card.querySelector('.device-body');
        if (warnSlot) {
            let warn = warnSlot.querySelector('.warn-box');
            const text = device.mode_warning || '';
            if (text && (!warn || warn.textContent !== text)) {
                if (!warn) {
                    warn = document.createElement('div');
                    warn.className = 'warn-box';
                    warnSlot.insertBefore(warn, warnSlot.firstChild);
                }
                warn.textContent = text;
            } else if (!text && warn) {
                warn.remove();
            }
        }

        const startBtn = card.querySelector('[data-action="start"]');
        const pauseBtn = card.querySelector('[data-action="pause"], [data-action="resume"]');
        const stopBtn = card.querySelector('[data-action="stop"]');
        if (startBtn) startBtn.disabled = running || !online;
        if (pauseBtn) {
            pauseBtn.disabled = !running;
            pauseBtn.textContent = paused ? 'Продолжить' : 'Пауза';
            pauseBtn.className = 'btn ' + (paused ? 'btn-ok' : 'btn-warn');
            pauseBtn.dataset.action = paused ? 'resume' : 'pause';
        }
        if (stopBtn) stopBtn.disabled = !running;

        let errorBox = card.querySelector('.error-box');
        if (runtime.last_error) {
            if (!errorBox) {
                errorBox = document.createElement('div');
                errorBox.className = 'error-box';
                const body = card.querySelector('.device-body');
                body.insertBefore(errorBox, body.firstChild);
            }
            errorBox.textContent = runtime.last_error;
        } else if (errorBox) {
            errorBox.remove();
        }
    }

    function gasSummary(gas) {
        if (!gas) return 'нет данных';
        // "выключен" reads like a setting the operator chose. It actually means
        // the detector is not loaded, which is a fault, not a preference.
        if (!gas.available) return 'детектор недоступен';
        if (!gas.boxes) return 'чисто';
        const share = Math.round((gas.coverage || 0) * 100);
        const danger = (gas.danger || 0) > 0;
        return `${gas.boxes} обл. · ${share}%${danger ? ' · ОПАСНО' : ''}`;
    }

    function gasNote(gas) {
        if (!gas || !gas.available) return '';
        const parts = [];
        if (gas.danger_escapes) parts.push(`выведен из опасного газа ${gas.danger_escapes} раз`);
        if (gas.escapes) parts.push(`обходов газа ${gas.escapes}`);
        return parts.join(' · ');
    }

    function gasTitle(gas) {
        if (!gas) return 'Данных о газе нет.';
        if (!gas.available) {
            return 'Детектор газа не загружен. Облака на карте он не видит, '
                + 'поэтому бот не может уходить из опасного газа.';
        }
        const lines = [
            `Облаков газа найдено: ${gas.boxes || 0}.`,
            `Доля тела игрока в газе: ${Math.round((gas.coverage || 0) * 100)}%.`,
        ];
        if (gas.danger) lines.push('Сейчас игрок внутри облака — это опасно.');
        if (gas.danger_escapes) lines.push(`Выведен из опасного газа: ${gas.danger_escapes} раз.`);
        if (gas.escapes) lines.push(`Всего обходов газа: ${gas.escapes}.`);
        return lines.join(' ');
    }

    // Each of these is a sort the game performs itself; the bot then takes the
    // first card. Named exactly as the menu does, so there is nothing to guess.
    const SORT_MODES = [
        { value: 'lowest_trophies', label: 'По минимальным трофеям' },
        { value: 'closest_to_rank', label: 'Ближе всех к новому рангу' },
        { value: 'lowest_level', label: 'По уровню (с низкого)' },
        { value: 'most_trophies', label: 'По максимальным трофеям' },
        { value: 'by_name', label: 'По имени' },
    ];

    // Варианты сортировки печатаем прямо в разметке карточки. Раньше они
    // добавлялись в renderTelemetry, и пока телеметрия не приходила, список
    // оставался пустым: у человека с упавшим ботом поле выглядело как
    // «сортировки нет», хотя сортировка настроена и работает.
    const SORT_MODE_OPTIONS = SORT_MODES
        .map((mode) => `<option value="${escapeHtml(mode.value)}">${escapeHtml(mode.label)}</option>`)
        .join('');

    function renderTelemetry(key, telemetry) {
        const live = { brawler: telemetry.brawler, trophies: telemetry.trophies };
        const previous = liveByKey[key];
        const changed = !previous || previous.brawler !== live.brawler
            || previous.trophies !== live.trophies;
        liveByKey[key] = live;
        // The queue row for the current brawler shows the live count, so it has to
        // be redrawn whenever that count moves — not only when the queue loads.
        if (changed && queues[key]) renderQueue(key, queues[key], live);
        const styleEl = grid.querySelector(`[data-playstyle="${cssEscape(key)}"]`);
        if (styleEl) {
            const style = telemetry.playstyle;
            // The playstyle decides how the brawler moves and fights, so which
            // one is loaded is worth seeing rather than having to open a file.
            styleEl.textContent = style ? String(style).replace(/\.xlambot$/, '') : '';
            styleEl.hidden = !style;
            styleEl.title = 'Файл плейстайла, который бот выполняет прямо сейчас. '
                + 'Именно он решает, как боец двигается и когда атакует.';
        }
        const stats = grid.querySelector(`[data-stats="${cssEscape(key)}"]`);
        const stateEl = grid.querySelector(`[data-state="${cssEscape(key)}"]`);
        if (stateEl) {
            const label = gameStateLabel(telemetry.detected_state);
            const age = telemetry.frame_age;
            const stale = typeof age === 'number' && age > STALE_FRAME_SECONDS;
            stateEl.textContent = stale
                ? `${label} · кадр застрял (${Math.round(age)} с)`
                : label;
            stateEl.className = 'preview-state' + (stale ? ' is-stale' : '')
                + (telemetry.detected_state === 'connection_lost' ? ' is-alert' : '');
            stateEl.title = stale
                ? `Последний кадр пришёл ${Math.round(age)} с назад. Поток видео, `
                  + 'скорее всего, завис: бот жив, но ничего не видит. '
                  + 'Помогает перезапуск бота.'
                : (telemetry.detected_state === 'connection_lost'
                    ? 'Игра потеряла связь с сервером и показывает окно с кнопкой '
                      + '«RETRY LOGIN». Бот закрывает его сам.'
                    : '');
        }
        const gasEl = grid.querySelector(`[data-gas="${cssEscape(key)}"]`);
        if (gasEl) {
            const gas = telemetry.gas;
            const danger = gas && gas.danger > 0;
            gasEl.className = 'preview-gas' + (gas && gas.boxes ? ' is-shown' : '')
                + (danger ? ' is-danger' : '');
            gasEl.textContent = gas && gas.boxes ? `газ ${gas.boxes} · ${Math.round((gas.coverage || 0) * 100)}%` : '';
        }
        if (!stats) return;
        // Between pressing Старт and the bot registering, the card showed six
        // dashes for a few seconds. That reads as "broken" rather than "starting".
        if (telemetry.has_instance === false && runtimeStateOf(key) === 'starting') {
            stats.innerHTML = '<div class="stat-box stat-box-wide">'
                + '<div class="stat-box-label">Состояние</div>'
                + '<div class="stat-box-value">инициализация…</div>'
                + '<div class="stat-box-note">Бот поднимается: подключается к устройству '
                + 'и ждёт первый кадр</div></div>';
            return;
        }
        // uptime_seconds changes on every poll, so caching on the whole telemetry
        // object never hit and the guard was decorative. Compare the fields that
        // actually move the numbers instead.
        const sig = [telemetry.brawler, telemetry.account_total, telemetry.trophies,
            telemetry.win_streak, telemetry.games_on_brawler, telemetry.next_brawler,
            telemetry.switch_after_games, telemetry.detected_state,
            (telemetry.trophy_rate || {}).rate_per_hour,
            (telemetry.recent_matches || {}).mean,
            JSON.stringify(telemetry.gas)].join('|');
        if (stats.dataset.sig === sig) return;
        stats.dataset.sig = sig;

        const accountTotal = telemetry.account_total != null ? telemetry.account_total : null;

        // Трофеи в час. Пока окно измерения короче 20 минут, скорость не
        // определена — показываем это, а не число из двух соседних отсчётов.
        const rate = telemetry.trophy_rate || {};
        let rateText = '—';
        let rateNote = '';
        let rateClass = '';
        let rateTitle = 'Трофеи в час по общему счёту — нужно минимум 20 минут наблюдения';
        if (rate.rate_per_hour != null) {
            const perHour = rate.rate_per_hour;
            const sign = perHour > 0 ? '+' : '';
            rateText = `${sign}${perHour}`;
            rateClass = perHour > 0 ? ' rate-up' : (perHour < 0 ? ' rate-down' : '');
            // The window is part of the number: "+647/ч" measured over 8 minutes
            // is not an hourly pace, so the span stays on screen.
            rateNote = `за ${formatMinutes(rate.measured_minutes)}`;
            rateTitle = `Трофеи в час по общему счёту: ${perHour} \u2014 измерено за ${rate.measured_minutes} мин `
                + `(прирост ${rate.gained >= 0 ? '+' : ''}${rate.gained}, окно ${rate.window_minutes} мин)`;
        } else if (rate.samples) {
            rateText = 'копится';
            rateNote = `${rate.samples} отсч.`;
            // Say why, with the actual span. The counter is only read when the
            // bot reaches the lobby, and on this server that can be rare, so a
            // missing rate has to be explainable rather than just "loading".
            const needed = rate.min_span_minutes || 20;
            rateTitle = rate.measured_minutes
                ? `Нужно ${needed} мин наблюдения, есть ${rate.measured_minutes} мин `
                  + `(${rate.samples} отсчётов). Счёт читается в лобби, поэтому отсчёты `
                  + `идут не каждый матч.`
                : `Нужно ${needed} мин наблюдения, отсчётов: ${rate.samples}`;
        }
        const switchEl = grid.querySelector(`[data-switch-after="${cssEscape(key)}"]`);
        const switchInput = grid.querySelector(`[data-switch-input="${cssEscape(key)}"]`);
        const switchHint = grid.querySelector(`#switch-after-hint-${cssEscape(key)}`);
        const sortSelect = grid.querySelector(`[data-sort-mode="${cssEscape(key)}"]`);
        const sortHint = grid.querySelector(`#sort-mode-hint-${cssEscape(key)}`);
        if (sortSelect && !sortSelect.options.length) {
            SORT_MODES.forEach((mode) => {
                const option = document.createElement('option');
                option.value = mode.value;
                option.textContent = mode.label;
                sortSelect.appendChild(option);
            });
        }
        if (sortSelect && telemetry.brawler_sort_mode) {
            if (document.activeElement !== sortSelect) {
                sortSelect.value = telemetry.brawler_sort_mode;
                sortSelect.dataset.applied = telemetry.brawler_sort_mode;
            }
            const current = SORT_MODES.find((m) => m.value === sortSelect.value);
            const pending = sortSelect.value !== telemetry.brawler_sort_mode;
            if (sortHint) {
                sortHint.textContent = pending
                    ? 'не применено'
                    : (current ? current.label.toLowerCase() : '');
                sortHint.className = 'rotate-hint' + (pending ? ' is-pending' : '');
            }
        }
        if (switchEl && telemetry.switch_after_games != null) {
            switchEl.textContent = telemetry.switch_after_games;
            if (switchInput && document.activeElement !== switchInput) {
                // Don't fight the operator mid-typing.
                switchInput.value = telemetry.switch_after_games;
                switchInput.dataset.applied = telemetry.switch_after_games;
            }
            if (switchHint) {
                const done = telemetry.games_on_brawler || 0;
                // The proof of the last rotation used to be written into this same
                // span, which meant it replaced the live "played N of 7" count
                // instead of sitting beside it. Two facts, two lines.
                const count = !telemetry.switch_after_games
                    ? 'смена отключена'
                    : (done >= telemetry.switch_after_games
                        ? `квота взята (${done}), смена в следующем матче`
                        : `отыграно ${done} из ${telemetry.switch_after_games}`);
                switchHint.textContent = (switchHint.dataset.base || count);
                switchHint.className = 'rotate-hint'
                    + (switchInput && String(switchInput.value)
                        !== String(telemetry.switch_after_games) ? ' is-pending' : '');
            }
        }

        const switchAfter = telemetry.switch_after_games;
        let perMatchClass = '';
        let rotationText = '—';
        let rotationNote = '';
        let rotationTitle = 'Сколько игр бот планирует отыграть на одном бойце до переключения.';
        if (telemetry.brawler) {
            if (switchAfter) {
                const done = telemetry.games_on_brawler || 0;
                rotationText = `${done}/${switchAfter}`;
                rotationTitle = `Отыграно ${done} из ${switchAfter} игр на бойце `
                    + `${telemetry.brawler}, затем бот переключится.`;
                if (telemetry.next_brawler && telemetry.next_brawler !== telemetry.brawler) {
                    rotationNote = `далее ${telemetry.next_brawler}`;
                    rotationTitle += ` Следующий боец: ${telemetry.next_brawler}.`;
                }
            } else {
                rotationText = 'нет';
                rotationTitle = 'Смена бойца отключена: бот играет на одном бойце, пока не выключат.';
            }
        }

        // Proof of the last rotation. The brawler tile alone cannot tell a real
        // switch from a stale name, which is what made "the brawler never
        // changes" believable when it had in fact happened.
        const lastSwitch = telemetry.last_switch;
        if (lastSwitch && lastSwitch.from !== lastSwitch.to) {
            const sortLabel = (SORT_MODES.find((m) => m.value === lastSwitch.sort_mode) || {}).label
                || lastSwitch.sort_mode || 'по минимальным трофеям';
            if (lastSwitch.confirmed && lastSwitch.changed) {
                switchHint.textContent = `смена подтверждена: ${lastSwitch.from} → ${lastSwitch.to}`;
                switchHint.className = 'rotate-hint is-ok';
                switchHint.title = `Последняя ротация: ${lastSwitch.games} игр на `
                    + `${lastSwitch.from}, сортировка «${sortLabel}», `
                    + `игра выбрала ${lastSwitch.to}.`;
            } else if (!lastSwitch.confirmed) {
                switchHint.textContent = 'смена не подтверждена: имя не прочитано';
                switchHint.className = 'rotate-hint is-pending';
                switchHint.title = `После ${lastSwitch.games} игр на `
                    + `${lastSwitch.from || 'боеце'} бот открыл меню и выбрал первого `
                    + `бойца под сортировкой «${sortLabel}», но имя с карточки прочитать `
                    + `не удалось. Смена на экране произошла, подтвердить её нечем.`;
            } else {
                switchHint.textContent = `сортировка «${sortLabel}» снова дала ${lastSwitch.to}`;
                switchHint.className = 'rotate-hint';
                switchHint.title = `После ${lastSwitch.games} игр на `
                    + `${lastSwitch.to} сортировка «${sortLabel}» поставила его же `
                    + `первым, поэтому боец не сменился.`;
            }
        }

        const recent = telemetry.recent_matches;
        let perMatchText = '—';
        let perMatchNote = '';
        let perMatchTitle = 'Средняя дельта трофеев за последние матчи.';
        if (recent && recent.count) {
            const sign = recent.mean > 0 ? '+' : '';
            perMatchText = `${sign}${recent.mean}`;
            perMatchClass = recent.mean > 0 ? ' rate-up' : (recent.mean < 0 ? ' rate-down' : '');
            perMatchNote = `за ${recent.count}`;
            perMatchTitle = `Трофеев за матч: среднее ${recent.mean}, `
                + `медиана ${recent.median} по последним ${recent.count} матчам; `
                + `плюс в ${recent.positive} из них. `
                + `Медиана показана рядом со средним, потому что одно `
                + `испорченное значение способно переврать среднее.`;
        } else {
            perMatchClass = '';
        }

        stats.innerHTML = `
            <div class="stat-box" title="Боец, выбранный в игре. Берётся с экрана выбора, а не из очереди панели.">
                <div class="stat-box-label">Боец</div>
                <div class="stat-box-value">${escapeHtml(telemetry.brawler || 'неизвестно')}</div>
                ${telemetry.trophies != null ? `<div class="stat-box-note">${telemetry.trophies} трофеев у бойца</div>` : ''}
            </div>
            <div class="stat-box" title="Общий счёт трофеев аккаунта, как его показывает лобби. Он не сбрасывается при смене бойца, поэтому именно по нему считается темп «в час».">
                <div class="stat-box-label">Трофеи</div>
                <div class="stat-box-value">${accountTotal != null ? accountTotal : '—'}</div>
            </div>
            <div class="stat-box${rateClass}" title="${escapeHtml(rateTitle)}">
                <div class="stat-box-label">В час</div>
                <div class="stat-box-value">${rateText}</div>
                ${rateNote ? `<div class="stat-box-note">${escapeHtml(rateNote)}</div>` : ''}
            </div>
            <div class="stat-box" title="${escapeHtml(rotationTitle)}">
                <div class="stat-box-label">Ротация</div>
                <div class="stat-box-value">${rotationText}</div>
                ${rotationNote ? `<div class="stat-box-note">${escapeHtml(rotationNote)}</div>` : ''}
            </div>
            <div class="stat-box${perMatchClass}" title="${escapeHtml(perMatchTitle)}">
                <div class="stat-box-label">За матч</div>
                <div class="stat-box-value">${perMatchText}</div>
                ${perMatchNote ? `<div class="stat-box-note">${escapeHtml(perMatchNote)}</div>` : ''}
            </div>
            <div class="stat-box" title="Текущая серия побед на этом бойце. Каждая победа в серии добавляет трофеи сверх базовых, а смена бойца серию обнуляет.">
                <div class="stat-box-label">Серия</div>
                <div class="stat-box-value">${telemetry.win_streak != null ? telemetry.win_streak : '—'}</div>
            </div>
            <div class="stat-box">
                <div class="stat-box-label">В работе</div>
                <div class="stat-box-value">${formatUptime(telemetry.uptime_seconds)}</div>
            </div>
            <div class="stat-box gas-box${(telemetry.gas && telemetry.gas.danger > 0) ? ' is-danger' : ''}" title="${escapeHtml(gasTitle(telemetry.gas))}">
                <div class="stat-box-label">Газ</div>
                <div class="stat-box-value">${gasSummary(telemetry.gas)}</div>
                ${gasNote(telemetry.gas) ? `<div class="stat-box-note">${escapeHtml(gasNote(telemetry.gas))}</div>` : ''}
            </div>`;
    }

    function renderQueue(key, items, live) {
        const container = grid.querySelector(`[data-queue="${cssEscape(key)}"]`);
        if (!container) return;
        const signature = JSON.stringify([items || [], live || null]);
        if (container.dataset.sig === signature) return;
        container.dataset.sig = signature;
        if (!items || !items.length) {
            container.innerHTML = '<div class="queue-empty">Очередь пуста — бот подберёт бойцов сам.</div>';
            return;
        }
        container.innerHTML = items.map((item, index) => {
            const matches = String(item.brawler).toLowerCase() === String((live && live.brawler) || '').toLowerCase();
            // The badge used to hang off index === 0 while isLive was computed
            // and thrown away. The game sorts the whole roster by least trophies,
            // so the brawler actually being played is regularly not the one our
            // queue put first, and the panel named the wrong row as "сейчас".
            const isLive = !!live && matches;
            const isFirst = index === 0;
            const current = (isLive && live.trophies != null) ? live.trophies : (item.trophies || 0);
            return `
            <div class="queue-item${isLive ? ' is-current' : ''}">
                <img class="queue-item-icon" src="/api/assets/brawlers/${encodeURIComponent(item.brawler)}" alt=""
                     onerror="this.style.visibility='hidden'">
                <div class="queue-item-body">
                    <div class="queue-item-name">${escapeHtml(item.brawler)}</div>
                    <div class="queue-item-target">${current} трофеев</div>
                </div>
                ${isLive ? '<span class="badge badge-running">сейчас</span>' : ''}
            </div>`;
        }).join('');
    }

    function renderLogs(key, logs) {
        const box = grid.querySelector(`[data-logs="${cssEscape(key)}"]`);
        if (!box) return;
        if (!logs.length) { box.textContent = 'Логов пока нет.'; return; }
        const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
        box.innerHTML = logs.map((line) => {
            const cls = /error|failed|exception|traceback/i.test(line) ? 'log-error'
                : /warn|retry|reconnect|stale/i.test(line) ? 'log-warn' : '';
            return `<div class="${cls}">${escapeHtml(line)}</div>`;
        }).join('');
        if (atBottom) box.scrollTop = box.scrollHeight;
    }

    function cssEscape(value) {
        return String(value).replace(/["\\]/g, '\\$&');
    }

    /* ------------------------------------------------------------- data load */
    async function loadDevices() {
        const { data } = await api('/api/devices');
        if (data && Array.isArray(data.devices)) {
            devices = data.devices;
            renderDevices();
        }
        return devices;
    }

    async function loadBrawlers() {
        const { data } = await api('/api/devices/brawlers');
    }

    const queues = {};
    async function loadQueue(key) {
        const { data } = await api(`/api/devices/${encodeURIComponent(key)}/queue`);
        if (data && Array.isArray(data.items)) {
            queues[key] = data.items;
            renderQueue(key, data.items);
        }
        return queues[key] || [];
    }

    function runtimeStateOf(key) {
        const found = devices.find((d) => d.key === key);
        return (found && found.runtime && found.runtime.state) || '';
    }

    async function loadTelemetry() {
        await Promise.all(devices.map(async (device) => {
            const runtime = device.runtime;
            if (!runtime) return;
            // While the worker is still starting, is_running is false, so the
            // device used to be skipped and the card sat on six dashes until the
            // bot finished coming up - which reads as broken, not as starting.
            if (!runtime.is_running && runtime.state !== 'starting') return;
            const { data } = await api(`/api/devices/${encodeURIComponent(device.key)}/telemetry`);
            if (data && data.telemetry) renderTelemetry(device.key, data.telemetry);
        }));
    }

    const snapshotUrls = {};
    const snapshotBusy = {};

    async function loadSnapshots() {
        await Promise.all(devices.map(async (device) => {
            if (!device.runtime || !device.runtime.is_running) return;
            const key = device.key;
            // Without this guard a slow JPEG encode stacks a second request
            // behind the first, and they pile up faster than they finish. The
            // preview keeps working off the last frame meanwhile, so dropping a
            // cycle costs nothing.
            if (snapshotBusy[key]) return;
            snapshotBusy[key] = true;
            try {
                const blob = await apiBlob(`/api/devices/${encodeURIComponent(key)}/snapshot`);
                const img = grid.querySelector(`[data-preview="${cssEscape(key)}"]`);
                const placeholder = grid.querySelector(`[data-placeholder="${cssEscape(key)}"]`);
                if (!img || !blob) return;
                if (snapshotUrls[key]) URL.revokeObjectURL(snapshotUrls[key]);
                snapshotUrls[key] = URL.createObjectURL(blob);
                img.src = snapshotUrls[key];
                img.style.display = 'block';
                if (placeholder) placeholder.style.display = 'none';
            } finally {
                snapshotBusy[key] = false;
            }
        }));
    }

    async function loadLogs() {
        // Only poll devices whose log panel is actually open, so an unattended
        // multi-hour run does not hammer the API for logs nobody reads.
        const open = devices.filter((d) => expanded[d.key]);
        if (!open.length) return;
        await Promise.all(open.map(async (device) => {
            const key = device.key;
            const { data } = await api(`/api/devices/${encodeURIComponent(key)}/logs?limit=250`);
            if (data && Array.isArray(data.logs)) {
                lastLogText[key] = data.logs;
                if (expanded[key]) renderLogs(key, data.logs);
            }
        }));
    }

    /* ---------------------------------------------------------------- events */
    grid.addEventListener('click', async (event) => {
        const button = event.target.closest('[data-action]');
        if (!button) return;
        const key = button.dataset.key;
        const action = button.dataset.action;
        if (!key) return;

        // Пока запрос уходит, кнопка не берёт повторный клик. Для «Старт» это
        // ещё и защита от двух ботов на одном устройстве.
        button.classList.add('is-busy');

        try {
            if (action === 'start' || action === 'stop' || action === 'pause' || action === 'resume') {
                button.disabled = true;
                const { data } = await api(`/api/devices/${encodeURIComponent(key)}/${action}`, { method: 'POST' });
                if (data && data.message) toast(data.message, data.ok ? 'ok' : 'error');
                await loadDevices();
                if (action === 'start') await loadQueue(key);
            } else if (action === 'save-rotate') {
                // One button for the whole row. Applies only what actually
                // changed, so a stray click cannot rewrite the other setting.
                const input = grid.querySelector(`[data-switch-input="${cssEscape(key)}"]`);
                const select = grid.querySelector(`[data-sort-mode="${cssEscape(key)}"]`);
                const wantGames = input && String(input.value) !== String(input.dataset.applied);
                const wantSort = select && String(select.value) !== String(select.dataset.applied);
                if (!wantGames && !wantSort) {
                    toast('Нечего применять: настройки не изменились');
                    return;
                }
                const values = {};
                if (wantGames) {
                    const raw = input.value.trim();
                    const value = Number(raw);
                    if (raw === '' || !Number.isFinite(value) || !Number.isInteger(value)
                        || value < 0 || value > 100) {
                        toast('Нужно целое число от 0 до 100. 0 — не менять бойца.', 'error');
                        input.focus();
                        return;
                    }
                    values.brawler_switch_after_games = value;
                }
                if (wantSort && !SORT_MODES.some((m) => m.value === select.value)) {
                    toast('Такого режима сортировки нет', 'error');
                    return;
                }
                if (wantSort) values.brawler_pick_mode = select.value;
                const { ok } = await api(
                    `/api/devices/${encodeURIComponent(key)}/settings`,
                    {
                        method: 'POST',
                        body: { section: 'cfg/bot_config.toml', values },
                    });
                if (!ok) {
                    toast('Не удалось сохранить', 'error');
                    return;
                }
                const parts = [];
                if (wantGames) {
                    input.dataset.applied = String(values.brawler_switch_after_games);
                    const n = values.brawler_switch_after_games;
                    parts.push(n === 0
                        ? 'смена бойца отключена'
                        : `${n} ${plural(n)} на бойца`);
                }
                if (wantSort) {
                    select.dataset.applied = select.value;
                    const label = (SORT_MODES.find((m) => m.value === select.value) || {}).label
                        || select.value;
                    parts.push(`сортировка: ${label.toLowerCase()}`);
                }
                toast(parts.join(' · ') + ' — применится со следующего матча', 'ok');
                await loadTelemetry();
            } else if (action === 'clear-logs') {
                // Логи не восстановить, поэтому спрашиваем. Раньше здесь стоял
                // системный confirm(): выглядел он не как остальная панель.
                const ok = await askConfirm({
                    title: 'Очистить логи?',
                    text: `Логи устройства ${key} будут удалены безвозвратно.`,
                    okLabel: 'Очистить',
                });
                if (!ok) return;
                await api(`/api/devices/${encodeURIComponent(key)}/logs`, { method: 'DELETE' });
                lastLogText[key] = [];
                renderLogs(key, []);
                toast('Логи очищены', 'ok');
            }
        } catch (error) {
            toast('Ошибка: ' + error.message, 'error');
        } finally {
            // Кнопка отпускается в любом случае: и когда запрос прошёл, и когда
            // упал, и когда пользователь передумал в окне подтверждения.
            button.classList.remove('is-busy');
        }
    });

    grid.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        const input = event.target.closest('[data-switch-input]');
        const select = event.target.closest('[data-sort-mode]');
        if (!input && !select) return;
        event.preventDefault();
        const key = (input || select).dataset.switchInput || (select || input).dataset.sortMode;
        const button = grid.querySelector(
            `[data-action="save-rotate"][data-key="${cssEscape(key)}"]`);
        if (button) button.click();
    });

    grid.addEventListener('toggle', (event) => {
        const details = event.target.closest('details[data-details]');
        if (!details) return;
        const key = details.dataset.details;
        const wasOpen = !!expanded[key];
        expanded[key] = details.open;
        if (details.open) {
            renderLogs(key, lastLogText[key] || []);
            const box = grid.querySelector(`[data-logs="${cssEscape(key)}"]`);
            if (box) box.scrollTop = box.scrollHeight;
            if (!wasOpen) loadLogs();
        }
    }, true);

    document.getElementById('refreshBtn').addEventListener('click', async () => {
        await loadDevices();
        for (const device of devices) await loadQueue(device.key);
        toast('Обновлено', 'ok');
    });

    document.getElementById('startAllBtn').addEventListener('click', async () => {
        for (const device of devices) {
            if (device.state !== 'device') continue;
            const { data } = await api(`/api/devices/${encodeURIComponent(device.key)}/start`, { method: 'POST' });
            if (data && !data.ok && data.message) toast(data.message, 'error');
        }
        await loadDevices();
        for (const device of devices) await loadQueue(device.key);
    });

    document.getElementById('stopAllBtn').addEventListener('click', async () => {
        const { data } = await api('/api/devices/stop-all', { method: 'POST' });
        if (data && data.message) toast(data.message, 'ok');
        await loadDevices();
    });

    document.getElementById('connectBtn').addEventListener('click', async () => {
        const address = document.getElementById('connectAddress').value.trim();
        if (!address) { toast('Укажите адрес, например 127.0.0.1:5555', 'error'); return; }
        const { data } = await api('/api/devices/connect', { method: 'POST', body: { address } });
        if (data && data.message) toast(data.message, data.ok ? 'ok' : 'error');
        setTimeout(loadDevices, 800);
    });

    document.getElementById('disconnectBtn').addEventListener('click', async () => {
        const address = document.getElementById('connectAddress').value.trim();
        if (!address) { toast('Укажите адрес для отключения', 'error'); return; }
        const { data } = await api('/api/devices/disconnect', { method: 'POST', body: { address } });
        if (data && data.message) toast(data.message, data.ok ? 'ok' : 'error');
        setTimeout(loadDevices, 800);
    });

    /* ------------------------------------------------------------------ loop */
    let lastPollOk = 0;

    async function cycle() {
        try {
            await loadDevices();
            // Telemetry first, snapshots on a timer of their own: a snapshot is
            // a frame grab plus a JPEG encode, and awaiting it inline meant the
            // telemetry cadence was really "encode time + POLL_MS", which on one
            // emulator is already past the two seconds the constant promises.
            await loadTelemetry();
            lastPollOk = Date.now();
        } catch (error) {
            console.error('panel poll failed', error);
        }
    }

    async function snapshotCycle() {
        try {
            await loadSnapshots();
        } catch (error) {
            console.error('panel snapshot failed', error);
        }
    }

    // A dead API used to freeze the panel on stale numbers with no hint at all:
    // the card simply stopped changing and still looked perfectly healthy.
    setInterval(() => {
        const age = Math.round((Date.now() - lastPollOk) / 1000);
        const dead = lastPollOk > 0 && age > 8;
        document.querySelectorAll('.device-card').forEach((card) => {
            card.classList.toggle('is-stale', dead);
        });
        const badge = document.getElementById('pollAge');
        if (badge) {
            badge.textContent = lastPollOk ? `обновлено ${age} с назад` : 'нет связи';
            badge.className = 'poll-age' + (dead ? ' is-dead' : '');
        }
    }, 1000);

    async function init() {
        await loadBrawlers();
        await loadDevices();
        for (const device of devices) await loadQueue(device.key);
        setInterval(cycle, POLL_MS);
        setInterval(snapshotCycle, SNAPSHOT_POLL_MS);
        setInterval(loadLogs, LOG_POLL_MS);
    }

    init();
})();
