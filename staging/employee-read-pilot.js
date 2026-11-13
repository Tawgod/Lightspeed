// Browser-only isolated test station. Never reuse this client for real
// employees or Chrome extension release. Device private key is generated
// non-exportable and is stored only as a CryptoKey in browser IndexedDB.
const prefix='/HobbyCorner';
const node=id=>document.getElementById(id);
let bearer=null,stationProof=null;
const state={station:null,busy:false};
const encoder=new TextEncoder();
const api=async(path,{method='GET',body,headers={}}={})=>{
  const res=await fetch(prefix+path,{
    method,cache:'no-store',credentials:'omit',
    headers:{...(body?{'content-type':'application/json'}:{}),
      ...(bearer?{authorization:'Bearer '+bearer}:{}),...headers},
    ...(body?{body:JSON.stringify(body)}:{})
  });
  let data;
  try{data=await res.json();}catch{data={error:'Unexpected response'};}
  if(!res.ok)throw new Error(data.error||('Access denied ('+res.status+')'));
  return data;
};
function setStatus(id,message){node(id).textContent=message;}
function setResult(value){node('result').textContent=typeof value==='string'?value:JSON.stringify(value,null,2);}
const toB64=buffer=>{
  const b=new Uint8Array(buffer);
  let text='';
  for(const byte of b)text+=String.fromCharCode(byte);
  return btoa(text).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
};
async function storage(){
  return new Promise((resolve,reject)=>{
    const opened=indexedDB.open('hc-isolated-pilot-station',1);
    opened.onupgradeneeded=()=>{
      if(!opened.result.objectStoreNames.contains('keys'))
        opened.result.createObjectStore('keys');
    };
    opened.onerror=()=>reject(Error('Browser device storage unavailable.'));
    opened.onsuccess=()=>resolve(opened.result);
  });
}
async function loadStation(){
  const db=await storage();
  try{
    return await new Promise((resolve,reject)=>{
      const tx=db.transaction('keys','readonly');
      const req=tx.objectStore('keys').get('station');
      req.onsuccess=()=>resolve(req.result||null);
      req.onerror=()=>reject(Error('Cannot read registered station.'));
    });
  }finally{db.close();}
}
async function saveStation(data){
  const db=await storage();
  try{
    await new Promise((resolve,reject)=>{
      const tx=db.transaction('keys','readwrite');
      tx.objectStore('keys').put(data,'station');
      tx.oncomplete=()=>resolve();
      tx.onerror=()=>reject(Error('Cannot preserve registered station.'));
    });
  }finally{db.close();}
}
async function withButton(id,work){
  const btn=node(id);
  if(state.busy)return;
  state.busy=true;btn.disabled=true;
  try{await work();}catch(error){setResult(error.message||'Test action was denied.');}
  finally{state.busy=false;btn.disabled=false;}
}
node('login').addEventListener('submit',async event=>{
  event.preventDefault();
  await withButton('login',async()=>{
    const pin=node('pin').value.trim();
    node('pin').value='';
    if(!/^\d{4}$/.test(pin))throw Error('Use the synthetic four-digit test PIN.');
    const data=await api('/api/staff-auth/session',{method:'POST',body:{pin}});
    bearer=data.token;stationProof=null;
    setStatus('login-state','Signed in as synthetic employee '+data.employee.id+
      '. Session expires in '+Math.round(data.expiresIn/60)+' minutes.');
    setStatus('proof-state','No active proof for this new session');
    setResult('Signed test session accepted. Verify workstation next.');
  });
});
node('register').addEventListener('click',()=>withButton('register',async()=>{
  if(!bearer)throw Error('Sign in with the synthetic test PIN first.');
  if(state.station)throw Error('This browser already has a registered test station.');
  const operatorKey=node('operator-key').value;
  node('operator-key').value='';
  if(!/^[A-Za-z0-9_-]{43,128}$/.test(operatorKey))
    throw Error('A separate high-entropy test operator key is required.');
  const pair=await crypto.subtle.generateKey({name:'Ed25519'},false,['sign','verify']);
  const publicKeySpki=toB64(await crypto.subtle.exportKey('spki',pair.publicKey));
  const registered=await api('/api/pilot/register-station',{
    method:'POST',headers:{'x-hc-pilot-operator-key':operatorKey},
    body:{publicKeySpki,label:'Isolated browser pilot device'}
  });
  const saved={deviceId:registered.deviceId,privateKey:pair.privateKey};
  await saveStation(saved);
  state.station=saved;
  setStatus('station-state','Registered device '+registered.deviceId+
    ' (private signing key stays non-exportable in this browser).');
  setResult('Independent test operator registration succeeded. Click Verify workstation.');
}));
node('prove').addEventListener('click',()=>withButton('prove',async()=>{
  if(!bearer)throw Error('Sign in first.');
  if(!state.station)throw Error('No registered test station in this browser.');
  const challenge=await api('/staff-station/challenge',{
    method:'POST',body:{deviceId:state.station.deviceId}
  });
  const bytes=encoder.encode('hc:staff:station:v1:'+challenge.challengeId+':'+challenge.challenge);
  const signature=toB64(await crypto.subtle.sign('Ed25519',state.station.privateKey,bytes));
  const response=await api('/staff-station/verify',{
    method:'POST',body:{challengeId:challenge.challengeId,signature}
  });
  stationProof=response.token;
  setStatus('proof-state','Cryptographically verified. Proof valid for '+
    Math.round(response.expiresIn/60)+' minutes.');
  setResult('Valid device proof issued for current synthetic employee session.');
}));
async function read(path){
  if(!bearer||!stationProof)throw Error('Sign in and verify the workstation first.');
  const result=await api(path,{headers:{'x-hc-station-proof':stationProof}});
  setResult(result);
}
node('orders').addEventListener('click',()=>withButton('orders',()=>read('/api/special-orders/orders')));
node('stats').addEventListener('click',()=>withButton('stats',()=>read('/api/special-orders/stats')));
node('logout').addEventListener('click',()=>{
  bearer=null;stationProof=null;node('pin').value='';node('operator-key').value='';
  setStatus('login-state','Signed out. No session token retained.');
  setStatus('proof-state','No active proof');
  setResult('Signed out. Registered workstation key remains in this browser for the next signed test session.');
});
loadStation().then(station=>{
  if(station?.deviceId&&station.privateKey){
    state.station=station;
    setStatus('station-state','Registered test station ready: '+station.deviceId);
  }else setStatus('station-state','No registered test station. Independent operator setup required.');
}).catch(()=>{
  setStatus('station-state','Browser device storage unavailable. Use supported Chromium on HTTPS.');
});
