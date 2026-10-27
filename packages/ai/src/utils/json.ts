import { Schema } from "effect"

export const Json = Schema.fromJsonString(Schema.Unknown)
export const decodeJson = Schema.decodeUnknownSync(Json)
export const encodeJson = Schema.encodeSync(Json)

/**
 * The first path whose member JSON cannot represent at all: a cycle, a `bigint`, a function or a symbol, reported as
 * `messages[3].content[1].result.value.self (circular)`.
 *
 * `undefined` is deliberately not reported. `JSON.stringify` drops an undefined object member, so it only breaks a
 * request when it is the value being encoded, which the total encoders already handle; flagging it here would reject
 * ordinary requests that omit optional fields. Deep structures stop at `limit` levels without reporting: a missing
 * report is a lost diagnostic, while a false one would reject a valid request.
 */
export const findUnencodable = (value: unknown, limit = 32): string | undefined => {
  const seen = new WeakSet<object>()
  const join = (path: string, key: string) => (path === "" ? key : `${path}.${key}`)
  const walk = (current: unknown, path: string, depth: number): string | undefined => {
    if (typeof current === "bigint" || typeof current === "function" || typeof current === "symbol")
      return `${path || "request"} (${typeof current})`
    if (current === null || typeof current !== "object") return undefined
    // Only an ancestor repeating is a cycle. A shape shared by two siblings (a reused `cache`, say) is a DAG that
    // `JSON.stringify` encodes fine, so the node is removed again once its subtree is walked.
    if (seen.has(current)) return `${path || "request"} (circular)`
    if (depth >= limit) return undefined
    seen.add(current)
    if (Array.isArray(current)) {
      for (let index = 0; index < current.length; index++) {
        const found = walk(current[index], `${path}[${index}]`, depth + 1)
        if (found !== undefined) return found
      }
      seen.delete(current)
      return undefined
    }
    for (const key of Object.keys(current as object)) {
      const found = walk((current as Record<string, unknown>)[key], join(path, key), depth + 1)
      if (found !== undefined) return found
    }
    seen.delete(current)
    return undefined
  }
  return walk(value, "", 0)
}
