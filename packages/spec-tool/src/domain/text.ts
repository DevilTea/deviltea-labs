const encoder = new TextEncoder()

export function compareBytewise(a: string, b: string): number {
	const left = encoder.encode(a)
	const right = encoder.encode(b)
	const length = Math.min(left.length, right.length)
	for (let index = 0; index < length; index++) {
		const difference = left[index]! - right[index]!
		if (difference !== 0)
			return difference
	}
	return left.length - right.length
}
