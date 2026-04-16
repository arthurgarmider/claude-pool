export function trace<T extends (...args: any[]) => any>(name: string, fn: T): T {
  return ((...args: any[]) => {
    const start = performance.now()
    const preview = args.length ? JSON.stringify(args[0]).slice(0, 120) : ""
    console.log(`→ ${name}`, preview)
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
