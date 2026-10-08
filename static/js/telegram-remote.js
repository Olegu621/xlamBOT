/* Keep every remote tab and its images bound to the selected PC. */
(function () {
    'use strict';
    const prefix = document.querySelector('meta[name="xlam-remote-prefix"]')?.content;
    const grant = document.querySelector('meta[name="xlam-remote-grant"]')?.content;
    if (!/^\/pc\/[a-f0-9]{32}$/.test(prefix || '')) return;
    function scope(value) {
        try {
            const url = new URL(value, location.href);
            // Sandboxed frames have an opaque origin: compare against their URL.
            if (url.origin !== new URL(location.href).origin || url.pathname.startsWith('/mini')) return value;
            if (!url.pathname.startsWith('/pc/')) url.pathname = prefix + url.pathname;
            if (grant) url.searchParams.set('grant', grant);
            return url.href;
        } catch (_) { return value; }
    }
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (input, options) => nativeFetch(typeof input === 'string' || input instanceof URL ? scope(input) : new Request(scope(input.url), input), options);
    const attribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name, value) {
        return attribute.call(this, name, ['src', 'href', 'action'].includes(name) ? scope(value) : value);
    };
    for (const [prototype, key] of [[HTMLImageElement.prototype, 'src'], [HTMLAnchorElement.prototype, 'href']]) {
        const original = Object.getOwnPropertyDescriptor(prototype, key);
        Object.defineProperty(prototype, key, {...original, set(value) { original.set.call(this, scope(value)); }});
    }
    const rewrite = node => {
        if (!(node instanceof Element)) return;
        for (const item of [node, ...node.querySelectorAll('[src],[href],[action]')]) {
            for (const name of ['src', 'href', 'action']) {
                const value = item.getAttribute(name);
                if (value && !value.startsWith('#') && scope(value) !== value) attribute.call(item, name, scope(value));
            }
            if (item instanceof HTMLAnchorElement && new URL(item.href, location.href).pathname === prefix + '/') item.hidden = true;
        }
    };
    new MutationObserver(records => records.forEach(record => record.addedNodes.forEach(rewrite))).observe(document.documentElement, {childList:true, subtree:true});
    // Small, explicit banner explains lost connection without retrying actions.
    document.addEventListener('DOMContentLoaded', () => {
        document.body.classList.add('telegram-panel');
        const style = document.createElement('style');
        style.textContent = 'body.telegram-panel{margin:0!important;padding-top:0!important}.telegram-panel .panel-hero{padding:18px;min-height:0}.telegram-panel .panel-hero h1{font-size:28px}.telegram-panel .hero-art,.telegram-panel .page-kicker{display:none}.telegram-panel .panel-header{padding-top:14px}.telegram-panel .app-rail{position:sticky;inset:auto;top:0;width:100%;padding:8px 12px;flex-direction:row;border-right:0;border-bottom:1px solid var(--line-soft)}.telegram-panel .app-rail .rail-bottom,.telegram-panel .app-brand,.telegram-panel .rail-label{display:none}.telegram-panel .app-nav{display:flex;width:100%;gap:5px;overflow:auto}.telegram-panel .app-nav a{white-space:nowrap;flex:1;justify-content:center;padding:10px}.telegram-panel .app-nav a>span{display:inline}@media(max-width:760px){.telegram-panel .device-grid{padding:12px}.telegram-panel .panel-overview{flex-wrap:wrap}}';
        document.head.append(style);
    });
})();
