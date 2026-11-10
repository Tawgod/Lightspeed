import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('existing employee security page offers passkey-backed Owner setup without duplicating TOTP factors',async()=>{
 const html=await readFile(new URL('../staff-security.html',import.meta.url),'utf8');
 const client=await readFile(new URL('../staff-security-client.js',import.meta.url),'utf8');
 assert.match(html,/id="approveSelfPasskey"/);
 assert.match(client,/approveOwnEnrollmentWithPasskey/);
 assert.match(client,/navigator\.credentials\.get/);
 assert.match(client,/staff-passkey/);
 assert.match(client,/authentication\/options/);
 assert.match(client,/enrollment-approve/);
 assert.match(client,/X-HC-Passkey-Proof/);
 assert.match(client,/approvalState !== 'requested'/);
 assert.match(client,/\.readSession\?\.\(\)/);
 assert.doesNotMatch(client,/localStorage\.setItem|sessionStorage\.setItem/);
 assert.doesNotMatch(client,/role\s*:\s*['"]owner['"]/);
});
