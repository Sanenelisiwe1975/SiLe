import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import type { Hex } from 'viem'

const PLACEHOLDER_PATTERNS = /(changeme|replace-me|example|test-secret|dev-secret|local-secret|secret|password)/i

export function validateKeyStoreSecret(secret: string): string {
  const value = secret.trim()
  if (!value) {
    throw new Error('KEYSTORE_SECRET is required')
  }
  if (PLACEHOLDER_PATTERNS.test(value)) {
    throw new Error('KEYSTORE_SECRET looks like a placeholder or insecure default; use a random secret instead')
  }
  if (value.length < 32) {
    throw new Error('KEYSTORE_SECRET must be at least 32 characters long')
  }
  return value
}

/**
 * Custody of access-key private keys. Keys are NEVER logged or stored in plaintext.
 * The local build uses EnvSecretKeyStore (AES-256-GCM, key derived from KEYSTORE_SECRET);
 * production should use a KMS/HSM adapter that never exports the key.
 */
export interface KeyStore {
  /** Returns an opaque ciphertext / handle to persist. */
  seal(privateKey: Hex): Promise<string>
  open(sealed: string): Promise<Hex>
}

export class EnvSecretKeyStore implements KeyStore {
  readonly #key: Buffer

  constructor(secret: string) {
    this.#key = createHash('sha256').update(`sile-keystore-v1:${validateKeyStoreSecret(secret)}`).digest()
  }

  async seal(privateKey: Hex): Promise<string> {
    if (!/^0x[0-9a-fA-F]+$/.test(privateKey)) {
      throw new Error('privateKey must be a hex string')
    }
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv)
    const ct = Buffer.concat([cipher.update(privateKey, 'utf8'), cipher.final()])
    return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ct.toString('base64')].join('.')
  }

  async open(sealed: string): Promise<Hex> {
    const [v, iv, tag, ct] = sealed.split('.')
    if (v !== 'v1' || !iv || !tag || !ct) throw new Error('unknown keystore format')
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.#key, Buffer.from(iv, 'base64'))
      decipher.setAuthTag(Buffer.from(tag, 'base64'))
      const out = Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8')
      return out as Hex
    } catch {
      throw new Error('keystore payload is invalid or tampered')
    }
  }
}

/** Stub: a real adapter would generate P256 keys inside KMS and sign digests remotely. */
export class KmsKeyStore implements KeyStore {
  constructor(readonly keyRing: string) {}
  async seal(): Promise<string> {
    throw new Error('KMS-backed key storage is not available in this local build; configure a production KMS adapter before deployment.')
  }
  async open(): Promise<Hex> {
    throw new Error('KMS-backed key storage is not available in this local build; configure a production KMS adapter before deployment.')
  }
}
