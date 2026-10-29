import {destinations} from '../shared-ui/navigation.mjs';
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
 if(message?.type==='HCT_PO_NAV'&&sender?.tab?.id){respond({ok:true,entries:destinations.map(x=>({label:x.label,url:x.local?chrome.runtime.getURL(x.local):x.href}))});return;}
 if(message?.type==='HCT_PO_BRAND'&&sender?.tab?.id){fetch(chrome.runtime.getURL('shared-ui/assets/hc-icon.webp')).then(r=>r.arrayBuffer()).then(bytes=>{let s='';for(const b of new Uint8Array(bytes))s+=String.fromCharCode(b);respond({ok:true,url:'data:image/webp;base64,'+btoa(s)});}).catch(()=>respond({ok:false}));return true;}
 if(message?.type==='HCT_PO_STYLE'&&sender?.tab?.id){fetch(chrome.runtime.getURL('shared-ui/hc.css')).then(r=>r.text()).then(css=>respond({ok:true,css})).catch(()=>respond({ok:false}));return true;}
 if(message?.type==='HCT_PO_REVIEW'){chrome.windows.create({url:chrome.runtime.getURL('po-companion/review.html'),type:'popup',width:980,height:800}).then(()=>respond({ok:true}),()=>respond({ok:false}));return true;}
 if(['HCT_PO_LOGIN','HCT_PO_LOAD'].includes(message?.type)){respond({ok:false,error:'Authenticated read-only PO gateway is not yet verified or enabled.'});return;}
 if(message?.type==='HCT_PO_LOGOUT')respond({ok:true});
});
