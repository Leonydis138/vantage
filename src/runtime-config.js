let runtimeBindings = null;

export function setRuntimeBindings(bindings = null) {
  runtimeBindings = bindings;
}

export function setting(name) {
  const value = runtimeBindings?.[name];
  return value === undefined ? process.env[name] : value;
}
