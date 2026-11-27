import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../routes/orderSplit.js', import.meta.url), 'utf8');
const start = source.indexOf('let splitSubmitted = false;');
const end = source.indexOf('loadDestinations();', start);
assert.ok(start >= 0 && end > start);
const script = source.slice(start,end);
const good = { splitCompleted:true, fulfillmentIntegrity:{consistent:true}, paymentIntegrity:{consistent:true}, newSale:{id:'fixture-destination',invoiceNumber:'0020'}, originalSale:{invoiceNumber:'0012'} };

async function fixture(data, { ok = true, pickup = true, offline = false } = {}) {
  const buttons = {'pickup-selected-btn':{}, 'split-selected-btn':{}, result:{}, 'split-destination':{value:''}};
  const requests = [], messages = [];
  const ctx = {
    document: {
      querySelectorAll: () => [{dataset:{lineId:'fixture-line'}}],
      querySelector: () => ({value:'2'}),
      getElementById: id => buttons[id]
    },
    confirm: () => true,
    alert: () => assert.fail('unexpected alert'),
    fetch: async (url, opts) => {
      requests.push({url,body:JSON.parse(opts.body)});
      if (offline) throw new Error('fixture timeout');
      return {ok, json:async()=>data};
    },
    setTimeout: fn => fn(),
    window: {parent:{postMessage: (message,origin) => messages.push({message,origin})}}
  };
  await runInNewContext(script + '\nPromise.all([splitSelected(' + pickup + '),splitSelected(false)])',ctx);
  return {buttons,requests,messages};
}

test('partial pickup sends selected quantity once and returns destination',async()=>{
  const r=await fixture(good);
  assert.equal(r.requests.length,1);
  assert.deepEqual(r.requests[0].body,{items:[{lineItemId:'fixture-line',quantity:2}],destinationSaleRef:null});
  assert.equal(r.messages.length,1);
  assert.equal(r.messages[0].message.type,'HCT_PICKUP_TO_REGISTER');
  assert.equal(r.messages[0].message.saleId,'fixture-destination');
});
test('split-only preserves completion event',async()=>{
  const r=await fixture(good,{pickup:false});
  assert.equal(r.messages.length,1);
  assert.equal(r.messages[0].message.type,'HCT_SPLIT_COMPLETE');
});
for(const [name,data,opts] of [
  ['inconsistent payment',{...good,paymentIntegrity:{consistent:false}},{}],
  ['inconsistent fulfillment',{...good,fulfillmentIntegrity:{consistent:false}},{}],
  ['recovery required',{...good,recoveryRequired:true},{}],
  ['missing destination',{...good,newSale:null},{}],
  ['HTTP failure',good,{ok:false}],
  ['network timeout',good,{offline:true}]
]){
  test(name+' blocks register handoff and further overlay submission',async()=>{
    const r=await fixture(data,opts);
    assert.equal(r.requests.length,1);
    assert.equal(r.messages.length,0);
    assert.equal(r.buttons['pickup-selected-btn'].disabled,true);
    assert.equal(r.buttons['split-selected-btn'].disabled,true);
    assert.match(r.buttons.result.textContent,/Check/);
  });
}
