import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchAllowedGwFormHtml,parseAllowedGwFormUrl}
  from '../services/gwFormFetchPolicy.js';

test('GW form URL policy accepts only exact HTTPS approved hosts on the default port',()=>{
  assert.equal(parseAllowedGwFormUrl('https://info.games-workshop.com/a').hostname,'info.games-workshop.com');
  assert.equal(parseAllowedGwFormUrl('https://docs.google.com/forms/d/e/x/viewform').hostname,'docs.google.com');
  assert.equal(parseAllowedGwFormUrl('https://docs.google.com:443/forms/x').port,'');
  for(const url of [
    'http://docs.google.com/forms/x',
    'https://docs.google.com.evil.example/forms/x',
    'https://evil.example/',
    'https://user@docs.google.com/forms/x',
    'https://docs.google.com:8443/forms/x'
  ]) assert.throws(()=>parseAllowedGwFormUrl(url),error=>error?.status===400,url);
});

test('allowed Games Workshop redirect to Google Forms is followed manually and returned canonically',async()=>{
  const calls=[];
  const result=await fetchAllowedGwFormHtml('https://info.games-workshop.com/track/123',{
    fetchImpl:async (url,options)=>{
      calls.push({url,redirect:options.redirect});
      if(calls.length===1)return new Response(null,{status:302,headers:{location:'https://docs.google.com/forms/d/e/abc/viewform'}});
      return new Response('<html>GW form</html>',{status:200});
    }
  });
  assert.deepEqual(calls.map(x=>x.redirect),['manual','manual']);
  assert.equal(result.sourceUrl,'https://info.games-workshop.com/track/123');
  assert.equal(result.finalUrl,'https://docs.google.com/forms/d/e/abc/viewform');
  assert.equal(result.httpStatus,200);
  assert.equal(result.html,'<html>GW form</html>');
  assert.equal(result.htmlBytes,20);
});

test('every redirect target is revalidated before another network request',async()=>{
  const calls=[];
  await assert.rejects(fetchAllowedGwFormHtml('https://info.games-workshop.com/track/123',{
    fetchImpl:async url=>{
      calls.push(url);
      return new Response(null,{status:302,headers:{location:'http://127.0.0.1:8080/private'}});
    }
  }),error=>error?.status===502&&/allowlist/.test(error.message));
  assert.equal(calls.length,1);
});

test('relative redirects stay on an approved host and excessive redirect chains fail closed',async()=>{
  const calls=[];
  const ok=await fetchAllowedGwFormHtml('https://docs.google.com/forms/start',{
    fetchImpl:async url=>{
      calls.push(url);
      if(calls.length===1)return new Response(null,{status:302,headers:{location:'/forms/final'}});
      return new Response('ok',{status:200});
    }
  });
  assert.equal(ok.finalUrl,'https://docs.google.com/forms/final');

  await assert.rejects(fetchAllowedGwFormHtml('https://docs.google.com/forms/start',{
    maxRedirects:0,
    fetchImpl:async()=>new Response(null,{status:302,headers:{location:'/forms/again'}})
  }),error=>error?.status===502&&/redirect count/.test(error.message));
});

test('GW form body is rejected as soon as the configured byte limit is exceeded',async()=>{
  await assert.rejects(fetchAllowedGwFormHtml('https://docs.google.com/forms/x',{
    maxBytes:3,
    fetchImpl:async()=>new Response('abcd',{status:200})
  }),error=>error?.status===502&&/unexpectedly large/.test(error.message));
});
