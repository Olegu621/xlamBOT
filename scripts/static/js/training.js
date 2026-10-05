/* xlamBOT: model-aware bounding box annotation. */
(() => {
'use strict';
const $ = id => document.getElementById(id), canvas=$('trCanvas'), ctx=canvas.getContext('2d');
let token=document.querySelector('meta[name="xlam-ui-token"]').content, session=window.XLAM_SESSION;
const base='/api/training/sessions/'+encodeURIComponent(session);
const colours={gas:'#50ddb2',bush:'#ffd16b',wall:'#6aabff',close_bush:'#c698ff',enemy:'#ff8585',teammate:'#6ae0f0',player:'#fb91d3'};
let classes=[], frames=[], index=0, selected=-1, activeClass='gas', tool='draw', image=null;
let view={x:0,y:0,scale:1}, gesture=null, space=false, undo=[], redo=[], timer, chain=Promise.resolve(), loadingVersion=0;
const clone=value=>JSON.parse(JSON.stringify(value));
const frame=()=>frames[index];
const boxes=()=>frame()?.boxes || [];
const clamp=(v,min,max)=>Math.max(min,Math.min(max,v));
const esc=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const label=name=>classes.find(c=>c.value===name)?.label || name;
const draftKey=f=>'xlam-label:'+session+':'+f.file;
const imageUrl=f=>base+'/images/'+encodeURIComponent(f.file)+'?t='+encodeURIComponent(token);
function toast(message,kind=''){ $('trToast').textContent=message;$('trToast').className='tr-toast '+(kind?'is-'+kind:'');clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('trToast').classList.add('hidden'),4500); }
window.addEventListener('xlam-session-refreshed',event=>{token=event.detail;});
async function api(path,opts={}){
 const response=await window.XlamSession.fetch(path,{...opts,headers:{'X-Xlam-UI-Token':token,'Content-Type':'application/json',...opts.headers},body:opts.body===undefined?undefined:JSON.stringify(opts.body)});
 let data;try{data=await response.json();}catch{throw new Error('Сервер вернул неверный ответ');}
 if(!response.ok)throw new Error(data.message||data.error||('HTTP '+response.status));return data;
}
function draft(f){try{localStorage.setItem(draftKey(f),JSON.stringify({boxes:f.boxes,checked:f.checked,excluded:!!f.excluded,revision:f.revision||0}));}catch{toast('Локальная копия недоступна. Сохраняйте на сервер перед закрытием.','error');}}
function status(){const f=frame();if(!f)return;$('trSaveState').textContent=f._error?'Ошибка сохранения':f._dirty?'Есть несохранённые правки':f._saving?'Сохраняется…':'Сохранено';}
function progress(){const count=frames.filter(f=>f.checked).length;$('trProgressFill').style.width=(100*count/Math.max(1,frames.length))+'%';$('trProgressText').textContent=`проверено ${count} / ${frames.length}`;$('trDownload').disabled=frames.filter(f=>!f.excluded).length<2||count!==frames.length||frames.some(f=>f._error||f._dirty||f._saving);$('trReview').textContent=frame()?.excluded?'Кадр пропущен':frame()?.checked?'Кадр проверен ✓':'Кадр проверен';status();}
function strip(){ $('trStrip').innerHTML=frames.map((f,i)=>`<button class="tr-cell${i===index?' is-current':''}" data-index="${i}" aria-label="Кадр ${i+1}${f.checked?', проверен':''}"><img loading="lazy" src="${imageUrl(f)}" alt=""><span>${i+1} · ${(f.boxes||[]).length}</span>${f.checked?'<span class="tr-cell-tick">'+(f.excluded?'×':'✓')+'</span>':''}</button>`).join('');progress();}
function help(){const c=classes.find(c=>c.value===activeClass);$('trClassHelp').innerHTML=c?`<strong>${esc(c.label)}</strong><p>${esc(c.hint)}</p><small>${c.models.map(esc).join(', ')}</small>`:'';}
function renderClasses(){ $('trClasses').innerHTML=classes.map((c,i)=>`<button class="tr-class${c.value===activeClass?' is-active':''}" data-class="${esc(c.value)}" style="--c:${colours[c.value]||'#9cbbd5'}"><span class="tr-class-dot"></span>${esc(c.label)}<kbd>${i+1}</kbd></button>`).join('');$('trBoxClass').innerHTML=classes.map(c=>`<option value="${esc(c.value)}">${esc(c.label)}</option>`).join('');help(); }
function inspector(){ $('trBoxCount').textContent=boxes().length;$('trBoxes').innerHTML=boxes().map((b,i)=>`<button class="tr-object${selected===i?' is-active':''}" data-box="${i}"><span>${i+1}. ${esc(label(b.cls))}</span><small>${Math.round(b.x2-b.x1)} × ${Math.round(b.y2-b.y1)}</small></button>`).join('');for(const id of ['trBoxClass','trDuplicate','trDelete'])$(id).disabled=selected<0;if(selected>=0)$('trBoxClass').value=boxes()[selected].cls;const tiny=boxes().filter(b=>b.x2-b.x1<8||b.y2-b.y1<8).length;$('trValidation').textContent=tiny?`${tiny} очень маленьких рамок: увеличьте масштаб и проверьте границы.`:''; }
function snapshot(){return {boxes:clone(boxes()),checked:!!frame().checked,excluded:!!frame().excluded};}
function remember(){undo.push(snapshot());if(undo.length>80)undo.shift();redo=[];}
function changed(uncheck=true){const f=frame();if(uncheck){f.checked=false;f.excluded=false;}f._version=(f._version||0)+1;f._dirty=true;f._error='';draft(f);clearTimeout(timer);timer=setTimeout(save,650);inspector();strip();draw();}
async function save(target=frame()){const f=target;if(!f)return true;if(!f._dirty){await chain;return !f._error;}
 const version=f._version, payload={frame:f.file,boxes:clone(f.boxes),checked:!!f.checked,excluded:!!f.excluded};f._dirty=false;f._saving=true;status();progress();
 const pending=chain.then(()=>api(base+'/labels',{method:'POST',body:{...payload,revision:f.revision||0}}));chain=pending.catch(()=>{});
 try{const data=await pending;f.revision=data.frame.revision;f._error='';if(f._version===version){f.boxes=data.frame.boxes;f.checked=data.frame.checked;f.excluded=!!data.frame.excluded;try{localStorage.removeItem(draftKey(f));}catch{}}else draft(f);return true;}
 catch(error){f._dirty=true;f._error=error.message;draft(f);toast('Не сохранилось: '+error.message,'error');return false;}
 finally{f._saving=false;progress();if(f===frame())inspector();}
}
async function flush(){clearTimeout(timer);await chain;for(let i=0;i<8;i++){const pending=frames.filter(f=>f._dirty);if(!pending.length)break;for(const f of pending){if(!(await save(f)))return false;}}return !frames.some(f=>f._dirty||f._error||f._saving);}
async function show(next){if(image && !(await flush()))return;index=clamp(next,0,frames.length-1);selected=-1;undo=[];redo=[];gesture=null;image=null;const version=++loadingVersion;$('trFrameNo').textContent=index+1;$('trFrameTotal').textContent=frames.length;$('trLoading').textContent='Загрузка кадра…';$('trLoading').classList.remove('hidden');strip();inspector();
 const img=new Image();img.onload=()=>{if(version!==loadingVersion)return;image=img;fit();$('trLoading').classList.add('hidden');};img.onerror=()=>{if(version===loadingVersion)$('trLoading').textContent='Кадр не загрузился. Попробуйте перейти к нему снова.';};img.src=imageUrl(frame()); }
function resize(){const r=canvas.parentElement.getBoundingClientRect();canvas.width=Math.max(1,Math.round(r.width));canvas.height=Math.max(1,Math.round(r.height));draw();}
function fit(){resize();if(!image)return;view.scale=Math.min((canvas.width-24)/image.width,(canvas.height-24)/image.height);view.x=(canvas.width-image.width*view.scale)/2;view.y=(canvas.height-image.height*view.scale)/2;draw();}
function zoom(factor,x=canvas.width/2,y=canvas.height/2){if(!image)return;const scale=clamp(view.scale*factor,.05,8),ratio=scale/view.scale;view.x=x-(x-view.x)*ratio;view.y=y-(y-view.y)*ratio;view.scale=scale;draw();}
function point(event){const r=canvas.getBoundingClientRect();return {x:(event.clientX-r.left-view.x)/view.scale,y:(event.clientY-r.top-view.y)/view.scale,sx:event.clientX-r.left,sy:event.clientY-r.top};}
function normal(b){return {...b,x1:Math.min(b.x1,b.x2),x2:Math.max(b.x1,b.x2),y1:Math.min(b.y1,b.y2),y2:Math.max(b.y1,b.y2)};}
function draw(){ctx.clearRect(0,0,canvas.width,canvas.height);if(!image)return;ctx.save();ctx.translate(view.x,view.y);ctx.scale(view.scale,view.scale);ctx.drawImage(image,0,0);const list=boxes().concat(gesture?.type==='draw'?[normal(gesture.box)]:[]);
 list.forEach((b,i)=>{ctx.strokeStyle=colours[b.cls]||'#9cbbd5';ctx.fillStyle=ctx.strokeStyle+'18';ctx.fillRect(b.x1,b.y1,b.x2-b.x1,b.y2-b.y1);ctx.lineWidth=(selected===i?2.5:1.5)/view.scale;ctx.strokeRect(b.x1,b.y1,b.x2-b.x1,b.y2-b.y1);ctx.font=`${12/view.scale}px "Segoe UI"`;const text=(i+1)+'. '+label(b.cls),w=ctx.measureText(text).width+8/view.scale;ctx.fillStyle=ctx.strokeStyle;ctx.fillRect(b.x1,Math.max(0,b.y1-18/view.scale),w,18/view.scale);ctx.fillStyle='#07111d';ctx.fillText(text,b.x1+4/view.scale,Math.max(13/view.scale,b.y1-5/view.scale));if(i===selected){ctx.fillStyle='#fff';for(const x of [b.x1,b.x2])for(const y of [b.y1,b.y2])ctx.fillRect(x-4/view.scale,y-4/view.scale,8/view.scale,8/view.scale);}});ctx.restore();$('trZoom').textContent=Math.round(view.scale*100)+'%'; }
function select(i){selected=i;inspector();draw();}
canvas.addEventListener('pointerdown',event=>{if(!image||event.button!==0)return;canvas.focus();const p=point(event);canvas.setPointerCapture(event.pointerId);if(space){gesture={type:'pan',sx:p.sx,sy:p.sy,x:view.x,y:view.y};return;}const b=boxes()[selected],radius=9/view.scale;
 if(b){for(const [xkey,ykey] of [['x1','y1'],['x2','y1'],['x1','y2'],['x2','y2']])if(Math.hypot(p.x-b[xkey],p.y-b[ykey])<radius){remember();frame()._version=(frame()._version||0)+1;gesture={type:'resize',xkey,ykey,start:snapshot(),i:selected};return;}}
 const hit=boxes().map((b,i)=>({b,i})).reverse().find(({b})=>p.x>=b.x1&&p.x<=b.x2&&p.y>=b.y1&&p.y<=b.y2);
 if(hit && !event.altKey){select(hit.i);if(tool==='select'){remember();frame()._version=(frame()._version||0)+1;gesture={type:'move',p,box:clone(hit.b),i:hit.i};}return;}
 if(tool==='select'){select(-1);return;}if(p.x<0||p.y<0||p.x>image.width||p.y>image.height)return;selected=-1;gesture={type:'draw',box:{cls:activeClass,x1:p.x,y1:p.y,x2:p.x,y2:p.y}};draw(); });
canvas.addEventListener('pointermove',event=>{if(!image)return;const p=point(event);$('trCoordinates').textContent=`${Math.round(p.x)}, ${Math.round(p.y)} px · ${image.width} × ${image.height} · Alt — новая рамка поверх другой · пробел — перемещение`;
 if(!gesture)return;const g=gesture;if(g.type==='pan'){view.x=g.x+p.sx-g.sx;view.y=g.y+p.sy-g.sy;}
 if(g.type==='draw'){g.box.x2=clamp(p.x,0,image.width);g.box.y2=clamp(p.y,0,image.height);}
 if(g.type==='resize'){boxes()[g.i][g.xkey]=clamp(p.x,0,image.width);boxes()[g.i][g.ykey]=clamp(p.y,0,image.height);}
 if(g.type==='move'){const dx=clamp(p.x-g.p.x,-g.box.x1,image.width-g.box.x2),dy=clamp(p.y-g.p.y,-g.box.y1,image.height-g.box.y2);boxes()[g.i]={...g.box,x1:g.box.x1+dx,x2:g.box.x2+dx,y1:g.box.y1+dy,y2:g.box.y2+dy};}draw(); });
function finishGesture(cancel=false){if(!gesture)return;const g=gesture;gesture=null;if(g.type==='pan'){draw();return;}
 if(g.type==='draw'){const b=normal(g.box);if(!cancel && b.x2-b.x1>=4 && b.y2-b.y1>=4){remember();boxes().push(b);selected=boxes().length-1;changed();}else draw();return;}
 const b=normal(boxes()[g.i]);if(cancel||b.x2-b.x1<4||b.y2-b.y1<4){const prev=undo.pop();if(prev){frame().boxes=prev.boxes;frame().checked=prev.checked;}draw();inspector();}else{boxes()[g.i]=b;changed();}}
canvas.addEventListener('pointerup',()=>finishGesture());canvas.addEventListener('pointercancel',()=>finishGesture(true));canvas.addEventListener('lostpointercapture',()=>finishGesture());
canvas.addEventListener('wheel',event=>{event.preventDefault();const p=point(event);zoom(event.deltaY<0?1.15:1/1.15,p.sx,p.sy);},{passive:false});
function history(from,to){if(!from.length)return;to.push(snapshot());const state=from.pop();frame().boxes=state.boxes;frame().checked=state.checked;frame().excluded=state.excluded;selected=-1;changed(false);}
function remove(){if(selected<0)return;remember();boxes().splice(selected,1);selected=-1;changed();}
function copy(){if(selected<0)return;remember();const b=clone(boxes()[selected]);const dx=Math.min(12,image.width-b.x2),dy=Math.min(12,image.height-b.y2);b.x1+=dx;b.x2+=dx;b.y1+=dy;b.y2+=dy;boxes().push(b);selected=boxes().length-1;changed();}
$('trClasses').addEventListener('click',event=>{const el=event.target.closest('[data-class]');if(el){activeClass=el.dataset.class;renderClasses();}});
$('trBoxes').addEventListener('click',event=>{const el=event.target.closest('[data-box]');if(el)select(Number(el.dataset.box));});
$('trStrip').addEventListener('click',event=>{const el=event.target.closest('[data-index]');if(el)show(Number(el.dataset.index));});
$('trBoxClass').addEventListener('change',()=>{if(selected>=0){remember();boxes()[selected].cls=$('trBoxClass').value;changed();}});
$('trDraw').onclick=()=>{tool='draw';$('trDraw').classList.add('is-active');$('trSelect').classList.remove('is-active');};
$('trSelect').onclick=()=>{tool='select';$('trSelect').classList.add('is-active');$('trDraw').classList.remove('is-active');};
$('trUndo').onclick=()=>history(undo,redo);$('trRedo').onclick=()=>history(redo,undo);$('trDelete').onclick=remove;$('trDuplicate').onclick=copy;
$('trZoomIn').onclick=()=>zoom(1.25);$('trZoomOut').onclick=()=>zoom(.8);$('trFit').onclick=fit;
$('trPrev').onclick=()=>show(index-1);$('trNext').onclick=()=>show(index+1);$('trSave').onclick=async()=>{if(await flush())toast('Разметка сохранена','ok');};
$('trReview').onclick=async()=>{if(!image)return;remember();frame().checked=true;frame().excluded=false;changed(false);if(await flush())toast('Кадр проверен','ok');};
$('trEmpty').onclick=async()=>{if(!image)return;if(boxes().length){toast('На кадре есть рамки. Удалите их или подтвердите кадр с объектами.');return;}remember();frame().checked=true;frame().excluded=false;changed(false);if(await flush())toast('Пустой кадр подтверждён','ok');};
$('trSkip').onclick=async()=>{if(!image)return;remember();frame().checked=true;frame().excluded=true;changed(false);if(await flush())toast('Кадр пропущен, в датасет он не попадёт.','ok');};
$('trDownload').onclick=async()=>{if(!(await flush()))return;if(frames.some(f=>!f.checked)){toast('Сначала проверьте каждый кадр.','error');return;}$('trDownload').disabled=true;try{const response=await window.XlamSession.fetch(base+'/export.zip',{headers:{'X-Xlam-UI-Token':token}});if(!response.ok){const data=await response.json();throw new Error(data.message||'Экспорт не удался');}const url=URL.createObjectURL(await response.blob()),a=document.createElement('a');a.href=url;a.download='xlamBOT-model-datasets.zip';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('ZIP содержит общий набор и отдельный датасет для каждого детектора.','ok');}catch(error){toast(error.message,'error');}finally{progress();}};
document.addEventListener('keydown',event=>{if(/INPUT|SELECT|TEXTAREA/.test(event.target.tagName))return;if(event.code==='Space'){event.preventDefault();space=true;}if(!image)return;
 if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='z'){event.preventDefault();history(event.shiftKey?redo:undo,event.shiftKey?undo:redo);return;}
 if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='s'){event.preventDefault();$('trSave').click();return;}
 if(event.key==='Delete'||event.key==='Backspace'){event.preventDefault();remove();}
 if(event.key==='Escape'){finishGesture(true);select(-1);}
 if(/^[1-9]$/.test(event.key)){const c=classes[Number(event.key)-1];if(c){activeClass=c.value;renderClasses();}}
 if(event.key==='Enter'){event.preventDefault();$('trReview').click();}
 if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)){event.preventDefault();if(selected<0){if(event.key==='ArrowLeft')show(index-1);if(event.key==='ArrowRight')show(index+1);}else{remember();const b=boxes()[selected],step=event.shiftKey?10:1;const dx=clamp(event.key==='ArrowRight'?step:event.key==='ArrowLeft'?-step:0,-b.x1,image.width-b.x2),dy=clamp(event.key==='ArrowDown'?step:event.key==='ArrowUp'?-step:0,-b.y1,image.height-b.y2);b.x1+=dx;b.x2+=dx;b.y1+=dy;b.y2+=dy;changed();}}
});
document.addEventListener('keyup',event=>{if(event.code==='Space')space=false;});window.addEventListener('blur',()=>{space=false;finishGesture(true);});window.addEventListener('resize',resize);
window.addEventListener('beforeunload',event=>{if(frames.some(f=>f._dirty||f._saving||f._error)){event.preventDefault();event.returnValue='';}});
async function load(){const data=await api(base);classes=data.classes;frames=data.session.items;activeClass=classes[0]?.value||'gas';let recovered=0;for(const f of frames){f.boxes=f.boxes||[];try{const raw=localStorage.getItem(draftKey(f));if(raw){const d=JSON.parse(raw);if((d.revision||0)===(f.revision||0)){f.boxes=d.boxes;f.checked=false;f.excluded=!!d.excluded;f._dirty=true;f._version=1;recovered++;}else toast('Есть локальный черновик другой версии. Серверная разметка сохранена; не перезаписываю её.','error');}}catch{}}
 renderClasses();if(data.session.review_notice){$('trReviewNotice').textContent=data.session.review_notice;$('trReviewNotice').classList.remove('hidden');}
$('trModelInfo').innerHTML=(data.session.models||[]).map(m=>`<p><strong>${esc(m.file)}</strong><br>${m.classes.map((c,i)=>`${i}: ${esc(label(c))}`).join(' · ')}</p>`).join('');if(!frames.length){$('trLoading').textContent='В записи нет кадров. Запишите матч через панель бота.';return;}await show(0);if(recovered)toast(`Восстановлены локальные черновики: ${recovered}. Проверьте и сохраните.`);}
load().catch(error=>{$('trLoading').textContent='Не удалось открыть: '+error.message;});
})();
