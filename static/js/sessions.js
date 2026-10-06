(() => {
    'use strict';
    const $=id=>document.getElementById(id);
    const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    let sessions=[],trash=[],pendingDelete=null,busy=false;
    const ready=s=>s.included>=2&&s.checked===s.frames&&!s.is_recording;
    const number=n=>Number(n||0).toLocaleString(document.documentElement.lang==='en'?'en-US':'ru-RU');
    function render(){
        const query=$('sessionSearch').value.trim().toLocaleLowerCase('ru-RU'), filter=$('sessionFilter').value;
        const inTrash=filter==='trash'; const visible=(inTrash?trash:sessions).filter(s=>(`${s.id} ${s.key}`).toLocaleLowerCase('ru-RU').includes(query)&&(inTrash||filter==='all'||(filter==='ready'?ready(s):!ready(s))));
        $('sessionGrid').innerHTML=visible.map((s,i)=>{
            const progress=s.frames?Math.round(s.checked/s.frames*100):0;
            const date=s.started?new Date(s.started*1000).toLocaleString(document.documentElement.lang==='en'?'en-US':'ru-RU',{day:'numeric',month:'long',hour:'2-digit',minute:'2-digit'}):s.id;
            const state=inTrash?'В корзине':s.is_recording?'Идёт запись':ready(s)?'Можно экспортировать':'Нужна разметка';
            return `<article class="session-card"><div class="session-cover cover-${i%3}"><span class="session-cover-icon" aria-hidden="true">▧</span><span class="session-status ${ready(s)?'is-ready':''}">${escape(state)}</span><span class="session-cover-count">${number(s.frames)}<small>кадров</small></span></div><div class="session-card-body"><span class="session-device">${escape(s.key)}</span><h3>${escape(date)}</h3><div class="session-progress-label"><span>Проверено ${number(s.checked)} из ${number(s.frames)}</span><strong>${progress}%</strong></div><div class="session-progress" role="progressbar" aria-label="Проверенные кадры" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress}"><span style="width:${progress}%"></span></div><div class="session-meta"><span>${number(s.boxes)} объектов</span><span>${number(s.classes?.length)} классов</span></div><div class="session-actions">${inTrash?`<button class="btn btn-primary" data-restore="${escape(s.id)}">Восстановить</button>`:`<a class="btn ${ready(s)?'btn-secondary':'btn-primary'}" href="/training/${encodeURIComponent(s.id)}">${ready(s)?'Посмотреть разметку':'Продолжить разметку'}</a><button class="btn btn-danger" data-delete="${escape(s.id)}" ${s.is_recording?'disabled title="Сначала завершите запись"':''}>Удалить</button>`}</div></div></article>`;
        }).join('');
        $('libraryEmpty').hidden=visible.length>0;
        $('libraryEmpty').querySelector('h2').textContent=inTrash?'Корзина пуста':sessions.length?'Ничего не найдено':'Пока нет записей';
        $('libraryEmpty').querySelector('p').textContent=inTrash?'Удалённые записи можно восстановить здесь.':sessions.length?'Попробуй другой запрос или фильтр.':'Открой устройство и нажми «Обучение», чтобы сохранить кадры следующего матча.';
    }
    $('sessionSearch').addEventListener('input',render);$('sessionFilter').addEventListener('change',render);
    async function load(){
        try{
            const response=await XlamSession.fetch('/api/training/sessions');if(!response.ok)throw Error('Не удалось получить записи. Обнови страницу.');
            const data=await response.json();const removed=await XlamSession.fetch('/api/training/trash');if(!removed.ok)throw Error('Не удалось получить корзину');trash=(await removed.json()).sessions||[];sessions=(data.sessions||[]).sort((a,b)=>(b.started||0)-(a.started||0));
            for(const [id,value] of [['sessionCount',sessions.length],['frameCount',sessions.reduce((n,s)=>n+s.frames,0)],['reviewedCount',sessions.reduce((n,s)=>n+s.checked,0)],['readyCount',sessions.filter(ready).length]])$(id).textContent=number(value);
            $('libraryStatus').textContent='';render();
        }catch(error){$('libraryStatus').textContent=error.message;}
    }
    async function mutate(path,method){const r=await XlamSession.fetch(path,{method}),data=await r.json();if(!r.ok)throw Error(data.message||'Не удалось удалить запись');return data;}
    $('sessionGrid').addEventListener('click',async event=>{
        const remove=event.target.closest('[data-delete]'),restore=event.target.closest('[data-restore]');if(busy)return;
        if(remove){pendingDelete=remove.dataset.delete;$('deleteSessionInfo').textContent=pendingDelete;$('deleteSessionDialog').showModal();}
        if(restore){busy=true;restore.disabled=true;try{await mutate('/api/training/trash/'+encodeURIComponent(restore.dataset.restore)+'/restore','POST');await load();}catch(error){$('libraryStatus').textContent=error.message;}finally{busy=false;restore.disabled=false;}}
    });
    $('deleteSessionDialog').addEventListener('close',async()=>{
        if($('deleteSessionDialog').returnValue!=='delete'||!pendingDelete||busy)return;
        busy=true;const id=pendingDelete;pendingDelete=null;
        try{await mutate('/api/training/sessions/'+encodeURIComponent(id),'DELETE');await load();$('libraryStatus').textContent='Запись перемещена в корзину. Её можно восстановить.';}catch(error){$('libraryStatus').textContent=error.message;}finally{busy=false;}
    });
    window.addEventListener('xlam-language-changed',render);
    load();setInterval(load,15000);
})();
