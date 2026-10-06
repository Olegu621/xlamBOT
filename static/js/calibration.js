(() => {
    'use strict';
    const $ = id => document.getElementById(id);
    const base = `/api/brawler-calibration/${encodeURIComponent(document.body.dataset.device)}`;
    const canvas = $('screen'), ctx = canvas.getContext('2d');
    let data, image, frame, start, drag, busy = false;
    const dirtyPoints = {}, dirtyRegions = {};
    const notify = (text, kind='') => { $('status').textContent=text; $('status').className=kind; };
    const entries = () => data ? [...data.points.map(p=>({...p,kind:'point'})), ...data.regions.map(p=>({...p,kind:'region'}))] : [];
    const current = () => entries().find(p=>p.id===$('target').value);
    const value = p => (p.kind==='point'?dirtyPoints:dirtyRegions)[p.id] || p.value;
    const physical = values => values.map((v,i)=>v*((i%2===0)?canvas.width/1920:canvas.height/1080));
    async function api(path='',body){
        const response=await XlamSession.fetch(base+path,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
        if(!response.ok){const err=await response.json().catch(()=>({}));throw Error(err.message || `Ошибка ${response.status}`);}
        return response;
    }
    function updateOptions(){
        const previous=$('target').value; $('target').replaceChildren();
        $('targetList')?.replaceChildren();
        for(const group of ['Лобби','Список бойцов','Меню сортировки','Результаты поиска','Карточка бойца','Области чтения']){
            const parent=document.createElement('optgroup');parent.label=group;
            const list=document.createElement('div');list.className='target-group';
            const title=document.createElement('h3');title.textContent=group;list.append(title);
            for(const p of entries().filter(p=>(p.screen||'Области чтения')===group)){
                const option=document.createElement('option');option.value=p.id;
                const changed=!!(p.kind==='point'?dirtyPoints:dirtyRegions)[p.id];
                option.textContent=`${changed?'● ':p.calibrated?'✓ ':''}${p.label}`;parent.append(option);
                const button=document.createElement('button');button.type='button';button.className='target-item';button.dataset.target=p.id;
                const marker=document.createElement('span');marker.className=`target-marker ${p.calibrated?'is-calibrated':''}`;marker.textContent=changed?'●':p.calibrated?'✓':p.kind==='region'?'▧':'·';
                const label=document.createElement('span');label.textContent=p.label;button.append(marker,label);list.append(button);
            }
            $('target').append(parent);
            if(list.childElementCount>1)$('targetList')?.append(list);
        }
        if(entries().some(p=>p.id===previous)) $('target').value=previous;
        else $('target').value=entries()[0].id;
        $('savedSummary').textContent=`Сохранено вручную: ${entries().filter(p=>p.calibrated).length} из ${entries().length}.`;
        select();
    }
    function controls(){
        const hasChanges=Object.keys(dirtyPoints).length+Object.keys(dirtyRegions).length>0;
        document.documentElement.dataset.calibrationDirty=String(hasChanges);
        $('capture').disabled=busy||!data; $('reset').disabled=busy||!data; $('save').disabled=busy||!frame||!hasChanges;
        $('tap').disabled=busy||!frame||!image||current()?.kind!=='point';
        for(const id of ['x','y','w','h']) $(id).disabled=busy||!image;
    }
    function select(){
        const p=current(); if(!p)return;
        document.querySelectorAll('.target-item').forEach(button=>{const selected=button.dataset.target===p.id;button.classList.toggle('is-selected',selected);button.setAttribute('aria-pressed',String(selected));});
        const rect=p.kind==='region';$('widthLabel').hidden=$('heightLabel').hidden=!rect;
        $('screenHint').textContent=rect?(['account_total','lobby_trophies'].includes(p.id)?'В лобби выделите рамкой только нужное число кубков, без значка и соседних счётчиков.':'В списке бойцов выделите рамку на первой карточке после сортировки.'):`Экран: ${p.screen}. Отметьте центр элемента.`;
        if(image){const coords=physical(value(p));['x','y','w','h'].forEach((id,i)=>$(id).value=Math.round(coords[i]||0));}
        controls();draw();
    }
    function draw(){
        if(!image)return;ctx.drawImage(image,0,0,canvas.width,canvas.height);
        const p=current(), coords=physical(value(p));ctx.lineWidth=Math.max(2,canvas.width/600);ctx.strokeStyle='#39f6b2';
        if(p.kind==='region'){const box=drag||coords;ctx.strokeRect(...box);}
        else {const [x,y]=coords;const r=canvas.width/70;ctx.beginPath();ctx.moveTo(x-r,y);ctx.lineTo(x+r,y);ctx.moveTo(x,y-r);ctx.lineTo(x,y+r);ctx.arc(x,y,r*.6,0,Math.PI*2);ctx.stroke();}
    }
    function mark(coords){
        const p=current();(p.kind==='point'?dirtyPoints:dirtyRegions)[p.id]=coords;
        updateOptions();notify('Есть несохранённые изменения. Можно обновлять снимок — отметки сохранятся до нажатия «Сохранить».');
    }
    function at(event){const r=canvas.getBoundingClientRect();return [Math.max(0,Math.min(1919,(event.clientX-r.left)*1920/r.width)),Math.max(0,Math.min(1079,(event.clientY-r.top)*1080/r.height))];}
    canvas.addEventListener('pointerdown',event=>{
        if(busy||!image)return;canvas.setPointerCapture(event.pointerId);start=at(event);
        if(current().kind==='point'){mark(start);start=null;}
    });
    canvas.addEventListener('pointermove',event=>{
        if(!start)return;const end=at(event);drag=physical([Math.min(start[0],end[0]),Math.min(start[1],end[1]),Math.abs(end[0]-start[0]),Math.abs(end[1]-start[1])]);draw();
    });
    canvas.addEventListener('pointerup',event=>{
        if(!start)return;const end=at(event), box=[Math.min(start[0],end[0]),Math.min(start[1],end[1]),Math.abs(end[0]-start[0]),Math.abs(end[1]-start[1])];start=drag=null;
        if(box[2]>=1&&box[3]>=1)mark(box);else draw();
    });
    canvas.addEventListener('pointercancel',()=>{start=drag=null;draw();});
    $('target').addEventListener('change',()=>{start=drag=null;select();});
    $('targetList')?.addEventListener('click',event=>{const button=event.target.closest('[data-target]');if(button){$('target').value=button.dataset.target;start=drag=null;select();}});
    for(const id of ['x','y','w','h']) $(id).addEventListener('change',()=>{
        if(!image)return;const count=current().kind==='point'?2:4;
        const vals=['x','y','w','h'].slice(0,count).map((key,i)=>Number($(key).value)*(i%2===0?1920/canvas.width:1080/canvas.height));
        if(vals.some(v=>!Number.isFinite(v))||vals[0]<0||vals[0]>=1920||vals[1]<0||vals[1]>=1080||(count===4&&(vals[2]<1||vals[3]<1||vals[0]+vals[2]>1920||vals[1]+vals[3]>1080))){notify('Координаты должны помещаться на снимке.','error');select();return;}
        mark(vals);
    });
    async function capture(){
        const response=await api('/snapshot');const blob=await response.blob();const url=URL.createObjectURL(blob);
        const next=new Image();try {next.src=url;await next.decode();}finally{URL.revokeObjectURL(url);}
        frame=response.headers.get('X-Calibration-Frame');image=next;canvas.width=next.naturalWidth;canvas.height=next.naturalHeight;
        canvas.style.display='block';$('empty').hidden=true;$('resolution').textContent=`${canvas.width} × ${canvas.height}`;select();
        notify('Снимок получен. Выберите элемент слева и отметьте его положение.');
    }
    async function action(fn){if(busy)return;busy=true;controls();try{await fn();}catch(error){notify(error.message,'error');}finally{busy=false;controls();}}
    $('capture').addEventListener('click',()=>action(capture));
    $('tap').addEventListener('click',()=>action(async()=>{
        const p=current();await api('/tap',{point:p.id,value:value(p),frame});frame=null;
        await new Promise(resolve=>setTimeout(resolve,700));await capture();
    }));
    $('save').addEventListener('click',()=>action(async()=>{
        data=await (await api('',{points:dirtyPoints,regions:dirtyRegions,frame})).json();
        Object.keys(dirtyPoints).forEach(k=>delete dirtyPoints[k]);Object.keys(dirtyRegions).forEach(k=>delete dirtyRegions[k]);updateOptions();notify('Калибровка сохранена для этого устройства. Бот использует её при следующем запуске.','success');
    }));
    $('reset').addEventListener('click',()=>{
        if(!confirm('Вернуть стандартные точки выбора бойца только для этого устройства?'))return;
        action(async()=>{data=await (await api('/reset',{})).json();Object.keys(dirtyPoints).forEach(k=>delete dirtyPoints[k]);Object.keys(dirtyRegions).forEach(k=>delete dirtyRegions[k]);updateOptions();notify('Стандартные точки восстановлены. Остальные настройки устройства сохранены.','success');});
    });
    controls();
    api().then(r=>r.json()).then(result=>{data=result;updateOptions();notify('Профиль загружен. Остановите бот, затем получите экран устройства.');}).catch(error=>notify(error.message,'error'));
})();
