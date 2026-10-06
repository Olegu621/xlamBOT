/* Refresh the website after a verified server snapshot; keep unsaved forms. */
(function () {
    'use strict';
    const token = document.querySelector('meta[name="xlam-ui-token"]')?.content || '';
    const initialRevision = document.querySelector('meta[name="xlam-resource-version"]')?.content || '';
    const dirty = new Set();
    let pendingRevision = '', checking = false, initialized = false;
    const repo = document.getElementById('resourceRepo');
    const branch = document.getElementById('resourceBranch');
    const enabled = document.getElementById('resourceEnabled');
    const sourceStatus = document.getElementById('resourceStatus');
    const notice = document.createElement('div');
    notice.className = 'resource-notice';
    notice.setAttribute('role', 'status');
    notice.hidden = true;
    document.body.appendChild(notice);

    async function api(path, data) {
        const response = await fetch(path, {method: data ? 'POST' : 'GET',
            headers: {'X-Xlam-UI-Token': token, 'Content-Type': 'application/json'},
            body: data ? JSON.stringify(data) : undefined, cache: 'no-store'});
        const result = await response.json();
        if (!response.ok) throw new Error(result.message || result.error || 'Не удалось выполнить запрос');
        return result;
    }

    function hasDrafts() {
        for (const field of dirty) {
            if (!field.isConnected || (field.dataset.applied != null && String(field.value) === field.dataset.applied)) dirty.delete(field);
        }
        return dirty.size > 0 || document.documentElement.dataset.settingsDirty === 'true' || document.documentElement.dataset.annotationDirty === 'true' || document.documentElement.dataset.calibrationDirty === 'true'
            || !!document.querySelector('.btn.is-busy, #saveSettings:disabled, #saveSettingsBottom:disabled');
    }

    function refreshWhenReady() {
        if (!pendingRevision || document.hidden) return;
        if (hasDrafts()) {
            notice.textContent = 'Обновление сайта готово. Сохраните изменения, чтобы применить его.';
            notice.hidden = false;
            return;
        }
        notice.textContent = 'Обновляю сайт…';
        notice.hidden = false;
        window.location.reload();
    }

    document.addEventListener('input', (event) => {
        if (event.target.matches('#resourceSettings input, #resourceSettings select, #resourceSettings textarea')) dirty.add(event.target);
    });
    document.addEventListener('change', (event) => {
        if (event.target.matches('#resourceSettings input, #resourceSettings select, #resourceSettings textarea')) dirty.add(event.target);
    });
    document.addEventListener('xlam:saved', (event) => {
        for (const field of dirty) {
            if (!event.detail?.scope || field.closest(event.detail.scope)) dirty.delete(field);
        }
        refreshWhenReady();
    });
    document.addEventListener('visibilitychange', refreshWhenReady);

    async function poll() {
        if (checking || document.hidden) return;
        checking = true;
        try {
            const state = await api('/api/resources/status');
            if (!initialized && repo) {
                repo.value = state.repository; branch.value = state.branch; enabled.checked = state.enabled;
                initialized = true;
            }
            if (sourceStatus) {
                sourceStatus.textContent = state.last_error || (state.checking ? 'Проверяю…' :
                    !state.enabled ? 'Автообновление выключено' : state.connected ? 'GitHub подключён' : 'Подключение к GitHub…');
                sourceStatus.classList.toggle('is-error', !!state.last_error);
            }
            if (initialRevision && state.revision && state.revision !== initialRevision) {
                pendingRevision = state.revision;
                refreshWhenReady();
            }
        } catch (error) {
            if (sourceStatus) sourceStatus.textContent = 'Проверка недоступна: ' + error.message;
        } finally { checking = false; }
    }

    document.getElementById('saveResourceSource')?.addEventListener('click', async (event) => {
        event.target.disabled = true;
        try {
            await api('/api/resources/config', {repository: repo.value, branch: branch.value, enabled: enabled.checked});
            document.dispatchEvent(new CustomEvent('xlam:saved', {detail: {scope: '#resourceSettings'}}));
            await poll();
        } catch (error) { sourceStatus.textContent = error.message; }
        finally { event.target.disabled = false; }
    });
    document.getElementById('checkResourceSource')?.addEventListener('click', async () => {
        try { await api('/api/resources/check', {}); await poll(); }
        catch (error) { sourceStatus.textContent = error.message; }
    });
    poll();
    setInterval(poll, 5000);
})();

document.getElementById('checkDiagnostics')?.addEventListener('click', async event => {
 const button=event.target, output=document.getElementById('diagnosticResult');button.disabled=true;
 try {const token=document.querySelector('meta[name="xlam-ui-token"]')?.content;const response=await fetch('/api/diagnostics',{headers:{'X-Xlam-UI-Token':token}});const result=await response.json();output.hidden=false;output.textContent=(result.checks||[]).map(c=>`${c.status} · ${c.name}: ${c.detail}`).join('\n');}
 catch(error){output.hidden=false;output.textContent=error.message;}finally{button.disabled=false;}
});
