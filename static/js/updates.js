(function () {
    'use strict';
    const enabled = document.getElementById('autoUpdates');
    const status = document.getElementById('updateStatus');
    const check = document.getElementById('checkUpdates');
    if (!enabled || !status || !check) return;
    const reinstall = document.createElement('a');
    reinstall.className = 'btn btn-ghost';
    reinstall.href = 'https://github.com/Olegu621/xlamBOT/releases/latest';
    reinstall.target = '_blank';
    reinstall.rel = 'noopener noreferrer';
    reinstall.textContent = 'Актуальный установщик';
    reinstall.hidden = true;
    status.after(reinstall);
    async function refresh() {
        try {
            const response = await XlamSession.fetch('/api/updates/status');
            if (!response.ok) throw new Error();
            const data = await response.json();
            enabled.checked = data.enabled;
            status.textContent = (data.enabled ? data.message : 'Автообновление выключено') + ' · ревизия ' + data.revision;
            reinstall.hidden = data.repository !== 'Olegu621/xlamBOT-updates';
            if (!reinstall.hidden) status.textContent += ' · Старый модуль обновлений. Установите текущую версию поверх существующей.';
        } catch (_) { status.textContent = 'Нет связи с локальной панелью. Проверьте, что бот запущен, и обновите страницу.'; }
    }
    async function post(path, body) {
        const response = await XlamSession.fetch(path, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
        if (!response.ok) { status.textContent = 'Не удалось изменить настройку'; return; }
        await refresh();
    }
    enabled.addEventListener('change', () => post('/api/updates/settings', {enabled: enabled.checked}));
    check.addEventListener('click', () => post('/api/updates/check', {}));
    refresh(); setInterval(refresh, 5000);
})();
