// Pure, read-only completeness flags for scanner matches.
// Unknown upstream fields are not asserted missing.
export function productCompleteness(match={}){
  const missing=[],unknown=[];
  const hasValue=x=>String(x??'').trim().length>0;
  if(!hasValue(match.upc))missing.push('UPC');
  if(match.weightKnown===true){
    const value=String(match.weight??'').trim();
    // A numeric zero with units (0 lb, 0.0 oz, etc.) is still missing.
    const numeric=value.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*(?:lb|lbs|oz|g|kg|grams?|ounces?)?$/i);
    if(!value||(numeric&&Number(numeric[1])<=0))missing.push('Weight');
  }else unknown.push('Weight');
  if(match.pictureKnown===true){
    if(!hasValue(match.imageUrl))missing.push('Picture');
  }else unknown.push('Picture');
  return {missing,unknown};
}
