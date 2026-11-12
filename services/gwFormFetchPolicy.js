const ALLOWED_GW_FORM_HOSTS = new Set([
  'info.games-workshop.com',
  'docs.google.com'
]);
const REDIRECT_STATUSES = new Set([301,302,303,307,308]);
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

function gwFetchError(message,status=502){
  return Object.assign(new Error(message),{status});
}

export function parseAllowedGwFormUrl(value,{baseUrl=null}={}){
  let url;
  try{
    const raw=String(value??'').trim();
    if(!raw)throw new Error('empty');
    url=baseUrl?new URL(raw,baseUrl):new URL(raw);
  }catch{
    throw gwFetchError('Enter a valid GW Want Number Form URL.',400);
  }
  const defaultPort=url.port===''||url.port==='443';
  if(url.protocol!=='https:'||
      !ALLOWED_GW_FORM_HOSTS.has(url.hostname.toLowerCase())||
      !defaultPort||url.username||url.password){
    throw gwFetchError(
      'GW scrape accepts only HTTPS Games Workshop tracking links or Google Forms URLs.',
      400
    );
  }
  return url;
}

async function readLimitedText(response,maxBytes){
  const declared=Number(response.headers?.get?.('content-length')||0);
  if(Number.isFinite(declared)&&declared>maxBytes){
    throw gwFetchError('GW form response was unexpectedly large.',502);
  }
  if(!response.body?.getReader){
    const text=await response.text();
    const bytes=Buffer.byteLength(text);
    if(bytes>maxBytes)throw gwFetchError('GW form response was unexpectedly large.',502);
    return {text,bytes};
  }
  const reader=response.body.getReader();
  const decoder=new TextDecoder();
  let bytes=0;
  let text='';
  try{
    while(true){
      const {done,value}=await reader.read();
      if(done)break;
      bytes+=value.byteLength;
      if(bytes>maxBytes){
        try{await reader.cancel()}catch{}
        throw gwFetchError('GW form response was unexpectedly large.',502);
      }
      text+=decoder.decode(value,{stream:true});
    }
    text+=decoder.decode();
    return {text,bytes};
  }finally{
    try{reader.releaseLock()}catch{}
  }
}

export async function fetchAllowedGwFormHtml(sourceUrl,{
  fetchImpl=globalThis.fetch,
  maxRedirects=DEFAULT_MAX_REDIRECTS,
  maxBytes=DEFAULT_MAX_BYTES
}={}){
  if(typeof fetchImpl!=='function')throw new TypeError('fetchImpl must be a function.');
  if(!Number.isInteger(maxRedirects)||maxRedirects<0||maxRedirects>10){
    throw new TypeError('maxRedirects must be an integer from 0 to 10.');
  }
  if(!Number.isSafeInteger(maxBytes)||maxBytes<1){
    throw new TypeError('maxBytes must be a positive safe integer.');
  }

  const initial=parseAllowedGwFormUrl(sourceUrl);
  let current=initial;
  for(let hop=0;;hop++){
    const response=await fetchImpl(current.toString(),{
      redirect:'manual',
      headers:{
        'User-Agent':'Mozilla/5.0 HobbyCorner-GW-Preorder-Scraper/1.0',
        'Accept':'text/html,application/xhtml+xml'
      }
    });

    if(REDIRECT_STATUSES.has(response.status)){
      if(hop>=maxRedirects){
        throw gwFetchError('GW form fetch exceeded the permitted redirect count.',502);
      }
      const location=response.headers?.get?.('location');
      if(!location)throw gwFetchError('GW form redirect did not include a destination.',502);
      try{
        current=parseAllowedGwFormUrl(location,{baseUrl:current});
      }catch(error){
        if(error?.status===400){
          throw gwFetchError('GW form redirect left the approved Games Workshop/Google host allowlist.',502);
        }
        throw error;
      }
      continue;
    }

    if(!response.ok){
      throw gwFetchError('GW form fetch failed: '+response.status+' '+(response.statusText||''),502);
    }
    const body=await readLimitedText(response,maxBytes);
    return Object.freeze({
      sourceUrl:initial.toString(),
      finalUrl:current.toString(),
      httpStatus:response.status,
      html:body.text,
      htmlBytes:body.bytes
    });
  }
}
