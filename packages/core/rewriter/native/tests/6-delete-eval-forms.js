// the eval argument rewrite is an identity here, so the eval body runs unchanged
const $rewrite = (x) => x;
// delete on an unsafe global name must remove the real key, not the $scramjet__ alias
{
  const o = { parent: 1, top: 2, location: 3, eval: 4, keep: 5 };
  assert(delete o.parent === true);
  assert(!("parent" in o));
  assert(delete o.top);
  assert(!("top" in o));
  assert(delete o["location"]);
  assert(!("location" in o));
  assert(delete o.eval);
  assert(!("eval" in o));
  assert(o.keep === 5);
}
// delete through a computed key
{
  const o = { parent: 1, top: 2 };
  const k = "parent";
  assert(delete o[k]);
  assert(!("parent" in o));
  const k2 = "top";
  assert(delete o[k2]);
  assert(!("top" in o));
}
// direct eval keeps the local scope whatever sits between the callee and the arguments
{
  const local = 5;
  assert(eval("local") === 5);
  assert(eval ("local") === 5);
  assert(eval/*c*/("local") === 5);
  assert(eval /* c */ ( "local" ) === 5);
  assert((eval)("local") === 5);
  assert(((eval))("local") === 5);
}
