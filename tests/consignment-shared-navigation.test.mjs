import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const staff=fs.readFileSync('consignment-beta.html','utf8');
const customer=fs.readFileSync('consignment-customer.html','utf8');
const css=fs.readFileSync('shared-ui/consignment-adapter.css','utf8');
const destinations=[
 'https://special-orders-test-production.up.railway.app/special-orders',
 'https://special-orders-test-production.up.railway.app/ordering',
 'https://special-orders-test-production.up.railway.app/preorders',
 'https://special-orders-test-production.up.railway.app/gw-preorders',
 '/consignment',
 'https://lightspeed-api-production-c087.up.railway.app/extension'
];
test('coordinated navigation destinations match on both consignment screens',()=>{
 for(const html of [staff,customer]){
  for(const url of destinations)assert.ok(html.includes('href="'+url+'"'),url);
  assert.match(html,/aria-label="Hobby Corner tools"/);
  assert.match(html,/href="\/consignment\/submit"/);
  assert.match(html,/Consignment Manager <span class="hc-beta-text">\(Beta\)<\/span>/);
  assert.ok(!html.includes('href="/timeclock"'));
 }
});
test('active page and mobile More disclosure retain native keyboard behavior',()=>{
 assert.match(staff,/data-consignment-link aria-current="page"/);
 assert.match(customer,/data-submission-link aria-current="page"/);
 assert.match(staff,/<details class="hc-consignment-more"><summary>More<\/summary>/);
 assert.match(css,/\.hc-consignment-more-content/);
 assert.match(css,/@media\(max-width:550px\)/);
});
test('existing action hooks and secure API remain untouched',()=>{
 assert.match(staff,/id="approve-selected"/);
 assert.match(staff,/id="submission-form"/);
 assert.match(customer,/id="customer-form"/);
 assert.match(staff,/consignment-beta\.js/);
 assert.match(customer,/consignment-customer\.js/);
});
