const role=document.querySelector('#role');const list=document.querySelector('#requests');const notice=document.querySelector('#notice');
const labels={submitted:'Отправлено',in_review:'На рассмотрении',in_progress:'В работе',resolved:'Решено',rejected:'Отклонено',reopened:'Пересмотр'};
const routes={submitted:['in_review','rejected'],in_review:['in_progress','resolved','rejected'],in_progress:['resolved','rejected'],resolved:['reopened'],rejected:['reopened'],reopened:['in_review','in_progress']};
function el(name,cls,text){const e=document.createElement(name);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;}
async function api(path,options={}){const response=await fetch(path,{...options,headers:{'Content-Type':'application/json','Authorization':'Bearer '+role.value,...options.headers}});const data=await response.json();if(!response.ok)throw Error(data.error||'Ошибка');return data;}
async function load(){try{const data=await api('/api/requests');document.querySelector('#count').textContent=data.length;list.replaceChildren();if(!data.length)list.append(el('p','empty','Пока нет обращений. Создайте первое.'));for(const item of data){const card=el('article','request');const top=el('div','request-head');top.append(el('b',null,item.title),el('span','status',labels[item.status]));card.append(top,el('p',null,item.description),el('small',null,(item.kind==='idea'?'Идея':'Проблема')+' · '+new Date(item.createdAt).toLocaleString('ru-RU')));const actions=el('div','actions');for(const status of routes[item.status]||[]){if(role.value==='demo-employee'&&status!=='reopened')continue;if(role.value==='demo-manager'&&status==='reopened')continue;const b=el('button','secondary',labels[status]);b.type='button';b.addEventListener('click',async()=>{try{await api('/api/requests/'+item.id+'/status',{method:'PATCH',body:JSON.stringify({status})});notice.textContent='Статус обновлён';await load();}catch(e){notice.textContent=e.message;}});actions.append(b);}card.append(actions);list.append(card);}}catch(e){notice.textContent=e.message;}}
document.querySelector('#form').addEventListener('submit',async(e)=>{e.preventDefault();const f=e.currentTarget;const data=Object.fromEntries(new FormData(f));try{await api('/api/requests',{method:'POST',body:JSON.stringify(data)});f.reset();notice.textContent='Обращение зарегистрировано';await load();}catch(error){notice.textContent=error.message;}});
role.addEventListener('change',load);document.querySelector('#reload').addEventListener('click',load);load();


const draftSteps=[
 ['observation','Что ты заметил?','Расскажи своими словами. Не нужно идеального описания.'],
 ['cause','Почему это может происходить?','Это предположение, а не установленный факт. Какие есть альтернативные объяснения?'],
 ['evidence','Что подтверждает твоё наблюдение?','Если доказательств пока нет, этот шаг можно пропустить.'],
 ['proposal','Что именно ты предлагаешь изменить?','Попробуй описать одно конкретное действие.'],
 ['risks','Что может пойти не так?','Кого затронет изменение и что мы могли упустить?'],
 ['pilot','Как проверить идею безопасно и недорого?','Как поймём, что эксперимент сработал?']
];
let activeDraft=null,activeStep=0;
function makeButton(label,handler,cls='secondary'){const b=el('button',cls,label);b.type='button';b.addEventListener('click',handler);return b;}
function renderWorkspace(d){
 const root=document.querySelector('#workspace');root.replaceChildren();activeDraft=d;
 if(!d||d.state!=='private')return;
 const step=draftSteps[activeStep],saved=d.steps[step[0]]||'';
 root.append(el('p','eyebrow','ПРИВАТНАЯ ПРОРАБОТКА · ШАГ '+(activeStep+1)+' ИЗ '+draftSteps.length));
 root.append(el('h3',null,step[1]),el('p','hint',step[2]));
 const input=el('textarea');input.value=saved;input.maxLength=5000;input.rows=4;input.placeholder='Запиши мысль как есть...';root.append(input);
 const status=el('p','hint',saved?'Шаг сохранён ранее':'Можно пропустить и вернуться позже');root.append(status);
 const nav=el('div','actions');
 if(activeStep>0)nav.append(makeButton('Назад',()=>{activeStep--;renderWorkspace(d)}));
 nav.append(makeButton('Сохранить',async()=>{try{const updated=await api('/api/drafts/'+d.id,{method:'PATCH',body:JSON.stringify({step:step[0],text:input.value})});activeDraft=updated;status.textContent='Сохранено · '+new Date(updated.updatedAt).toLocaleTimeString('ru-RU');}catch(e){status.textContent=e.message;}}));
 if(activeStep<draftSteps.length-1)nav.append(makeButton('Далее',()=>{activeStep++;renderWorkspace(activeDraft)}));
 root.append(nav);
 const preview=el('section','preview');preview.append(el('h3',null,'Перед публикацией'));
 preview.append(el('p','hint','Опубликуются только наблюдение, предложение и план проверки. Остальные размышления останутся приватными.'));
 const publish=makeButton('Опубликовать подготовленную идею',async()=>{
  if(!confirm('Публикуем подготовленную версию? Приватная история не будет раскрыта.'))return;
  try{await api('/api/drafts/'+d.id+'/publish',{method:'POST',body:'{}'});notice.textContent='Идея опубликована';activeDraft=null;root.replaceChildren();await load();await loadDrafts();}catch(e){notice.textContent=e.message;}
 },'primary');
 preview.append(publish);root.append(preview);
}
async function loadDrafts(){
 const root=document.querySelector('#drafts');if(!root)return;
 try{
  const data=await api('/api/drafts');root.replaceChildren();
  if(!data.length)root.append(el('p','empty','Создайте первую приватную идею.'));
  for(const d of data){
   const card=el('article','request');card.append(el('b',null,d.title),el('small',null,d.state==='private'?' · Только вы':' · Опубликовано'));
   if(d.state==='private')card.append(makeButton('Продолжить размышление',()=>{activeStep=0;renderWorkspace(d)}));
   root.append(card);
  }
  if(activeDraft){const fresh=data.find(x=>x.id===activeDraft.id);if(fresh?.state==='private')renderWorkspace(fresh);else document.querySelector('#workspace').replaceChildren();}
 }catch(e){notice.textContent=e.message;}
}
document.querySelector('#draft-create').addEventListener('submit',async e=>{e.preventDefault();const form=e.currentTarget;try{const d=await api('/api/drafts',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(form)))});form.reset();notice.textContent='Приватная идея создана';activeStep=0;activeDraft=d;await loadDrafts();}catch(error){notice.textContent=error.message;}});
role.addEventListener('change',()=>{activeDraft=null;document.querySelector('#workspace').replaceChildren();loadDrafts()});
loadDrafts();
