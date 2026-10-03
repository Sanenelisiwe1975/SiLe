import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import type { Hex } from 'viem'

/**
 * Custody of access-key private keys. Keys are NEVER logged or stored in plaintext.
 * The hackathon uses EnvSecretKeyStore (AES-256-GCM, key derived from KEYSTORE_SECRET);
 * production should use a KMS/HSM adapter that never exports the key (see KmsKeyStore).
 */
export interface KeyStore {
  /** Returns an opaque ciphertext / handle to persist. */
  seal(privateKey: Hex): Promise<string>
  open(sealed: string): Promise<Hex>
}

export class EnvSecretKeyStore implements KeyStore {
  readonly #key: Buffer

  constructor(secret: string) {
    if (secret.length < 32) throw new Error('KEYSTORE_SECRET must be at least 32 chars')
    this.#key = createHash('sha256').update(`sile-keystore-v1:${secret}`).digest()
  }

  async seal(privateKey: Hex): Promise<string> {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv)
    const ct = Buffer.concat([cipher.update(privateKey, 'utf8'), cipher.final()])
    return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ct.toString('base64')].join('.')
  }

  async open(sealed: string): Promise<Hex> {
    const [v, iv, tag, ct] = sealed.split('.')
    if (v !== 'v1' || !iv || !tag || !ct) throw new Error('unknown keystore format')
    const decipher = createDecipheriv('aes-256-gcm', this.#key, Buffer.from(iv, 'base64'))
    decipher.setAuthTag(Buffer.from(tag, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8') as Hex
  }
}

/** Stub: a real adapter would generate P256 keys inside KMS and sign digests remotely. */
export class KmsKeyStore implements KeyStore {
  constructor(readonly keyRing: string) {}
  async seal(): Promise<string> {
    throw new Error('KmsKeyStore not implemented (hackathon stub)')
  }
  async open(): Promise<Hex> {
    throw new Error('KmsKeyStore not implemented (hackathon stub)')
  }
}
