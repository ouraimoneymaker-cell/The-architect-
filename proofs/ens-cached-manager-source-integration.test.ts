import { readFileSync } from 'node:fs'
import { assert, describe, expect, it, vi } from 'vitest'
import {
  type Address,
  decodeFunctionData,
  getAddress,
  type PublicClient,
} from 'viem'
import { sepolia } from 'viem/chains'

import { ETH_REGISTRY_V2_ABI } from './contracts/abis'
import { V2_CONTRACTS } from './contracts/addresses'
import {
  buildAtomicMigrationBatches,
  type AtomicMigrationVerificationExpectation,
} from './buildAtomicMigrationBatches'
import { buildRoleGrantCall } from './buildRoleGrantCalls'
import { classifyNames } from './classifyNames'
import type { DirectMigrationRoute } from './directMigrationRoutes'
import { verifyAtomicMigrationBatch } from './verifyAtomicMigrationBatch'

const OWNER: Address = '0x0000000000000000000000000000000000000001'
const STALE_MANAGER: Address = '0x00000000000000000000000000000000000000a7'
const CURRENT_V1_MANAGER_AFTER_REVOKE: Address = OWNER
const HCA: Address = '0x00000000000000000000000000000000000000b1'
const V1_RESOLVER: Address = '0x00000000000000000000000000000000000000e1'
const ROLE_SET_RESOLVER = 1n << 24n
const CACHE_TTL_MS = 5 * 60 * 1000

const cachedDomainSnapshot = {
  id: '0x01',
  labelName: 'alice',
  labelhash: '0x02',
  name: 'alice.eth',
  resolver: { address: V1_RESOLVER },
  // This is the stale value retained by useV1Names() for 5 minutes.
  owner: { id: STALE_MANAGER },
  registrant: { id: OWNER },
  wrappedOwner: null,
  parent: { name: 'eth', wrappedDomain: null },
  registration: { expiryDate: '9999999999' },
  wrappedDomain: null,
}

const directRoute: DirectMigrationRoute = {
  name: 'alice.eth',
  receiver: V2_CONTRACTS.UnlockedMigrationController,
  parentDependency: null,
  expectedWrapperRegistry: null,
  receiverReadiness: 'migration-controller',
}

const decodeGrant = (data: `0x${string}`) => {
  const decoded = decodeFunctionData({ abi: ETH_REGISTRY_V2_ABI, data })
  expect(decoded.functionName).toBe('grantRoles')
  const [resource, roleBitmap, account] = decoded.args as readonly [
    bigint,
    bigint,
    Address,
  ]
  return { resource, roleBitmap, account: getAddress(account) }
}

describe('ENS cached-manager source-faithful dataflow', () => {
  it('flows the 5-minute cached manager through audited classify/build/atomic/verify code into ROLE_SET_RESOLVER', async () => {
    console.log('=== ENS_CACHED_MANAGER_SOURCE_INTEGRATION_BEGIN ===')

    // Anchor the cache window to the exact audited hook source, not a modeled copy.
    const useV1NamesSource = readFileSync(
      new URL('../hooks/useV1Names.ts', import.meta.url),
      'utf8',
    )
    expect(useV1NamesSource).toContain('staleTime: 5 * 60 * 1000')
    console.log(`AUDITED_CACHE_TTL_MS=${CACHE_TTL_MS}`)
    console.log('AUDITED_CACHE_SOURCE=apps/manager/src/features/migration/hooks/useV1Names.ts')

    // Control state: the old manager has been revoked in authoritative V1 state.
    expect(STALE_MANAGER).not.toBe(CURRENT_V1_MANAGER_AFTER_REVOKE)
    console.log(`CACHED_MANAGER=${STALE_MANAGER}`)
    console.log(`CURRENT_V1_MANAGER_AFTER_REVOKE=${CURRENT_V1_MANAGER_AFTER_REVOKE}`)

    // 1) Actual audited classifier consumes the cached subgraph snapshot.
    const classifiedResult = classifyNames([cachedDomainSnapshot], OWNER)
    expect(classifiedResult.ineligible).toHaveLength(0)
    expect(classifiedResult.classified).toHaveLength(1)
    const classified = classifiedResult.classified[0]
    assert(classified)
    expect(classified.managerAddress).toBe(STALE_MANAGER)
    expect(classified.managerAddress).not.toBe(CURRENT_V1_MANAGER_AFTER_REVOKE)
    console.log(`CLASSIFY_MANAGER_ADDRESS=${classified.managerAddress}`)
    console.log(`CLASSIFY_TOKEN_TYPE=${classified.tokenType}`)
    console.log(`CLASSIFY_RESOLVER_STRATEGY=${classified.resolverStrategy}`)

    // 2) Actual audited role-grant builder encodes the stale manager directly.
    const directGrant = buildRoleGrantCall(classified)
    const decodedDirectGrant = decodeGrant(directGrant.data)
    expect(decodedDirectGrant.roleBitmap).toBe(ROLE_SET_RESOLVER)
    expect(decodedDirectGrant.account).toBe(getAddress(STALE_MANAGER))
    console.log(`DIRECT_GRANT_TO=${directGrant.to}`)
    console.log(`DIRECT_GRANT_RESOURCE=${decodedDirectGrant.resource}`)
    console.log(`DIRECT_GRANT_ROLE_BITMAP=${decodedDirectGrant.roleBitmap}`)
    console.log(`DIRECT_GRANT_ACCOUNT=${decodedDirectGrant.account}`)

    // 3) Actual audited atomic builder retains that same unauthorized grant.
    const plan = await buildAtomicMigrationBatches({
      chainId: sepolia.id,
      hca: HCA,
      wallet: OWNER,
      classified: [classified],
      directRoutes: new Map([['alice.eth', directRoute]]),
      profiles: new Map(),
      resolverDeployed: true,
      walletCoAdminGranted: true,
      maxOuterGas: 1_000_000n,
      estimateOuterGas: () => 100_000n,
    })

    const batch = plan.batches[0]
    assert(batch)
    const managerExecution = batch.innerExecutions.find(
      (execution) => execution.phase === 'manager-role-grant',
    )
    assert(managerExecution)
    const decodedAtomicGrant = decodeGrant(managerExecution.call.data)
    expect(decodedAtomicGrant.account).toBe(getAddress(STALE_MANAGER))
    expect(decodedAtomicGrant.roleBitmap).toBe(ROLE_SET_RESOLVER)
    expect(managerExecution.call.data).toBe(directGrant.data)
    console.log(`ATOMIC_PHASE=${managerExecution.phase}`)
    console.log(`ATOMIC_GRANT_RESOURCE=${decodedAtomicGrant.resource}`)
    console.log(`ATOMIC_GRANT_ROLE_BITMAP=${decodedAtomicGrant.roleBitmap}`)
    console.log(`ATOMIC_GRANT_ACCOUNT=${decodedAtomicGrant.account}`)

    const managerExpectation = batch.verificationExpectations.find(
      (expectation): expectation is Extract<
        AtomicMigrationVerificationExpectation,
        { readonly type: 'manager-role' }
      > => expectation.type === 'manager-role',
    )
    assert(managerExpectation)
    expect(managerExpectation.account).toBe(STALE_MANAGER)
    expect(managerExpectation.roleBitmap).toBe(ROLE_SET_RESOLVER)
    console.log(`VERIFIER_EXPECTED_MANAGER=${managerExpectation.account}`)
    console.log(`VERIFIER_EXPECTED_ROLE_BITMAP=${managerExpectation.roleBitmap}`)

    // 4) Actual audited verifier considers the stale-manager grant a successful
    // post-state. The fake client only supplies chain reads; verification logic
    // itself is the audited implementation imported above.
    const readContract = vi.fn(async (request: any) => {
      switch (request.functionName) {
        case 'getOwner':
          return OWNER
        case 'getResolver':
          return V1_RESOLVER
        case 'hasRoles': {
          const [resource, roleBitmap, account] = request.args as readonly [
            bigint,
            bigint,
            Address,
          ]
          expect(resource).toBe(managerExpectation.resource)
          expect(roleBitmap).toBe(ROLE_SET_RESOLVER)
          expect(getAddress(account)).toBe(getAddress(STALE_MANAGER))
          return true
        }
        default:
          throw new Error(`Unexpected verifier read: ${request.functionName}`)
      }
    })

    const publicClient = {
      readContract,
      getCode: vi.fn(),
    } as unknown as PublicClient

    const verification = await verifyAtomicMigrationBatch({
      publicClient,
      batch,
    })
    expect(verification.status).toBe('confirmed')
    expect(verification.results.every((result) => result.satisfied)).toBe(true)
    expect(
      verification.results.find(
        (result) => result.expectationId === managerExpectation.id,
      )?.satisfied,
    ).toBe(true)

    console.log(`VERIFIER_MANAGER_EXPECTATION_ID=${managerExpectation.id}`)
    console.log('VERIFIER_MANAGER_EXPECTATION_SATISFIED=true')
    console.log('UNAUTHORIZED_GRANT_DATAFLOW=PASS')
    console.log('SECURITY_ASSERTION=PASS')
    console.log('EVIDENCE_STATE=SOURCE-FAITHFUL-DATAFLOW-PROVEN')
    console.log('=== ENS_CACHED_MANAGER_SOURCE_INTEGRATION_END ===')
  })
})
