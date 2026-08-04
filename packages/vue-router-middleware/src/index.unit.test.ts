import type { RouteLocationNormalized } from 'vue-router'
import type { Middleware } from './types'
import { describe, expect, it, vi } from 'vitest'
import { defineMiddleware, handleMiddlewares } from './index'

type MatchedMiddleware = Middleware | Middleware[] | undefined

interface RouteInput {
	hash?: string
	matched?: MatchedMiddleware[]
	name?: string
	params?: Record<string, unknown>
	path?: string
	query?: Record<string, unknown>
}

function createRoute({
	hash = '',
	matched = [],
	name = 'destination',
	params = {},
	path = '/destination',
	query = {},
}: RouteInput = {}): RouteLocationNormalized {
	return {
		fullPath: `${path}${hash}`,
		hash,
		matched: matched.map(middleware => ({
			meta: middleware === undefined ? {} : { middleware },
		})) as RouteLocationNormalized['matched'],
		meta: {},
		name,
		params,
		path,
		query,
		redirectedFrom: undefined,
	} as RouteLocationNormalized
}

function continuingMiddleware(value: true | null | undefined, asynchronous: boolean): Middleware {
	return vi.fn(() => asynchronous ? Promise.resolve(value) : value) as unknown as Middleware
}

describe('defineMiddleware', () => {
	it('returns the exact middleware reference', () => {
		const middleware: Middleware = vi.fn(() => true)

		expect(defineMiddleware(middleware))
			.toBe(middleware)
	})
})

describe('handleMiddlewares', () => {
	it('skips a fully identical route without invoking its middleware', async () => {
		const middleware = vi.fn(() => true)
		const to = createRoute({ matched: [middleware] })
		const from = createRoute()

		await expect(handleMiddlewares(to, from)).resolves.toBe(true)
		expect(middleware).not.toHaveBeenCalled()
	})

	it.each([
		['path', { path: '/other' }],
		['name', { name: 'other' }],
		['query', { query: { page: '2' } }],
		['params', { params: { id: '2' } }],
		['hash', { hash: '#other' }],
	] satisfies Array<[string, RouteInput]>)('runs middleware when only %s differs', async (_field, change) => {
		const middleware = vi.fn(() => true)
		const to = createRoute({ matched: [middleware], ...change })
		const from = createRoute()

		await expect(handleMiddlewares(to, from)).resolves.toBe(true)
		expect(middleware)
			.toHaveBeenCalledOnce()
		expect(middleware)
			.toHaveBeenCalledWith(to, from)
	})

	it('treats different shallow keys as a route change even when their values match', async () => {
		const middleware = vi.fn(() => true)
		const to = createRoute({ matched: [middleware], query: { current: 'same' } })
		const from = createRoute({ query: { previous: 'same' } })

		await expect(handleMiddlewares(to, from)).resolves.toBe(true)
		expect(middleware)
			.toHaveBeenCalledWith(to, from)
	})

	it('uses strict shallow value equality instead of deep equality', async () => {
		const middleware = vi.fn(() => true)
		const to = createRoute({ matched: [middleware], params: { filter: { enabled: true } } })
		const from = createRoute({ params: { filter: { enabled: true } } })

		await expect(handleMiddlewares(to, from)).resolves.toBe(true)
		expect(middleware)
			.toHaveBeenCalledWith(to, from)
	})

	it('returns true for an unmatched destination and does not inspect middleware', async () => {
		const to = createRoute({ path: '/missing' })
		const from = createRoute({ path: '/source' })

		await expect(handleMiddlewares(to, from)).resolves.toBe(true)
	})

	it('returns true when matched records have no middleware or only empty middleware arrays', async () => {
		const to = createRoute({ path: '/empty', matched: [undefined, []] })
		const from = createRoute({ path: '/source' })

		await expect(handleMiddlewares(to, from)).resolves.toBe(true)
	})

	it('flattens matched middleware in matched-record and array order', async () => {
		const calls: string[] = []
		const first: Middleware = vi.fn(() => {
			calls.push('first')
			return true
		})
		const second: Middleware = vi.fn(async () => {
			calls.push('second')
		})
		const third = vi.fn(() => {
			calls.push('third')
			return null
		}) as unknown as Middleware
		const to = createRoute({ path: '/nested', matched: [first, [second, third]] })
		const from = createRoute({ path: '/source' })

		await expect(handleMiddlewares(to, from)).resolves.toBe(true)
		expect(calls)
			.toStrictEqual(['first', 'second', 'third'])
		for (const middleware of [first, second, third]) {
			expect(middleware)
				.toHaveBeenCalledWith(to, from)
		}
	})

	it.each([
		['synchronously', true, false],
		['asynchronously', true, true],
		['synchronously', null, false],
		['asynchronously', null, true],
		['synchronously', undefined, false],
		['asynchronously', undefined, true],
	] satisfies Array<[string, true | null | undefined, boolean]>)('continues only for %s returned %j', async (_mode, value, asynchronous) => {
		const first = continuingMiddleware(value, asynchronous)
		const last = vi.fn(() => true)
		const to = createRoute({ path: '/continue', matched: [[first, last]] })
		const from = createRoute({ path: '/source' })

		await expect(handleMiddlewares(to, from)).resolves.toBe(true)
		expect(first)
			.toHaveBeenCalledWith(to, from)
		expect(last)
			.toHaveBeenCalledWith(to, from)
	})

	it.each([
		['false', false],
		['a redirect location', { name: 'login', query: { reason: 'expired' } }],
		['an unsupported falsy value', 0],
	] as const)('returns %s exactly and stops later middleware', async (_description, stopResult) => {
		const stop = vi.fn(() => stopResult) as unknown as Middleware
		const after = vi.fn(() => true)
		const to = createRoute({ path: '/stop', matched: [[stop, after]] })
		const from = createRoute({ path: '/source' })

		await expect(handleMiddlewares(to, from)).resolves.toBe(stopResult)
		expect(stop)
			.toHaveBeenCalledWith(to, from)
		expect(after).not.toHaveBeenCalled()
	})

	it('propagates a middleware rejection and never calls the following middleware', async () => {
		const error = new Error('middleware rejected')
		const reject = vi.fn(async () => Promise.reject(error)) as unknown as Middleware
		const after = vi.fn(() => true)
		const to = createRoute({ path: '/error', matched: [[reject, after]] })
		const from = createRoute({ path: '/source' })

		await expect(handleMiddlewares(to, from)).rejects.toBe(error)
		expect(reject)
			.toHaveBeenCalledWith(to, from)
		expect(after).not.toHaveBeenCalled()
	})
})
