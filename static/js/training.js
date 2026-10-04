/* xlamBOT — разметка кадров матча для модели газа */
(function () {
    'use strict';

    const TOKEN = document.querySelector('meta[name="xlam-ui-token"]').content;
    const SESSION = window.XLAM_SESSION;

    const canvas = document.getElementById('trCanvas');
    const ctx = canvas.getContext('2d');
    const strip = document.getElementById('trStrip');
    const classesBox = document.getElementById('trClasses');
    const loading = document.getElementById('trLoading');
    const toastEl = document.getElementById('trToast');
    const downloadBtn = document.getElementById('trDownload');
    const progressFill = document.getElementById('trProgressFill');
    const progressText = document.getElementById('trProgressText');

    // Цвета рамок. Газ — тот, ради которого всё затевалось, поэтому он яркий и
    // первый в списке; куст спокойнее, чтобы не спорить с ним за внимание.
    const PALETTE = {
        gas: { stroke: '#2fe0a6', fill: 'rgba(47, 224, 166, 0.16)', label: 'газ' },
        bush: { stroke: '#ffc654', fill: 'rgba(255, 198, 84, 0.14)', label: 'куст' },
        wall: { stroke: '#4a8cff', fill: 'rgba(74, 140, 255, 0.14)', label: 'стена' },
        close_bush: { stroke: '#c78cff', fill: 'rgba(199, 140, 255, 0.14)', label: 'ближняя стена' },
    };
    const PALETTE_FALLBACK = { stroke: '#8f9bb0', fill: 'rgba(143, 155, 176, 0.14)', label: '?' };
    // Список классов расширяемый: он приходит с сервера, и класс без цвета
    // должен всё равно рисоваться, а не ронять отрисовку кадра.
    function paint(cls) { return PALETTE[cls] || PALETTE_FALLBACK; }

    let classes = [];
    let frames = [];
    let index = 0;
    let current = null;          // {cls, x1, y1, x2, y2} в пикселях кадра
    let selected = -1;
    let cls = 'gas';
    let undoStack = [];
    let dragging = null;
    let image = null;
    let saveTimer = null;
    let dirty = false;

    function frameUrl(name) {
        return `/api/training/sessions/${encodeURIComponent(SESSION)}/images/`
            + `${encodeURIComponent(name)}?t=${encodeURIComponent(TOKEN)}`;
    }

    // ── helpers ───────────────────────────────────────────────────────────────
    function toast(message, kind) {
        toastEl.textContent = message;
        toastEl.className = 'tr-toast' + (kind ? ' is-' + kind : '');
        clearTimeout(toast.timer);
        toast.timer = setTimeout(() => toastEl.classList.add('hidden'), 3600);
    }

    async function api(path, options) {
        const opts = Object.assign({ headers: {} }, options || {});
        opts.headers = Object.assign({ 'X-Xlam-UI-Token': TOKEN }, opts.headers);
        if (opts.body !== undefined && typeof opts.body !== 'string') {
            opts.headers['Content-Type'] = 'application/json';
            opts.body = JSON.stringify(opts.body);
        }
        const response = await fetch(path, opts);
        const text = await response.text();
        let payload = {};
        try { payload = text ? JSON.parse(text) : {}; } catch (e) { payload = { message: text }; }
        if (!response.ok) throw new Error(payload.message || ('HTTP ' + response.status));
        return payload;
    }

    // ── загрузка ──────────────────────────────────────────────────────────────
    async function load() {
        const data = await api('/api/training/sessions/' + encodeURIComponent(SESSION));
        classes = data.classes || [];
        frames = data.session.items || [];
        renderClasses();
        renderStrip();
        if (!frames.length) {
            loading.textContent = 'В этой записи нет кадров.';
            return;
        }
        show(index);
    }

    function renderClasses() {
        classesBox.innerHTML = classes.map((c, i) => `
            <button class="tr-class${c.value === cls ? ' is-active' : ''}"
                    type="button" data-cls="${c.value}" style="--c: ${paint(c.value).stroke}">
                <span class="tr-class-dot"></span>${c.label}
                <kbd>${i + 1}</kbd>
            </button>`).join('');
    }

    function renderStrip() {
        strip.innerHTML = frames.map((frame, i) => `
            <button class="tr-cell${i === index ? ' is-current' : ''}${frame.checked ? ' is-done' : ''}"
                    type="button" data-i="${i}">
                <img loading="lazy" src="${frameUrl(frame.file)}" alt="">
                <span class="tr-cell-no">${i + 1}</span>
                ${frame.checked ? '<span class="tr-cell-tick">✓</span>' : ''}
                ${(frame.boxes || []).length ? `<span class="tr-cell-count">${frame.boxes.length}</span>` : ''}
            </button>`).join('');
    }

    function updateProgress() {
        const total = frames.length;
        const done = frames.filter((f) => f.checked).length;
        const boxes = frames.reduce((n, f) => n + (f.boxes || []).length, 0);
        progressFill.style.width = (total ? Math.round(100 * done / total) : 0) + '%';
        progressText.textContent = `размечено ${done} из ${total} · рамок ${boxes}`;
        // Архив отдаётся только когда разобраны все кадры: недоразмеченный
        // кадр молча ушёл бы в датасет без рамок и стал бы ложным ответом
        // «здесь ничего нет».
        downloadBtn.disabled = !(total > 0 && done === total);
        downloadBtn.textContent = done === total && total > 0
            ? 'Скачать .zip' : `Осталось ${total - done}`;
    }

    // ── отрисовка ─────────────────────────────────────────────────────────────
    function show(i) {
        if (!frames.length) return;
        index = Math.max(0, Math.min(frames.length - 1, i));
        const frame = frames[index];
        current = (frame.boxes || []).map((b) => Object.assign({}, b));
        selected = -1;
        undoStack = [];
        dirty = false;
        document.getElementById('trFrameNo').textContent = index + 1;
        document.getElementById('trFrameTotal').textContent = frames.length;
        strip.querySelectorAll('.tr-cell').forEach((cell, n) => {
            cell.classList.toggle('is-current', n === index);
        });
        const active = strip.querySelector('.tr-cell.is-current');
        if (active) active.scrollIntoView({ block: 'nearest' });
        updateProgress();

        const img = new Image();
        img.onload = () => {
            image = img;
            resize();
            loading.classList.add('hidden');
            draw();
        };
        img.onerror = () => {
            loading.textContent = 'Кадр не читается.';
        };
        img.src = frameUrl(frame.file);
    }

    function resize() {
        if (!image) return;
        const stage = canvas.parentElement.getBoundingClientRect();
        const scale = Math.min(stage.width / image.width, stage.height / image.height);
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
    }

    function toImage(event) {
        const rect = canvas.getBoundingClientRect();
        const sx = image.width / rect.width;
        const sy = image.height / rect.height;
        return {
            x: (event.clientX - rect.left) * sx,
            y: (event.clientY - rect.top) * sy,
        };
    }

    function draw() {
        if (!image) return;
        const sx = canvas.width / image.width;
        const sy = canvas.height / image.height;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

        (current || []).forEach((box, i) => {
            const colour = paint(box.cls);
            const x = box.x1 * sx;
            const y = box.y1 * sy;
            const w = (box.x2 - box.x1) * sx;
            const h = (box.y2 - box.y1) * sy;
            ctx.fillStyle = colour.fill;
            ctx.fillRect(x, y, w, h);
            ctx.lineWidth = i === selected ? 3 : 2;
            ctx.strokeStyle = colour.stroke;
            ctx.strokeRect(x, y, w, h);
            ctx.font = '600 12px Inter, sans-serif';
            const text = colour.label;
            const tw = ctx.measureText(text).width + 8;
            ctx.fillStyle = colour.stroke;
            ctx.fillRect(x, Math.max(0, y - 15), tw, 15);
            ctx.fillStyle = '#0d1016';
            ctx.fillText(text, x + 4, Math.max(11, y - 4));
        });

        if (dragging && dragging.w > 3 && dragging.h > 3) {
            const colour = paint(dragging.cls);
            ctx.setLineDash([6, 4]);
            ctx.lineWidth = 2;
            ctx.strokeStyle = colour.stroke;
            ctx.strokeRect(dragging.dx * sx, dragging.dy * sy,
                dragging.w * sx, dragging.h * sy);
            ctx.setLineDash([]);
        }
    }

    // ── правка ────────────────────────────────────────────────────────────────
    function pushUndo() {
        undoStack.push(JSON.stringify(current || []));
        if (undoStack.length > 40) undoStack.shift();
    }

    function markDirty() {
        dirty = true;
        frames[index].boxes = (current || []).map((b) => Object.assign({}, b));
        frames[index].checked = true;
        renderStrip();
        updateProgress();
        clearTimeout(saveTimer);
        // Пауза перед сохранением: при обведении одного объекта мышью делается
        // десяток движений, и писать на каждое - значит писать в файл десяток раз.
        saveTimer = setTimeout(save, 600);
    }

    async function save() {
        if (!dirty || !frames[index]) return;
        dirty = false;
        const payload = {
            frame: frames[index].file,
            boxes: current || [],
            checked: true,
        };
        try {
            const data = await api(`/api/training/sessions/${encodeURIComponent(SESSION)}/labels`, {
                method: 'POST',
                body: payload,
            });
            frames[index] = data.frame;
            updateProgress();
        } catch (error) {
            dirty = true;
            toast('Не сохранилось: ' + error.message, 'error');
        }
    }

    // ── мышь ──────────────────────────────────────────────────────────────────
    canvas.addEventListener('mousedown', (event) => {
        if (!image || event.button !== 0) return;
        const point = toImage(event);
        // Клик по рамке выбирает её, клик по пустому месту начинает новую.
        for (let i = (current || []).length - 1; i >= 0; i--) {
            const box = current[i];
            if (point.x >= box.x1 && point.x <= box.x2
                && point.y >= box.y1 && point.y <= box.y2) {
                selected = i;
                draw();
                event.preventDefault();
                return;
            }
        }
        selected = -1;
        dragging = { x1: point.x, y1: point.y, dx: point.x, dy: point.y,
                     w: 0, h: 0, cls };
        draw();
        event.preventDefault();
    });

    window.addEventListener('mousemove', (event) => {
        if (!dragging || !image) return;
        const point = toImage(event);
        dragging.x2 = Math.max(0, Math.min(image.width, point.x));
        dragging.y2 = Math.max(0, Math.min(image.height, point.y));
        dragging.dx = Math.min(dragging.x1, dragging.x2);
        dragging.dy = Math.min(dragging.y1, dragging.y2);
        dragging.w = Math.abs(dragging.x2 - dragging.x1);
        dragging.h = Math.abs(dragging.y2 - dragging.y1);
        draw();
    });

    window.addEventListener('mouseup', () => {
        if (!dragging) return;
        const box = dragging;
        dragging = null;
        if (box.w > 6 && box.h > 6) {
            pushUndo();
            current.push({ cls: box.cls, x1: box.dx, y1: box.dy,
                           x2: box.dx + box.w, y2: box.dy + box.h });
            selected = current.length - 1;
            markDirty();
        }
        draw();
    });

    window.addEventListener('resize', () => { resize(); draw(); });

    // ── кнопки ────────────────────────────────────────────────────────────────
    classesBox.addEventListener('click', (event) => {
        const button = event.target.closest('[data-cls]');
        if (!button) return;
        cls = button.dataset.cls;
        renderClasses();
        if (dragging) dragging.cls = cls;
    });

    strip.addEventListener('click', async (event) => {
        const cell = event.target.closest('[data-i]');
        if (!cell) return;
        await save();
        show(Number(cell.dataset.i));
    });

    document.getElementById('trPrev').addEventListener('click', async () => {
        await save(); show(index - 1);
    });
    document.getElementById('trNext').addEventListener('click', async () => {
        await save(); show(index + 1);
    });
    document.getElementById('trUndo').addEventListener('click', () => {
        if (!undoStack.length) return;
        current = JSON.parse(undoStack.pop());
        selected = -1;
        markDirty();
        draw();
    });
    document.getElementById('trClear').addEventListener('click', () => {
        if (!current || !current.length) return;
        pushUndo();
        current = [];
        selected = -1;
        markDirty();
        draw();
    });
    document.getElementById('trEmpty').addEventListener('click', async () => {
        pushUndo();
        current = [];
        selected = -1;
        markDirty();
        await save();
        toast('Кадр отмечен как пустой', 'ok');
        if (index < frames.length - 1) show(index + 1);
    });
    downloadBtn.addEventListener('click', () => {
        window.location.href = `/api/training/sessions/${encodeURIComponent(SESSION)}/export.zip`;
    });

    // ── клавиатура ────────────────────────────────────────────────────────────
    document.addEventListener('keydown', (event) => {
        if (event.target.tagName === 'INPUT') return;
        if (event.key === 'ArrowLeft') { event.preventDefault(); save().then(() => show(index - 1)); }
        else if (event.key === 'ArrowRight') { event.preventDefault(); save().then(() => show(index + 1)); }
        else if (event.key === 'Delete' || event.key === 'Backspace') {
            if (selected < 0) return;
            event.preventDefault();
            pushUndo();
            current.splice(selected, 1);
            selected = -1;
            markDirty();
            draw();
        } else if (event.key === '1' || event.key === '2') {
            const pick = classes[Number(event.key) - 1];
            if (pick) { cls = pick.value; renderClasses(); toast('Рисуем: ' + pick.label); }
        } else if (event.key === 'n' || event.key === 'N' || event.key === 'т') {
            event.preventDefault();
            document.getElementById('trEmpty').click();
        } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
            event.preventDefault();
            document.getElementById('trUndo').click();
        }
    });

    window.addEventListener('beforeunload', (event) => {
        if (!dirty) return;
        save();
        event.preventDefault();
        event.returnValue = '';
    });

    load().catch((error) => {
        loading.textContent = 'Не открылось: ' + error.message;
    });
})();
