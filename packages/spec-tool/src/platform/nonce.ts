/**
 * Initialization nonce generation (13-cli-contract.md "Initialization
 * claim-and-complete protocol"). The nonce is runtime state, never
 * authoritative, and proves ownership of an in-progress `ef init` claim once
 * the marker file exists.
 */

import { randomBytes } from 'node:crypto'

/** A fresh 128-bit lowercase hexadecimal nonce, as required by the init marker (13-cli-contract.md). */
export function generateNonce(): string {
	return randomBytes(16)
		.toString('hex')
}
