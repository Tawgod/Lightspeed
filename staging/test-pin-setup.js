// No secrets in localStorage/sessionStorage, URL, or console.
(() => {
  const form=document.getElementById('pin-setup');
  const status=document.getElementById('setup-status');
  const button=document.getElementById('setup-button');
  form.addEventListener('submit',async event=>{
    event.preventDefault();
    const key=document.getElementById('setup-key');
    const pin=document.getElementById('new-pin');
    const confirm=document.getElementById('confirm-pin');
    const setupKey=key.value, value=pin.value, check=confirm.value;
    key.value='';pin.value='';confirm.value='';
    if(!/^\d{4}$/.test(value)||value!==check){
      status.textContent='Enter matching four-digit test PINs.';return;
    }
    if(setupKey.length<43){
      status.textContent='Use the full one-time Railway setup key.';return;
    }
    button.disabled=true;status.textContent='Saving test PIN securely…';
    try{
      const result=await fetch('/api/test-pin-setup/set',{
        method:'POST',cache:'no-store',credentials:'omit',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({setupKey,pin:value})
      });
      if(result.status===201){
        status.textContent='Test PIN created. Now open /test-login to sign in.';
        form.hidden=true;
      }else{
        status.textContent='Setup denied or already completed. Check the Railway key and whether the setup was used.';
      }
    }catch{
      status.textContent='The staging service could not be reached.';
    }finally{button.disabled=false;}
  });
})();
