// Test-only extension: exact source and disclosure are distinct stages.
// Reuses existing M9 search contract; no production adapter or policy evaluator.
import {createScopedCustomerFixture} from './customerSalesM9.js';
export function createCustomerSourceM10({environment,authorizeSource,authorizeDisclosure,readProjected}={}){
 if(environment!=='test'||[authorizeSource,authorizeDisclosure,readProjected].some(f=>typeof f!=='function'))throw new TypeError('Explicit isolated adapters required');
 return createScopedCustomerFixture({environment,readProjected,authorize:async request=>{
  if(request.phase==='io')return (await authorizeSource(request))===true;
  if(request.phase==='projection')return (await authorizeDisclosure(request))===true;
  return false;
 }});
}
