/* Renew a local UI token after an application restart without losing drafts. */
(function () {
    'use strict';
    const nativeFetch = window.fetch.bind(window);
    let refreshing = null;
    const meta = () => document.querySelector('meta[name="xlam-ui-token"]');
    async function renew() {
        if (!refreshing) {
            refreshing = (async () => {
                const page = await nativeFetch('/panel', { cache: 'no-store' });
                if (!page.ok) return false;
                const html = new DOMParser().parseFromString(await page.text(), 'text/html');
                const fresh = html.querySelector('meta[name="xlam-ui-token"]')?.content;
                if (!fresh || !meta()) return false;
                meta().content = fresh;
                window.dispatchEvent(new CustomEvent('xlam-session-refreshed', { detail: fresh }));
                for (const img of document.querySelectorAll('img')) {
                    const url = new URL(img.src, location.href);
                    if (url.origin === location.origin && url.pathname.startsWith('/api/training/') && url.searchParams.has('t')) {
                        url.searchParams.set('t', fresh);
                        img.src = url.href;
                    }
                }
                return true;
            })().finally(() => { refreshing = null; });
        }
        return refreshing;
    }
    async function request(path, options = {}) {
        const send = () => {
            const headers = new Headers(options.headers || {});
            headers.set('X-Xlam-UI-Token', meta()?.content || '');
            return nativeFetch(path, { ...options, headers });
        };
        let response = await send();
        if (response.status === 403) {
            const data = await response.clone().json().catch(() => ({}));
            if (data.code === 'INVALID_UI_SESSION' && await renew()) response = await send();
        }
        return response;
    }
    window.XlamSession = { fetch: request };
})();
