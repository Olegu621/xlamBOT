(function () {
    'use strict';
    const host = document.getElementById('telegramControl');
    if (!host) return;
    const text = (ru, english) => document.documentElement.lang === 'en' ? english : ru;
    function render() {
    const summary = host.closest('details')?.querySelector('summary');
    if (summary) summary.textContent = text('Telegram · Управление с телефона','Telegram · Control from your phone');
    host.innerHTML = `<h3>Telegram · @xlambottt_bot</h3><p>${text('Управляй своим ПК из личных сообщений бота. Создай ключ и вставь его в мини-панель. Ключ действует 10 минут и используется один раз.','Control your PC in the bot’s private chat. Create a key and paste it into the mini panel. Keys expire in 10 minutes and can only be used once.')}</p><p id="telegramState" role="status"></p><div class="row"><input class="input" id="telegramKey" type="password" readonly autocomplete="off" aria-label="${text('Ключ привязки ПК','PC pairing key')}"><button class="btn" id="telegramCopy">${text('Копировать ключ','Copy key')}</button></div><div class="card-actions"><button class="btn btn-primary" id="telegramCreate">${text('Создать ключ привязки','Create pairing key')}</button><a class="btn" href="https://t.me/xlambottt_bot" target="_blank" rel="noreferrer">${text('Открыть Telegram-бота','Open Telegram bot')}</a><button class="btn btn-ghost" id="telegramDisconnect">${text('Отключить доступ','Disconnect access')}</button></div><p class="muted">${text('Новый ключ отменяет прежнюю привязку. Отключение сразу запрещает управление, не останавливая игру. Для доступа ПК и бот должны быть включены.','A new key revokes the previous pairing. Disconnecting immediately blocks remote control without stopping gameplay. The PC and bot must remain on.')}</p>`;
    bindActions();
    refresh();
    }
    const find = id => host.querySelector('#'+id);
    async function refresh() {
        try {
            const r = await XlamSession.fetch('/api/telegram-control');
            if (!r.ok) throw Error();
            const data = await r.json();
            find('telegramKey').value = data.key || '';
            find('telegramCopy').disabled = !data.key;
            find('telegramDisconnect').disabled = !data.enabled;
            find('telegramState').textContent = !data.enabled ? text('Доступ выключен','Access disabled') :
                data.state === 'retrying' ? text('Нет связи с облаком. Переподключаемся…','Cloud unavailable. Reconnecting…') :
                data.paired ? text('ПК привязан к Telegram','PC linked to Telegram') : text('Ожидаем привязку в мини-панели','Waiting for pairing in the mini panel');
        } catch (_) { find('telegramState').textContent = text('Не удалось проверить подключение','Could not check connection'); }
    }
    async function change(action) {
        const button = find(action === 'create_key' ? 'telegramCreate' : 'telegramDisconnect');
        if (action === 'create_key' && !find('telegramDisconnect').disabled && !confirm(text('Создать новый ключ и отменить старую привязку?','Create a new key and revoke the existing pairing?'))) return;
        button.disabled = true;
        try {
            const r = await XlamSession.fetch('/api/telegram-control', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({action})});
            if (!r.ok) throw Error();
            await refresh();
        } catch (_) { find('telegramState').textContent = text('Не удалось изменить подключение. Проверь интернет.','Could not update connection. Check your internet.'); }
        finally { button.disabled = false; }
    }
    function bindActions() {
    find('telegramCreate').onclick = () => change('create_key');
    find('telegramDisconnect').onclick = () => change('disconnect');
    find('telegramCopy').onclick = async () => {
        try { await navigator.clipboard.writeText(find('telegramKey').value); find('telegramState').textContent = text('Ключ скопирован','Key copied'); }
        catch (_) { find('telegramKey').type = 'text'; find('telegramKey').select(); }
    };
    }
    render();
    window.addEventListener('xlam-language-changed', render);
    host.closest('details')?.addEventListener('toggle', () => {
        if (host.closest('details').open) refresh();
    });
    setInterval(() => {
        const card = host.closest('details');
        if (card?.open && !card.hidden && !document.hidden) refresh();
    }, 5000);
})();
