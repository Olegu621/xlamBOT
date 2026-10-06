/* Keep original DOM text intact: live updates and language switching still work. */
(() => {
    'use strict';
    const leaves = 'div,span,p,small,strong,b,a,label,h1,h2,h3,button';
    const tracked = new Map();
    const pending = new Set();
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0;

    function clear(el, entry) {
        el.classList.remove('text-marquee', 'marquee-static');
        el.removeAttribute('data-marquee-text');
        if (entry.title && el.title === entry.title) el.removeAttribute('title');
        entry.title = '';
        entry.text = '';
        entry.distance = 0;
    }

    function measure(el) {
        const entry = tracked.get(el);
        if (!entry) return;
        if (!el.isConnected) {
            resize.unobserve(el);
            visibility.unobserve(el);
            tracked.delete(el);
            return;
        }
        const text = el.textContent.trim();
        if (el.children.length || !text) { clear(el, entry); return; }
        // Restore the original ink before measuring a changed status/language.
        if (entry.text && entry.text !== text) clear(el, entry);
        const style = getComputedStyle(el);
        if (style.whiteSpace !== 'nowrap' || style.textOverflow !== 'ellipsis') {
            clear(el, entry);
            return;
        }
        const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
        const available = el.clientWidth - padding;
        const range = document.createRange();
        range.selectNodeContents(el);
        const distance = Math.ceil(range.getBoundingClientRect().width - available);
        if (available <= 0 || distance <= 2) {
            clear(el, entry);
            return;
        }
        if (reduced.matches) {
            clear(el, entry);
            if (!el.title) { el.title = text; entry.title = text; }
            return;
        }
        if (entry.text === text && entry.distance === distance) return;
        if (!el.classList.contains('text-marquee')) {
            el.classList.toggle('marquee-static', style.position === 'static');
            el.style.setProperty('--marquee-ink', style.color);
            el.style.setProperty('--marquee-left', style.paddingLeft);
            el.style.setProperty('--marquee-top', style.paddingTop);
        }
        el.style.setProperty('--marquee-distance', `${-distance}px`);
        // Both ends pause for reading; long labels move at a similar speed.
        el.style.setProperty('--marquee-duration', `${Math.max(8, distance / 26 * 2 + 4)}s`);
        el.dataset.marqueeText = text;
        if (!el.title || el.title === entry.title) {
            el.title = text;
            entry.title = text;
        }
        entry.text = text;
        entry.distance = distance;
        el.classList.add('text-marquee');
    }

    function queue(el) {
        pending.add(el);
        if (frame) return;
        frame = requestAnimationFrame(() => {
            frame = 0;
            for (const item of pending) measure(item);
            pending.clear();
        });
    }
    const resize = new ResizeObserver(entries => entries.forEach(item => queue(item.target)));
    const visibility = new IntersectionObserver(entries => entries.forEach(item => {
        item.target.classList.toggle('marquee-offscreen', !item.isIntersecting);
    }));

    function discover(root) {
        if (!(root instanceof Element)) return;
        const candidates = root.matches(leaves) ? [root, ...root.querySelectorAll(leaves)] : root.querySelectorAll(leaves);
        for (const el of candidates) {
            if (tracked.has(el)) { queue(el); continue; }
            if (el.children.length || !el.textContent.trim() || el.closest('select,textarea,pre,[contenteditable],.sr-only')) continue;
            const style = getComputedStyle(el);
            if (style.whiteSpace !== 'nowrap' || style.textOverflow !== 'ellipsis') continue;
            tracked.set(el, {text: '', title: '', distance: 0});
            resize.observe(el);
            visibility.observe(el);
            queue(el);
        }
    }
    const mutations = new MutationObserver(records => {
        for (const record of records) {
            const el = record.target.nodeType === Node.TEXT_NODE ? record.target.parentElement : record.target;
            if (tracked.has(el)) queue(el);
            else discover(el);
            for (const node of record.addedNodes) discover(node);
        }
        // Remove detached cards without retaining their observers or animations.
        for (const el of tracked.keys()) if (!el.isConnected) queue(el);
    });
    function refresh() { discover(document.body); for (const el of tracked.keys()) queue(el); }
    function suspend() { document.body.classList.toggle('marquee-suspended', document.hidden); }
    mutations.observe(document.body, {subtree: true, childList: true, characterData: true});
    reduced.addEventListener('change', refresh);
    document.addEventListener('visibilitychange', suspend);
    document.fonts.ready.then(refresh);
    suspend();
    refresh();
})();
