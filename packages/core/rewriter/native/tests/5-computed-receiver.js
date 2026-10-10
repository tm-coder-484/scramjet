// null-prototype dictionaries keep their own keys, the wrapper must not turn them into aliases
{
  const key = "eval";
  const dict = Object.assign(Object.create(null), { eval: () => 1, top: 2, location: 3, parent: 4 });
  assert(dict[key]() === 1);
  assert(dict["top"] === 2);
  assert(dict["location"] === 3);
  assert(dict["parent"] === 4);
  dict["top"] = 5;
  assert(dict["top"] === 5);
  dict[key] = 2;
  dict[key] += 1;
  assert(dict["eval"] === 3);
  delete dict["parent"];
  assert(dict["parent"] === undefined);
}
// `this` receiver
{
  function f(k) { return this[k]; }
  const d = Object.create(null);
  d["top"] = 7;
  assert(f.call(d, "top") === 7);
}
