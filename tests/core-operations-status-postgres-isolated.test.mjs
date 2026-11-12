import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import pg from 'pg';
import {createStaffAccessBaseline} from '../services/security/staffAccessBaseline.js';
import {createCoreOperationsRouteAdmission} from '../services/security/coreOperationsRouteAdmission.js';
import {STATUS_SENSITIVE_OPERATION,STATUS_PROGRESS_OPERATION,STATUS_POLICY_VERSION}
  from '../services/security/coreOperationsStatusTransitions.js';

// This manual integration test is intentionally NOT part of regular CI.
// It only runs after the launcher provisions a brand-new localhost-only
// disposable PostgreSQL container; no Railway, Lightspeed or customer data.
function verifiedDisposableUrl() {
  const supplied=process.env.HC_SECURITY_DISPOSABLE_DB_URL;
  let uri;
  try {uri=new URL(supplied);} catch {throw Error('Disposable localhost database URL missing. Use the supplied Codespaces launcher.');}
  if (uri.protocol!=='postgresql:' || uri.hostname!=='127.0.0.1' ||
      uri.username!=='hc_security_test' || uri.password!=='fixture-only-local-test' ||
      uri.pathname!=='/hc_security_test' || uri.search || uri.hash ||
      !Number.isSafeInteger(Number(uri.port)) || Number(uri.port)<1024 || Number(uri.port)>65535) {
    throw Error('Refusing a database URL other than the disposable Codespaces loopback fixture.');
  }
  return supplied;
}

const CURRENT_TIME=Date.parse('2026-11-12T15:00:00Z');

test('disposable PostgreSQL 18: guarded status change, locked state, audit and notifications', {timeout:90_000}, async t=>{
  // Verify URL BEFORE importing any module that can initialize shared DB.
  const dbUrl=verifiedDisposableUrl();
  process.env.DATABASE_URL=dbUrl;
  process.env.PGSSL='false';
  // Ensure scheduled GW bot workers do not start in this disposable test.
  globalThis.__hcGwNotificationWorker=true;
  const {initializeSpecialOrdersDb,createSpecialOrdersRouter}
    =await import('../special-orders.js');
  const db=new pg.Client({connectionString:dbUrl,connectionTimeoutMillis:5000});
  let server;
  try{
    assert.equal(await initializeSpecialOrdersDb(),true);
    await db.connect();

    const {rows:customerRows}=await db.query(
      "INSERT INTO customers (name) VALUES ('DISPOSABLE SECURITY TEST ONLY') RETURNING id"
    );
    const customerId=customerRows[0].id;
    const {rows:orderRows}=await db.query(
      "INSERT INTO special_orders (customer_id) VALUES ($1) RETURNING id",[customerId]
    );
    const orderId=orderRows[0].id;

    async function newItem(status='OOS'){
      const {rows}=await db.query(
        'INSERT INTO special_order_items (special_order_id,requested_name,quantity,status) '+
        'VALUES ($1,$2,1,$3) RETURNING id',
        [orderId,'DISPOSABLE TEST ITEM',status]
      );
      return rows[0].id;
    }
    async function addNotification(id,status='PENDING'){
      await db.query(
        'INSERT INTO notifications (special_order_item_id,customer_id,channel,recipient,status,message) '+
        'VALUES ($1,$2,$3,$4,$5,$6)',
        [id,customerId,'DISPOSABLE_TEST','local-only@example.invalid',status,'Fixture only']
      );
    }
    async function addDiscordNotification(id,status='SENDING'){
      const {rows}=await db.query(
        'INSERT INTO notifications (special_order_item_id,customer_id,channel,recipient,status,message) '+
        'VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
        [id,customerId,'DISCORD_READY','fixture-discord-user',status,'Fixture Discord ready message']
      );
      return rows[0].id;
    }
    async function notificationById(id){
      const {rows}=await db.query(
        'SELECT status,external_message_id,sent_at,error FROM notifications WHERE id=$1',[id]
      );
      assert.equal(rows.length,1);
      return rows[0];
    }
    async function state(id){
      const {rows}=await db.query(
        'SELECT status,ordered_at,received_at,completed_at,cancelled_at FROM special_order_items WHERE id=$1',
        [id]
      );
      assert.equal(rows.length,1);
      return rows[0];
    }
    async function history(id){
      const {rows}=await db.query(
        'SELECT old_status,new_status,changed_by FROM order_status_history WHERE special_order_item_id=$1 ORDER BY id',
        [id]
      );
      return rows;
    }
    async function notificationState(id){
      const {rows}=await db.query(
        'SELECT status FROM notifications WHERE special_order_item_id=$1',
        [id]
      );
      return rows.map(r=>r.status);
    }

    const staff=createStaffAccessBaseline({
      now:()=>CURRENT_TIME,
      verifyEmployeeSession:async req=>
        req.get('authorization')==='Bearer fixture-signed-staff'
          ? {id:'42',active:true,clockedIn:false}:null,
      verifyWorkstation:async req=>req.get('x-fixture-proof')==='station'
        ? {verified:true,deviceId:'disposable-kiosk',expiresAtMs:CURRENT_TIME+30_000}:null,
      verifyStepUp:async req=>req.get('x-fixture-proof')==='passkey'
        ? {verified:true,employeeId:'42',method:'passkey',
          authenticatedAtMs:CURRENT_TIME-500}:null,
      checkPermission:async ({operation})=>
        [STATUS_PROGRESS_OPERATION,STATUS_SENSITIVE_OPERATION].includes(operation)
    });
    const admission=createCoreOperationsRouteAdmission({
      approvedRoutes:[{
        source:'special-orders.js',method:'PATCH',path:'/items/:id/status',
        audience:'employee',operation:STATUS_SENSITIVE_OPERATION,
        statusPolicy:STATUS_POLICY_VERSION
      },{
        source:'special-orders.js',method:'POST',path:'/notifications/:id/complete-discord',
        audience:'service',operation:'service.notifications.complete-discord'
      }],
      staffAccess:staff,
      verifyServiceRequest:async request=>request.get('x-fixture-service')==='discord-delivery'
        ? {type:'service',id:'discord-delivery',active:true}:null,
      checkServiceGrant:async ({identity,operation})=>
        identity.id==='discord-delivery' &&
        operation==='service.notifications.complete-discord'
    });
    const app=express();
    app.use(express.json({limit:'32kb'}));
    app.use('/api/special-orders',createSpecialOrdersRouter({
      adminKey:'fixture-legacy-key-not-auth',
      coreOperationsAdmission:admission,
      liveMode:false,
      allowMigration:false,
      allowProductWrites:false
    }));
    server=await new Promise(resolve=>{
      const running=app.listen(0,'127.0.0.1',()=>resolve(running));
    });
    async function change(id,status,proof='station',extra={}){
      const response=await fetch(
        'http://127.0.0.1:'+server.address().port+'/api/special-orders/items/'+id+'/status',
        {
          method:'PATCH',
          headers:{
            'content-type':'application/json',
            authorization:'Bearer fixture-signed-staff',
            'x-fixture-proof':proof,
            'x-hc-role':'Owner',
            'x-hobby-corner-key':'fixture-legacy-key-not-auth'
          },
          body:JSON.stringify({status,changed_by:'FORGED_OWNER',...extra})
        }
      );
      const data=await response.json();
      return {status:response.status,body:data};
    }
    async function completeDiscord(notificationId,{success=true,externalId='fixture-message-1'}={}){
      const response=await fetch(
        'http://127.0.0.1:'+server.address().port+
          '/api/special-orders/notifications/'+notificationId+'/complete-discord',
        {
          method:'POST',
          headers:{
            'content-type':'application/json',
            'x-fixture-service':'discord-delivery',
            'x-hobby-corner-key':'fixture-legacy-key-not-auth'
          },
          body:JSON.stringify(success
            ? {success:true,external_message_id:externalId}
            : {success:false,error:'fixture send failure'})
        }
      );
      const body=await response.json();
      return {status:response.status,body};
    }

    await t.test('routine progress writes one DB history row with verified employee, no notification side effect',async()=>{
      const id=await newItem('OOS');
      await addNotification(id);
      const outcome=await change(id,'READY_TO_ORDER','station');
      assert.equal(outcome.status,200,JSON.stringify(outcome.body));
      assert.equal((await state(id)).status,'READY_TO_ORDER');
      assert.deepEqual(await history(id),[{
        old_status:'OOS',new_status:'READY_TO_ORDER',changed_by:'employee:42'
      }]);
      assert.deepEqual(await notificationState(id),['PENDING']);
    });

    await t.test('routine request cannot downgrade a received item or alter notifications',async()=>{
      const id=await newItem('RECEIVED');
      await addNotification(id);
      const outcome=await change(id,'OOS','station');
      assert.equal(outcome.status,403,JSON.stringify(outcome.body));
      assert.equal((await state(id)).status,'RECEIVED');
      assert.deepEqual(await history(id),[]);
      assert.deepEqual(await notificationState(id),['PENDING']);
    });

    await t.test('completion and cancellation require strong verified proof, suppress pending notice once',async()=>{
      const id=await newItem('ORDERED');
      await addNotification(id);
      for (const proof of ['station','none']){
        const outcome=await change(id,'CANCELLED',proof);
        assert.equal(outcome.status,403,proof);
        assert.equal((await state(id)).status,'ORDERED');
        assert.deepEqual(await notificationState(id),['PENDING']);
      }
      const approved=await change(id,'CANCELLED','passkey');
      assert.equal(approved.status,200,JSON.stringify(approved.body));
      const stateAfter=await state(id);
      assert.equal(stateAfter.status,'CANCELLED');
      assert.ok(stateAfter.cancelled_at);
      assert.deepEqual(await notificationState(id),['SUPPRESSED']);
      assert.deepEqual(await history(id),[{
        old_status:'ORDERED',new_status:'CANCELLED',changed_by:'employee:42'
      }]);
      const downgrade=await change(id,'BACKORDERED','station');
      assert.equal(downgrade.status,403);
      assert.equal((await state(id)).status,'CANCELLED');
    });

    await t.test('completion suppresses pending and queued notifications but preserves already sent notices',async()=>{
      const id=await newItem('ORDERED');
      await addNotification(id,'PENDING');
      await addNotification(id,'QUEUED');
      await addNotification(id,'SENT');
      const unauthorized=await change(id,'COMPLETED','station');
      assert.equal(unauthorized.status,403);
      assert.deepEqual((await notificationState(id)).sort(),['PENDING','QUEUED','SENT'].sort());
      const approved=await change(id,'COMPLETED','passkey');
      assert.equal(approved.status,200,JSON.stringify(approved.body));
      const final=await state(id);
      assert.equal(final.status,'COMPLETED');
      assert.ok(final.completed_at);
      assert.deepEqual((await notificationState(id)).sort(),['SENT','SUPPRESSED','SUPPRESSED'].sort());
      assert.deepEqual(await history(id),[{
        old_status:'ORDERED',new_status:'COMPLETED',changed_by:'employee:42'
      }]);
      const denied=await change(id,'READY_TO_ORDER','station');
      assert.equal(denied.status,403);
      assert.equal((await state(id)).status,'COMPLETED');
    });

    await t.test('forced notification failure rolls back status, history and timestamps atomically',async()=>{
      const id=await newItem('ORDERED');
      await addNotification(id,'PENDING');
      const functionName='hc_fixture_reject_suppression';
      await db.query(
        "CREATE FUNCTION "+functionName+"() RETURNS trigger LANGUAGE plpgsql "+
        "AS 'BEGIN RAISE EXCEPTION ''fixture induced notification failure''; END;'"
      );
      await db.query(
        "CREATE TRIGGER hc_fixture_block_suppression BEFORE UPDATE OF status ON notifications "+
        "FOR EACH ROW WHEN (NEW.status='SUPPRESSED') EXECUTE FUNCTION "+
        functionName+"()"
      );
      try{
        const failed=await change(id,'CANCELLED','passkey');
        assert.equal(failed.status,400,JSON.stringify(failed.body));
        assert.match(String(failed.body?.error||''),/fixture induced notification failure/,
          'The rollback must be caused by the deliberately injected DB trigger');
        const final=await state(id);
        assert.equal(final.status,'ORDERED');
        assert.equal(final.cancelled_at,null);
        assert.deepEqual(await history(id),[]);
        assert.deepEqual(await notificationState(id),['PENDING']);
      }finally{
        await db.query('DROP TRIGGER IF EXISTS hc_fixture_block_suppression ON notifications');
        await db.query('DROP FUNCTION IF EXISTS '+functionName+'()');
      }
      // Verify a failed transaction does not poison later updates.
      const retried=await change(id,'CANCELLED','passkey');
      assert.equal(retried.status,200,JSON.stringify(retried.body));
      assert.equal((await state(id)).status,'CANCELLED');
      assert.deepEqual(await notificationState(id),['SUPPRESSED']);
      assert.equal((await history(id)).length,1);
    });

    await t.test('row lock prevents stale routine privilege from reopening an item concurrently',async()=>{
      const id=await newItem('OOS');
      const locker=new pg.Client({connectionString:dbUrl,connectionTimeoutMillis:5000});
      await locker.connect();
      try{
        await locker.query('BEGIN');
        await locker.query('SELECT id FROM special_order_items WHERE id=$1 FOR UPDATE',[id]);
        const pending=change(id,'READY_TO_ORDER','station');
        // The HTTP handler must wait for this row lock. Move it to a
        // protected status before releasing the lock.
        await new Promise(resolve=>setTimeout(resolve,80));
        await locker.query(
          "UPDATE special_order_items SET status='RECEIVED',received_at=now() WHERE id=$1",
          [id]
        );
        await locker.query('COMMIT');
        const outcome=await pending;
        assert.equal(outcome.status,403,JSON.stringify(outcome.body));
        assert.equal((await state(id)).status,'RECEIVED');
        assert.deepEqual(await history(id),[]);
      }finally{
        await locker.query('ROLLBACK').catch(()=>{});
        await locker.end();
      }
    });

    await t.test('scoped Discord service completion atomically marks notification sent and records verified service actor',async()=>{
      const id=await newItem('RECEIVED');
      const notificationId=await addDiscordNotification(id,'SENDING');
      const outcome=await completeDiscord(notificationId,{externalId:'fixture-discord-message'});
      assert.equal(outcome.status,200,JSON.stringify(outcome.body));
      const notification=await notificationById(notificationId);
      assert.equal(notification.status,'SENT');
      assert.equal(notification.external_message_id,'fixture-discord-message');
      assert.ok(notification.sent_at);
      assert.equal((await state(id)).status,'CUSTOMER_NOTIFIED');
      assert.deepEqual(await history(id),[{
        old_status:'RECEIVED',new_status:'CUSTOMER_NOTIFIED',
        changed_by:'service:discord-delivery'
      }]);
    });

    await t.test('Discord completion history failure rolls notification and item status back atomically',async()=>{
      const id=await newItem('RECEIVED');
      const notificationId=await addDiscordNotification(id,'SENDING');
      const functionName='hc_fixture_reject_discord_history';
      await db.query(
        "CREATE FUNCTION "+functionName+"() RETURNS trigger LANGUAGE plpgsql "+
        "AS 'BEGIN IF NEW.note = ''Discord ready notification sent'' THEN "+
        "RAISE EXCEPTION ''fixture induced Discord history failure''; END IF; RETURN NEW; END;'"
      );
      await db.query(
        "CREATE TRIGGER hc_fixture_block_discord_history BEFORE INSERT ON order_status_history "+
        "FOR EACH ROW EXECUTE FUNCTION "+functionName+"()"
      );
      try{
        const failed=await completeDiscord(notificationId,{externalId:'should-rollback'});
        assert.equal(failed.status,500,JSON.stringify(failed.body));
        const notification=await notificationById(notificationId);
        assert.equal(notification.status,'SENDING');
        assert.equal(notification.external_message_id,null);
        assert.equal(notification.sent_at,null);
        assert.equal((await state(id)).status,'RECEIVED');
        assert.deepEqual(await history(id),[]);
      }finally{
        await db.query('DROP TRIGGER IF EXISTS hc_fixture_block_discord_history ON order_status_history');
        await db.query('DROP FUNCTION IF EXISTS '+functionName+'()');
      }
      const retried=await completeDiscord(notificationId,{externalId:'fixture-retry-message'});
      assert.equal(retried.status,200,JSON.stringify(retried.body));
      assert.equal((await notificationById(notificationId)).status,'SENT');
      assert.equal((await state(id)).status,'CUSTOMER_NOTIFIED');
      assert.deepEqual(await history(id),[{
        old_status:'RECEIVED',new_status:'CUSTOMER_NOTIFIED',
        changed_by:'service:discord-delivery'
      }]);
    });

    await t.test('unrecognized target and static old key cannot mutate any row',async()=>{
      const id=await newItem('OOS');
      assert.equal((await change(id,'NOT_A_STATUS','passkey')).status,403);
      const response=await fetch(
        'http://127.0.0.1:'+server.address().port+'/api/special-orders/items/'+id+'/status',
        {method:'PATCH',headers:{
          'content-type':'application/json','x-hobby-corner-key':'fixture-legacy-key-not-auth'
        },body:JSON.stringify({status:'READY_TO_ORDER',changed_by:'Owner'})}
      );
      assert.equal(response.status,403);
      await response.text();
      assert.equal((await state(id)).status,'OOS');
      assert.deepEqual(await history(id),[]);
    });
  } finally {
    if(server){
      const closed=new Promise(resolve=>server.close(resolve));
      server.closeAllConnections?.();
      await closed;
    }
    await db.end().catch(()=>{});
    // The module's own pg Pool has a short idle timeout. The Codespaces
    // wrapper also removes the disposable container when this test exits.
  }
});
