/**
 * The authored value domain.  Runtime/config-resolved values intentionally use `unknown` instead;
 * this type is only for values that can occur in persisted Widget source and SourcePatch operands.
 */
export type JsonPrimitive = string | number | boolean | null

export type JsonArray = readonly JsonValue[]

export interface JsonObject {
	readonly [key: string]: JsonValue
}

export type JsonValue = JsonPrimitive | JsonArray | JsonObject

export function isJsonValue(value: unknown, seen = new Set<object>()): value is JsonValue {
	if (value === null)
		return true

	if (typeof value === 'string' || typeof value === 'boolean')
		return true

	if (typeof value === 'number')
		return Number.isFinite(value)

	if (typeof value !== 'object')
		return false

	if (seen.has(value))
		return false

	seen.add(value)
	try {
		if (Array.isArray(value)) {
			if (Object.getPrototypeOf(value) !== Array.prototype)
				return false

			for (let index = 0; index < value.length; index++) {
				const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
				if (descriptor === undefined || !('value' in descriptor) || !isJsonValue(descriptor.value, seen))
					return false
			}

			for (const key of Reflect.ownKeys(value)) {
				if (typeof key === 'symbol')
					return false
				if (key === 'length')
					continue
				if (/^(?:0|[1-9]\d*)$/.test(key) && Number(key) < value.length)
					continue
				// JSON arrays contain only indexed elements and their intrinsic length. Named
				// properties are authored material outside the JSON domain.
				return false
			}
			return true
		}

		if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
			return false

		for (const key of Reflect.ownKeys(value)) {
			if (typeof key !== 'string')
				return false
			const descriptor = Object.getOwnPropertyDescriptor(value, key)
			if (descriptor === undefined || !('value' in descriptor) || !isJsonValue(descriptor.value, seen))
				return false
		}
		return true
	}
	catch {
		return false
	}
	finally {
		seen.delete(value)
	}
}

/** JSON-domain equality used by RFC6902 `test` and by SourcePatch no-op detection. */
export function jsonEqual(left: unknown, right: unknown, seen = new Set<unknown>()): boolean {
	if (Object.is(left, right))
		return true
	if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null)
		return false
	if (!isJsonValue(left) || !isJsonValue(right))
		return false
	if (seen.has(left) || seen.has(right))
		return false

	seen.add(left)
	seen.add(right)
	try {
		if (Array.isArray(left) !== Array.isArray(right))
			return false
		if (Array.isArray(left) && Array.isArray(right)) {
			if (left.length !== right.length)
				return false
			for (let index = 0; index < left.length; index++) {
				if (!jsonEqual(left[index], right[index], seen))
					return false
			}
			return true
		}

		const leftObject = left as JsonObject
		const rightObject = right as JsonObject
		const leftKeys = Object.keys(leftObject)
		const rightKeys = Object.keys(rightObject)
		if (leftKeys.length !== rightKeys.length)
			return false
		for (const key of leftKeys) {
			if (!Object.hasOwn(rightObject, key) || !jsonEqual(leftObject[key], rightObject[key], seen))
				return false
		}
		return true
	}
	finally {
		seen.delete(left)
		seen.delete(right)
	}
}

/**
 * Type-level diagnostic for a RawConfig that is not statically within JsonValue. Optional properties
 * are allowed to be omitted, but an explicitly required `undefined` remains outside the domain.
 */
type IsAny<T> = 0 extends 1 & T ? true : false
type OptionalKeys<T extends object> = {
	[Key in keyof T]-?: Record<never, never> extends Pick<T, Key> ? Key : never
}[keyof T]

export type JsonDomainViolation<Value> = IsAny<Value> extends true
	? 'authored JSON values cannot contain any'
	: [Value] extends [never]
			? never
			: [Value] extends [JsonValue]
					? never
					: Value extends string | number | boolean | null
						? never
						: Value extends (...args: any[]) => any
							? 'authored values must be JSON-compatible'
							: Value extends readonly (infer Element)[]
								? JsonDomainViolation<Element>
								: Value extends object
									? Exclude<keyof Value, string> extends never
										? {
												[Key in keyof Value]-?: Key extends OptionalKeys<Value>
													? JsonDomainViolation<Exclude<Value[Key], undefined>>
													: JsonDomainViolation<Value[Key]>
											}[keyof Value]
										: 'authored JSON objects may only have string keys'
									: 'authored values must be JSON-compatible'
