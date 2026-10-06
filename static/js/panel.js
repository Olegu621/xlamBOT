/* xlamBOT multi-device control panel */
(function () {
    'use strict';

    const TOKEN = document.querySelector('meta[name="xlam-ui-token"]').content;
    const POLL_MS = 2000;
    const LOG_POLL_MS = 2500;
    // Only the wait before the first picture: from then on the server sends back
    // the refresh rate it is actually enforcing (preview_interval_ms in the
    // settings), so this is a starting guess rather than the setting itself.
    const SNAPSHOT_POLL_MS = 800;

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
    const THINKING_LEVELS = ['low', 'standard', 'medium', 'high', 'maximum'];
    const thinkingByKey = {};
    function thinkingLabels() {
        return window.XlamI18n?.language === 'en'
            ? ['Low', 'Standard', 'Medium', 'High', 'Maximum']
            : ['Низкий', 'Стандарт', 'Средний', 'Высокий', 'Максимальный'];
    }
    function renderThinking(key, preview) {
        const widget = grid.querySelector(`[data-thinking-control="${cssEscape(key)}"]`);
        if (!widget) return;
        const state = thinkingByKey[key] || {};
        const slider = widget.querySelector('input');
        const index = THINKING_LEVELS.indexOf(preview || state.saved || 'medium');
        const en = window.XlamI18n?.language === 'en';
        const labels = thinkingLabels();
        slider.value = index;
        slider.disabled = !state.saved || !!state.busy;
        slider.setAttribute('aria-label', en ? 'Thinking level' : 'Уровень думалки');
        slider.setAttribute('aria-valuetext', labels[index]);
        widget.style.setProperty('--thinking-fill', `${index / (THINKING_LEVELS.length - 1) * 100}%`);
        widget.querySelector('[data-thinking-label]').textContent = labels[index];
        widget.querySelector('[data-thinking-caption]').textContent = en ? 'Thinking depth' : 'Глубина анализа';
        const thought = state.thought || {};
        const recommendation = thought.active === state.saved && THINKING_LEVELS.includes(thought.recommended)
            ? labels[THINKING_LEVELS.indexOf(thought.recommended)] : (en ? 'measuring in battle…' : 'измеряю в бою…');
        widget.querySelector('[data-thinking-note]').textContent = state.busy
            ? (en ? 'Saving…' : 'Сохраняю…')
            : `${en ? 'Recommended' : 'Рекомендую'}: ${recommendation}`;
        widget.querySelector('[data-thinking-reset]').disabled = !state.saved || !!state.busy || state.saved === 'standard';
        widget.querySelector('[data-thinking-reset]').title = en ? 'Restore original thinking for this device' : 'Вернуть стандартную думалку для этого устройства';
        widget.querySelector('[data-thinking-reset]').setAttribute('aria-label', en ? 'Restore original thinking for this device' : 'Вернуть стандартную думалку для этого устройства');
        widget.querySelectorAll('[data-thinking-stop]').forEach((dot, i) => {
            dot.classList.toggle('is-selected', i === index);
            dot.title = labels[i];
        });
    }
    async function saveThinking(key, level) {
        const state = thinkingByKey[key];
        if (!state || state.busy || !THINKING_LEVELS.includes(level)) return;
        if (level === state.saved) { renderThinking(key); return; }
        state.busy = true;
        renderThinking(key, level);
        try {
            const result = await api(`/api/devices/${encodeURIComponent(key)}/settings`, {
                method: 'POST', body: {section: 'cfg/general_config.toml', values: {thinking_mode: level}},
            });
            if (!result.ok || !result.data.ok) throw new Error(result.data.message || (window.XlamI18n?.language === 'en' ? 'Could not save thinking level' : 'Не удалось сохранить уровень думалки'));
            state.saved = level;
        } catch (error) { toast(error.message, 'error'); }
        finally { state.busy = false; renderThinking(key); }
    }
    grid.addEventListener('input', event => {
        if (event.target.matches('[data-thinking-slider]'))
            renderThinking(event.target.dataset.thinkingSlider, THINKING_LEVELS[Number(event.target.value)]);
    });
    grid.addEventListener('change', event => {
        if (event.target.matches('[data-thinking-slider]'))
            saveThinking(event.target.dataset.thinkingSlider, THINKING_LEVELS[Number(event.target.value)]);
    });
    grid.addEventListener('click', event => {
        const reset = event.target.closest('[data-thinking-reset]');
        if (reset) saveThinking(reset.dataset.thinkingReset, 'standard');
    });
    window.addEventListener('xlam-language-changed', () => devices.forEach(d => renderThinking(d.key)));

    const STATE_LABELS = {
        idle: 'ожидает', running: 'работает', paused: 'пауза',
        pausing: 'пауза…', starting: 'старт…', stopping: 'стоп…', error: 'ошибка',
    };

    // What get_state() reports about the screen, in words. Falling through to the
    // raw string is fine, but "brawler_selection" tells an operator nothing.
    const GAME_STATE_LABELS = {
        lobby: 'лобби', match: 'матч', match_making: 'поиск матча',
        brawler_selection: 'выбор бойца', brawler_choice: 'выбор награды', shop: 'магазин', popup: 'окно',
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
        const response = await window.XlamSession.fetch(path, { method: options.method || 'GET', headers, body: options.body });
        const contentType = response.headers.get('content-type') || '';
        let payload = {};
        if (contentType.includes('application/json')) {
            payload = await response.json();
        }
        return { ok: response.ok, status: response.status, data: payload };
    }

    async function apiBlob(path) {
        const response = await window.XlamSession.fetch(path, { headers: { 'X-Xlam-UI-Token': TOKEN } });
        if (!response.ok) return null;
        return { blob: await response.blob(), headers: response.headers };
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
                            ${escapeHtml(device.display_name || device.model || 'Неизвестное устройство')}
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

            <div class="live-diagnostics" data-diagnostics="${escapeHtml(key)}"></div>
            <section class="thinking-control" data-thinking-control="${escapeHtml(key)}">
                <div class="thinking-head"><span class="thinking-bolt" aria-hidden="true">ϟ</span>
                    <div><span class="thinking-level" data-thinking-label>Средний</span><span class="thinking-caption" data-thinking-caption>Глубина анализа</span></div>
                    <button type="button" class="thinking-reset" data-thinking-reset="${escapeHtml(key)}" title="Вернуть стандартную думалку для этого устройства" aria-label="Вернуть стандартную думалку для этого устройства" disabled>↺</button>
                </div>
                <div class="thinking-track"><div class="thinking-stops" aria-hidden="true">${THINKING_LEVELS.map(() => '<span data-thinking-stop></span>').join('')}</div>
                    <input type="range" min="0" max="${THINKING_LEVELS.length - 1}" step="1" value="2" data-thinking-slider="${escapeHtml(key)}" aria-label="Уровень думалки" disabled>
                </div>
                <p class="thinking-note" data-thinking-note>Рекомендация появится во время боя</p>
            </section>
            <details class="observation-report"><summary>Разбор наблюдения</summary><pre data-observation="${escapeHtml(key)}"></pre><button class="btn btn-ghost" type="button" data-replay="${escapeHtml(key)}">Повторный анализ без управления</button><pre data-replay-result="${escapeHtml(key)}" hidden></pre><div class="audit-controls"><label>Матчей для аудита <input type="number" min="1" max="100" value="10" data-audit-count="${escapeHtml(key)}"></label><button class="btn btn-ghost" data-audit="start" data-key="${escapeHtml(key)}">Начать аудит</button><button class="btn btn-ghost" data-audit="stop" data-key="${escapeHtml(key)}">Остановить аудит</button><button class="btn btn-ghost" data-audit="export" data-key="${escapeHtml(key)}">Скачать аудит</button></div><p class="muted">Аудит сохраняет кадры и причины смерти локально. Дополнительный анализ использует GPU и может снизить FPS.</p><pre data-audit-status="${escapeHtml(key)}"></pre></details>
            <div class="device-body">
                ${device.mode_warning ? `<div class="warn-box">${escapeHtml(device.mode_warning)}</div>` : ''}
                ${device.gas_warning ? `<div class="warn-box">${escapeHtml(device.gas_warning)}</div>` : ''}
                ${runtime.last_error ? `<div class="error-box">${escapeHtml(runtime.last_error)}</div>` : ''}

                <div class="controls">
                    <a class="btn btn-ghost" href="/calibration/${encodeURIComponent(key)}">Калибровка бойцов</a>
                    <button class="btn btn-primary" data-action="start" data-key="${escapeHtml(key)}" ${startDisabled ? 'disabled' : ''}><svg class="ui-icon" aria-hidden="true"><use href="#icon-player-play"/></svg>Старт</button>
                    <button class="btn ${pauseClass}" data-action="${pauseAction}" data-key="${escapeHtml(key)}" ${isRunning ? '' : 'disabled'}>${pauseLabel}</button>
                    <button class="btn btn-danger" data-action="stop" data-key="${escapeHtml(key)}" ${running ? '' : 'disabled'}>Стоп</button>
                    <button class="btn btn-train" data-action="training" data-key="${escapeHtml(key)}"
                            title="Записать матч и потом разметить кадры">Обучение</button>
                </div>

                <div class="training-row" data-training-row="${escapeHtml(key)}">
                    <label class="training-count">
                        кадров
                        <input class="input training-count-input" type="number" min="1" max="400"
                               step="1" value="10" data-training-count="${escapeHtml(key)}"
                               title="Сколько кадров оставить из матча — они размажутся по всему матчу">
                    </label>
                    <span class="training-note" data-training-note="${escapeHtml(key)}"></span>
                    <a class="btn btn-sm btn-ghost hidden" data-training-open="${escapeHtml(key)}"
                       href="#" target="_blank" rel="noreferrer">Разметить</a>
                    <button class="btn btn-sm btn-ghost hidden" data-action="training-stop"
                            data-key="${escapeHtml(key)}">Прервать</button>
                </div>

                <div class="rotate-bar" data-rotate-bar="${escapeHtml(key)}">
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
                    <details class="disclosure" data-brawler-details="${escapeHtml(key)}">
                        <summary>Бойцы · ручной выбор</summary>
                        <div class="section-title" data-brawler-title="${escapeHtml(key)}">Загрузка…</div>
                        <div class="brawler-grid" data-brawler-grid="${escapeHtml(key)}">
                            <div class="queue-empty">Загрузка…</div>
                        </div>
                        <div class="auto-note">
                            Нажмите на бойца — бот будет играть только на нём.
                            <button class="btn btn-sm btn-ghost" type="button"
                                    data-action="unlock-brawler" data-key="${escapeHtml(key)}">
                                Отпустить, выбирать автоматически</button>
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
                renderBrawlerGrid(d.key);
                if (lastLogText[d.key]) renderLogs(d.key, lastLogText[d.key]);
                applyStoredRotation(d.key);
            });
            // Fetched after the cards exist so the grid has somewhere to draw.
            devices.forEach((d) => applyLockedBrawler(d.key));
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
        const saved = settings.general_config?.thinking_mode || 'medium';
        const thoughtState = thinkingByKey[key] || (thinkingByKey[key] = {});
        if (!thoughtState.busy) thoughtState.saved = THINKING_LEVELS.includes(saved) ? saved : 'medium';
        renderThinking(key);
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
        const report = grid.querySelector(`[data-observation="${cssEscape(key)}"]`);
        if (report) {
            const en = window.XlamI18n?.language === 'en';
            const state = {state:telemetry.detected_state, movement:telemetry.movement, motion:telemetry.motion_state, latency_ms:telemetry.latency, life:telemetry.life};
            report.textContent = JSON.stringify(state, null, 2);
        }
        const diagnostics = grid.querySelector(`[data-diagnostics="${cssEscape(key)}"]`);
        if (diagnostics) {
            const en = window.XlamI18n?.language === 'en';
            const fps = Number.isFinite(telemetry.fps) ? telemetry.fps.toFixed(1) : '—';
            const capture = Number.isFinite(telemetry.capture_fps) ? telemetry.capture_fps.toFixed(1) : '—';
            const providers = Object.values(telemetry.providers || {});
            const gpu = providers.length ? providers.every(p => p.includes('CPU')) ? 'CPU' : providers.some(p => p.includes('CPU')) ? 'GPU + CPU' : 'GPU' : '—';
            const life = telemetry.life || {};
            const thoughtState = thinkingByKey[key] || (thinkingByKey[key] = {});
            thoughtState.thought = telemetry.thinking || {};
            const slider = grid.querySelector(`[data-thinking-slider="${cssEscape(key)}"]`);
            if (!slider || document.activeElement !== slider) renderThinking(key);
            diagnostics.textContent = `${gpu} · ${fps} FPS · ${en ? 'capture' : 'захват'} ${capture} FPS · ${en ? 'gas vetoes' : 'обходов газа'} ${telemetry.gas?.prevented_entries || 0}`;
            diagnostics.title = `${en ? 'Confirmed deaths / inferred deaths / respawns' : 'Подтверждённые смерти / предполагаемые смерти / возрождения'}: ${life.confirmed_deaths || 0} / ${life.inferred_deaths || 0} / ${life.respawns || 0}`;
        }
        const live = { brawler: telemetry.brawler, trophies: telemetry.trophies };
        const previous = liveByKey[key];
        const changed = !previous || previous.brawler !== live.brawler
            || previous.trophies !== live.trophies;
        liveByKey[key] = live;
        // The brawler grid marks the brawler actually being played, so it has to
        // be redrawn whenever that changes - not only when the grid first loads.
        if (changed) renderBrawlerGrid(key);
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

        // Трофеи в час. Пока окно измерения короче 5 минут, скорость не
        // определена — показываем это, а не число из двух соседних отсчётов.
        const rate = telemetry.trophy_rate || {};
        let rateText = '—';
        let rateNote = '';
        let rateClass = '';
        let rateTitle = 'Трофеи в час по общему счёту — нужно минимум 5 минут наблюдения';
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
            const needed = rate.min_span_minutes || 5;
            rateTitle = rate.measured_minutes
                ? `Нужно ${needed} мин наблюдения, есть ${rate.measured_minutes} мин `
                  + `(${rate.samples} отсчётов). Счёт читается в лобби, поэтому отсчёты `
                  + `идут не каждый матч.`
                : `Нужно ${needed} мин наблюдения, отсчётов: ${rate.samples}`;
        }
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
        if (telemetry.switch_after_games != null) {
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

    // The roster, once, for every device. It used to be fetched and thrown away,
    // which is why the panel could not show a brawler at all.
    let brawlerCatalog = [];

    async function loadBrawlers() {
        const { data } = await api('/api/devices/brawlers');
        if (data && Array.isArray(data.brawlers)) {
            brawlerCatalog = data.brawlers;
        }
        return brawlerCatalog;
    }

    // key -> the brawler this device is locked to, "" when it rotates.
    const lockedBrawlers = {};

    function brawlerLabel(name) {
        const found = brawlerCatalog.find((b) => String(b.name).toLowerCase() === String(name).toLowerCase());
        if (!found) return name || '';
        const title = found.name.replace(/_/g, ' ');
        return title.charAt(0).toUpperCase() + title.slice(1);
    }

    function renderBrawlerGrid(key) {
        const container = grid.querySelector(`[data-brawler-grid="${cssEscape(key)}"]`);
        const title = grid.querySelector(`[data-brawler-title="${cssEscape(key)}"]`);
        if (!container) return;
        const locked = (lockedBrawlers[key] || '').toLowerCase();
        const live = String((liveByKey[key] && liveByKey[key].brawler) || '').toLowerCase();
        if (title) {
            title.textContent = locked
                ? `Играет только на: ${brawlerLabel(locked)}`
                : 'Боец выбирается автоматически по сортировке';
        }
        const signature = `${locked}|${live}`;
        if (container.dataset.sig === signature) return;
        container.dataset.sig = signature;
        if (!brawlerCatalog.length) {
            container.innerHTML = '<div class="queue-empty">Каталог бойцов недоступен.</div>';
            return;
        }
        container.innerHTML = brawlerCatalog.map((entry) => {
            const name = String(entry.name || '');
            const key2 = name.toLowerCase();
            const cls = ['brawler-cell'];
            if (key2 === locked) cls.push('is-locked');
            if (key2 === live) cls.push('is-live');
            return `<button class="${cls.join(' ')}" type="button"
                            data-action="lock-brawler" data-key="${escapeHtml(key)}"
                            data-brawler="${escapeHtml(name)}"
                            title="${escapeHtml(name)}">
                        <img src="${escapeHtml(entry.icon_url || `/api/assets/brawlers/${encodeURIComponent(name)}`)}"
                             alt="${escapeHtml(name)}" loading="lazy"
                             onerror="this.style.visibility='hidden'">
                        <span class="brawler-cell-name">${escapeHtml(brawlerLabel(name))}</span>
                    </button>`;
        }).join('');
    }

    async function applyLockedBrawler(key) {
        try {
            const { data } = await api(`/api/devices/${encodeURIComponent(key)}/brawler`);
            lockedBrawlers[key] = (data && data.locked_brawler) || '';
        } catch (err) {
            lockedBrawlers[key] = '';
        }
        renderBrawlerGrid(key);
        return lockedBrawlers[key] || '';
    }

    async function setLockedBrawler(key, name) {
        const card = grid.querySelector(`[data-key="${cssEscape(key)}"]`);
        if (card) card.classList.add('is-busy');
        try {
            const { ok, data } = await api(`/api/devices/${encodeURIComponent(key)}/brawler`, {
                method: 'POST',
                body: { brawler: name || '' },
            });
            if (!ok) {
                toast(data && data.message ? data.message : 'Не удалось выбрать бойца', 'error');
                return false;
            }
            lockedBrawlers[key] = (data && data.locked_brawler) || '';
            renderBrawlerGrid(key);
            renderRotationVisibility(key);
            toast(name ? `Бот будет играть только на ${brawlerLabel(name)}`
                : 'Бот снова выбирает бойца сам', 'ok');
            return true;
        } catch (err) {
            toast('Не удалось выбрать бойца: ' + err.message, 'error');
            return false;
        } finally {
            if (card) card.classList.remove('is-busy');
        }
    }

    // The quota and the sort only mean something while the bot is choosing. With
    // one brawler locked they are inert, and leaving them on screen next to a
    // choice that overrides them is how you end up not knowing which is in force.
    function renderRotationVisibility(key) {
        const bar = grid.querySelector(`[data-rotate-bar="${cssEscape(key)}"]`);
        if (!bar) return;
        const locked = !!(lockedBrawlers[key] || '');
        bar.classList.toggle('hidden', locked);
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

    // How often to ask again. The server sends back the interval it is actually
    // enforcing, so the refresh rate is the one set in the panel's settings and
    // not a number guessed here. A 0 there means "as fast as a round trip
    // allows", so a small floor keeps this from turning into a tight loop that
    // re-downloads the same picture.
    let snapshotWaitMs = SNAPSHOT_POLL_MS;

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
                const got = await apiBlob(`/api/devices/${encodeURIComponent(key)}/snapshot`);
                if (!got) return;
                const told = Number(got.headers.get('X-Preview-Interval-Ms'));
                if (!Number.isNaN(told)) {
                    snapshotWaitMs = told <= 0 ? 150 : Math.min(5000, Math.max(120, told));
                }
                const img = grid.querySelector(`[data-preview="${cssEscape(key)}"]`);
                const placeholder = grid.querySelector(`[data-placeholder="${cssEscape(key)}"]`);
                if (!img) return;
                if (snapshotUrls[key]) URL.revokeObjectURL(snapshotUrls[key]);
                snapshotUrls[key] = URL.createObjectURL(got.blob);
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

        // Choosing a brawler is a single click on a cell, not a submit: it must
        // not run through the busy-button path below, which disables the element
        // it was called on and would leave one cell stuck after the redraw.
        if (action === 'training' || action === 'training-stop') {
            await toggleTraining(key);
            return;
        }
        if (action === 'lock-brawler') {
            const name = button.dataset.brawler || '';
            if (String(lockedBrawlers[key] || '').toLowerCase() === name.toLowerCase()) return;
            const done = await setLockedBrawler(key, name);
            if (done) await loadDevices();
            return;
        }
        if (action === 'unlock-brawler') {
            const done = await setLockedBrawler(key, '');
            if (done) await loadDevices();
            return;
        }

        // Пока запрос уходит, кнопка не берёт повторный клик. Для «Старт» это
        // ещё и защита от двух ботов на одном устройстве.
        button.classList.add('is-busy');

        try {
            if (action === 'start' || action === 'stop' || action === 'pause' || action === 'resume') {
                button.disabled = true;
                const { data } = await api(`/api/devices/${encodeURIComponent(key)}/${action}`, { method: 'POST' });
                if (data && data.message) toast(data.message, data.ok ? 'ok' : 'error');
                await loadDevices();
                if (action === 'start') await applyLockedBrawler(key);
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
        for (const device of devices) await applyLockedBrawler(device.key);
        toast('Обновлено', 'ok');
    });

    document.getElementById('startAllBtn').addEventListener('click', async () => {
        for (const device of devices) {
            if (device.state !== 'device') continue;
            const { data } = await api(`/api/devices/${encodeURIComponent(device.key)}/start`, { method: 'POST' });
            if (data && !data.ok && data.message) toast(data.message, 'error');
        }
        await loadDevices();
        for (const device of devices) await applyLockedBrawler(device.key);
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

    /* ------------------------------------------------------------- обучение */
    /* Запись идёт в фоне, панель только показывает её состояние и предлагает
       открыть разметку. Раз в пять секунд: чаще незачем, а карточка и так
       обновляется каждые две. */

    async function refreshTraining() {
        for (const device of devices) {
            const note = grid.querySelector(`[data-training-note="${cssEscape(device.key)}"]`);
            const open = grid.querySelector(`[data-action="training-stop"]`
                + `[data-key="${cssEscape(device.key)}"]`) || grid.querySelector(
                `[data-training-open="${cssEscape(device.key)}"]`)?.closest('div');
            const stopBtn = grid.querySelector(`[data-action="training-stop"]`
                + `[data-key="${cssEscape(device.key)}"]`);
            const openLink = grid.querySelector(`[data-training-open="${cssEscape(device.key)}"]`);
            try {
                const { data } = await api(`/api/devices/${encodeURIComponent(device.key)}/training`);
                const current = data.current;
                const last = (data.sessions || [])[0];
                if (current && current.recording) {
                    if (note) note.textContent = `Идёт запись: ${current.frames} из ${current.recorded}`
                        + (current.frame_count ? ` (оставлю ${current.frame_count})` : '');
                    if (stopBtn) stopBtn.classList.remove('hidden');
                    if (openLink) openLink.classList.add('hidden');
                } else if (last) {
                    if (note) {
                        note.textContent = `Записано ${last.recorded}, оставлено ${last.frames}`
                            + (last.checked ? ` · размечено ${last.checked}` : ' · не размечено');
                    }
                    if (stopBtn) stopBtn.classList.add('hidden');
                    if (openLink) {
                        openLink.href = `/training/${encodeURIComponent(last.id)}`;
                        openLink.classList.remove('hidden');
                    }
                } else if (note) {
                    note.textContent = '';
                }
            } catch (err) {
                if (note) note.textContent = '';
            }
            void open;
        }
    }

    async function toggleTraining(key) {
        const stopBtn = grid.querySelector(`[data-action="training-stop"][data-key="${cssEscape(key)}"]`);
        const note = grid.querySelector(`[data-training-note="${cssEscape(key)}"]`);
        if (stopBtn && !stopBtn.classList.contains('hidden')) {
            await api(`/api/devices/${encodeURIComponent(key)}/training/stop`, { method: 'POST' });
            toast('Запись прервана', 'ok');
            await refreshTraining();
            return;
        }
        if (note) note.textContent = 'Запускаю бота…';
        const countInput = grid.querySelector(`[data-training-count="${cssEscape(key)}"]`);
        let frameCount = 10;
        if (countInput) {
            const value = Number(countInput.value);
            if (Number.isFinite(value) && value >= 1) frameCount = Math.min(400, Math.round(value));
        }
        const { ok, data } = await api(`/api/devices/${encodeURIComponent(key)}/training/start`, {
            method: 'POST',
            body: { interval: 3, frame_count: frameCount },
        });
        if (!ok) {
            toast(data && data.message ? data.message : 'Не удалось начать запись', 'error');
            if (note) note.textContent = '';
            return;
        }
        toast(data.started_bot
            ? 'Бот запущен, идёт запись матча'
            : 'Идёт запись матча', 'ok');
        await loadDevices();
        await refreshTraining();
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
        setInterval(cycle, POLL_MS);
        // Chained rather than on a fixed interval, so changing the refresh rate
        // takes effect on the next picture instead of at the next tick of a
        // timer that was set when the page loaded.
        const snapshotLoop = async () => {
            await snapshotCycle();
            setTimeout(snapshotLoop, snapshotWaitMs);
        };
        snapshotLoop();
        setInterval(loadLogs, LOG_POLL_MS);
        // An unavailable roster must not prevent device discovery and polling.
        await cycle();
        loadBrawlers().then(() => devices.forEach(d => renderBrawlerGrid(d.key)))
            .catch(error => console.error('brawler roster unavailable', error));
        devices.forEach(d => applyLockedBrawler(d.key));
    }

    init();
})();

document.addEventListener('click', async event => {
 const button=event.target.closest('[data-replay]');if(!button)return;
 const key=button.dataset.replay, card=button.closest('.device-card'), output=card.querySelector('[data-replay-result]');button.disabled=true;
 try {const response=await fetch(`/api/devices/${encodeURIComponent(key)}/replay`,{headers:{'X-Xlam-UI-Token':document.querySelector('meta[name="xlam-ui-token"]').content}});const result=await response.json();output.hidden=false;output.textContent=JSON.stringify(result.replay||result,null,2);}
 catch(error){output.hidden=false;output.textContent=error.message;}finally{button.disabled=false;}
});

(() => {
 const headers={'X-Xlam-UI-Token':document.querySelector('meta[name="xlam-ui-token"]').content,'Content-Type':'application/json'};
 const translate=text=>window.XlamI18n?window.XlamI18n.t(text):text;
 async function show(card,key){
  const response=await fetch(`/api/audit/devices/${encodeURIComponent(key)}`,{headers});
  const {audit}=await response.json();
  const output=card.querySelector('[data-audit-status]');
  if(output){const states={idle:'не запущен',starting:'запускается',running:'идёт запись',stopping:'останавливается',stopped:'остановлен',completed:'завершён',error:'ошибка'};output.textContent=translate(`Завершено: ${audit.completed}/${audit.target} · ${states[audit.state]||audit.state}`)+(audit.error?'\n'+translate(audit.error):'');}
 }
 document.addEventListener('click',async event=>{
  const button=event.target.closest('[data-audit]');if(!button)return;
  const card=button.closest('.device-card'),key=button.dataset.key,action=button.dataset.audit;
  const output=card.querySelector('[data-audit-status]');button.disabled=true;
  try{
   const url=`/api/audit/devices/${encodeURIComponent(key)}/${action}`;
   if(action==='export'){
    const response=await fetch(url,{headers});if(!response.ok){const error=await response.json();throw Error(error.message||response.statusText);}
    const objectUrl=URL.createObjectURL(await response.blob()),link=document.createElement('a');
    link.href=objectUrl;link.download='xlamBOT-match-audit.zip';link.click();setTimeout(()=>URL.revokeObjectURL(objectUrl),30000);
   }else{
    const target=Number(card.querySelector('[data-audit-count]').value);
    const response=await fetch(url,{method:'POST',headers,body:JSON.stringify({target})});const result=await response.json();
    if(!response.ok||!result.ok)throw Error(result.message||response.statusText);
    await show(card,key);
   }
  }catch(error){output.textContent=translate(error.message);}finally{button.disabled=false;}
 });
 setInterval(()=>document.querySelectorAll('.device-card').forEach(card=>{
  const output=card.querySelector('[data-audit-status]');if(output&&output.closest('details').open)show(card,output.dataset.auditStatus).catch(()=>{});
 }),8000);
})();
