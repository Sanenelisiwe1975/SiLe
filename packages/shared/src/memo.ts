import {
  type Address,
  type Hex,
  encodeAbiParameters,
  encodePacked,
  getAddress,
  hexToBigInt,
  keccak256,
  size,
  slice,
} from 'viem'

/**
 * Invoice memo codec — mirrors contracts/src/libs/Invoice.sol. An invoice id IS the memo.
 *   [0..4)   bytes4  magic "SiLe"
 *   [4]      uint8   version (1)
 *   [5..8)   bytes3  reserved (zero)
 *   [8..16)  uint64  subscription id
 *   [16..20) uint32  invoice sequence number (retries reuse it)
 *   [20..32) bytes12 deployment tag = bytes12(keccak256(abi.encode(chainId, ledger)))
 */
export const MEMO_MAGIC: Hex = '0x53694c65' // "SiLe"
export const MEMO_VERSION = 1

export type InvoiceMemo = { subId: bigint; seq: number; deploymentTag: Hex }

export class InvalidMemoError extends Error {
  constructor(memo: string) {
    super(`not a SiLe v${MEMO_VERSION} invoice memo: ${memo}`)
    this.name = 'InvalidMemoError'
  }
}

export function deploymentTag(chainId: number | bigint, ledger: Address): Hex {
  const hash = keccak256(
    encodeAbiParameters([{ type: 'uint256' }, { type: 'address' }], [BigInt(chainId), getAddress(ledger)]),
  )
  return slice(hash, 0, 12)
}

export function encodeInvoiceMemoWithTag(tag: Hex, subId: bigint, seq: number): Hex {
  if (size(tag) !== 12) throw new Error('deployment tag must be 12 bytes')
  return encodePacked(
    ['bytes4', 'uint8', 'bytes3', 'uint64', 'uint32', 'bytes12'],
    [MEMO_MAGIC, MEMO_VERSION, '0x000000', subId, seq, tag],
  )
}

export function encodeInvoiceMemo(p: { chainId: number | bigint; ledger: Address; subId: bigint; seq: number }): Hex {
  return encodeInvoiceMemoWithTag(deploymentTag(p.chainId, p.ledger), p.subId, p.seq)
}

export function isSileMemo(memo: Hex): boolean {
  try {
    decodeInvoiceMemo(memo)
    return true
  } catch {
    return false
  }
}

export function decodeInvoiceMemo(memo: Hex): InvoiceMemo {
  if (!/^0x[0-9a-fA-F]{64}$/.test(memo)) throw new InvalidMemoError(memo)
  const m = memo.toLowerCase() as Hex
  if (slice(m, 0, 4) !== MEMO_MAGIC || Number(hexToBigInt(slice(m, 4, 5))) !== MEMO_VERSION) {
    throw new InvalidMemoError(memo)
  }
  if (slice(m, 5, 8) !== '0x000000') throw new InvalidMemoError(memo)
  return {
    subId: hexToBigInt(slice(m, 8, 16)),
    seq: Number(hexToBigInt(slice(m, 16, 20))),
    deploymentTag: slice(m, 20, 32),
  }
}
