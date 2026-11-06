// Read-only review. There is intentionally no authenticated write action.
(async()=>{
 const {poCompanionContext:context,poCompanionDrafts:drafts={}}=await chrome.storage.local.get(['poCompanionContext','poCompanionDrafts']);
 const title=document.getElementById('po'), container=document.getElementById('changes');
 if(!context?.poId){title.textContent='No selected PO.';return;}
 title.textContent='Lightspeed PO '+context.poId;
 const key=String(context.poId)+':'+String(context.supplierId||'unresolved');
 const draft=drafts[key];
 if(!draft){container.textContent='No saved draft for this purchase order.';return;}
 const selected=Object.entries(draft.items||{}).filter(([,entry])=>entry.selected);
 if(!selected.length){container.textContent='No lines selected for review.';return;}
 for(const [lineId,entry] of selected){
  const card=document.createElement('article'),name=document.createElement('h2');name.textContent='PO line '+lineId;
  const table=document.createElement('table'),head=document.createElement('tr');
  for(const txt of ['Field','Original Lightspeed value','Proposed']){const th=document.createElement('th');th.textContent=txt;head.append(th);}
  table.append(head);
  for(const [field,value] of Object.entries(entry.proposed||{})){if(value===''||value===null)continue;
   const tr=document.createElement('tr');
   for(const txt of [field,'Not verified — live read required',String(value)]){const td=document.createElement('td');td.textContent=txt;tr.append(td);}
   table.append(tr);
  }
  card.append(name,table);container.append(card);
 }
})();