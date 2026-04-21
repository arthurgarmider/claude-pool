export function trace<T extends (...args: any[]) => any>(name: string, fn: T): T {
  return wrap(name, fn, true)
}

// Same as `trace` but never logs arguments. Use for functions whose inputs
// are sensitive (encryption keys, plaintext tokens, raw ciphertext, etc.).
export function traceQuiet<T extends (...args: any[]) => any>(name: string, fn: T): T {
  return wrap(name, fn, false)
}

function wrap<T extends (...args: any[]) => any>(name: string, fn: T, logArgs: boolean): T {
  return ((...args: any[]) => {
    const start = performance.now()
    if (logArgs) {
      const preview = args.length ? JSON.stringify(args[0]).slice(0, 120) : ""
      console.log(`→ ${name}`, preview)
    } else {
      console.log(`→ ${name}`)
    }
    try {
      const result = fn(...args)
      if (result instanceof Promise) {
        return result
          .then((r: any) => {
            console.log(`← ${name} ${(performance.now() - start).toFixed(0)}ms`)
            return r
          })
          .catch((e: any) => {
            console.log(`✗ ${name} ${e.message} ${(performance.now() - start).toFixed(0)}ms`)
            throw e
          })
      }
      console.log(`← ${name} ${(performance.now() - start).toFixed(0)}ms`)
      return result
    } catch (e: any) {
      console.log(`✗ ${name} ${e.message} ${(performance.now() - start).toFixed(0)}ms`)
      throw e
    }
  }) as T
}
