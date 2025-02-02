import { Factories, ParaspaceMM, Types } from "paraspace-api"
import { APE_STAKING_POOL_ID, paraspaceConfigurations, StakingType } from "../constant"
import { runtime } from "../runtime"
import { splitRangeBySize, collectAndFlat, logger, mapErrMsg } from "@para-space/utils"
import { SimpleMatchOrder } from "../types"
import { chunk } from "lodash"
import { BigNumber, ethers } from "ethers"
import { strategy } from "../strategy"
import _ from "lodash"

const fetchValidMatchOrders = async (): Promise<string[]> => {
    const p2pPairStaking: Types.P2PPairStaking = await runtime.provider.connectContract(
        ParaspaceMM.P2PPairStaking
    )
    const startBlock = paraspaceConfigurations.p2pPairStartBlock[runtime.networkName]
    const endBlock = await runtime.provider.getProvider().getBlockNumber()

    const ranges: [number, number][] = splitRangeBySize(
        startBlock > endBlock ? [endBlock, endBlock] : [startBlock, endBlock],
        paraspaceConfigurations.requestedBlockRangeLimit
    )
    if (ranges.length) {
        logger.debug(
            `Requesting p2p orders from ${startBlock} to ${endBlock} in ${ranges.length} event ranges`
        )
    }
    const orderMatchedFilter = p2pPairStaking.filters.PairStakingMatched()
    const orderBrokenFilter = p2pPairStaking.filters.PairStakingBreakUp()

    const batchSize = 5
    let matchedOrders: string[] = []
    let brokenOrders: string[] = []
    for (let i = 0; i < ranges.length; i += batchSize) {
        const batch = ranges.slice(i, i + batchSize)
        const matchedEvents = await collectAndFlat(
            batch.map(range => p2pPairStaking.queryFilter(orderMatchedFilter, ...range))
        )
        matchedOrders.push(
            ...matchedEvents.map((data: { args: { orderHash: string } }) => data.args.orderHash)
        )

        const brokenEvents = await collectAndFlat(
            batch.map(range => p2pPairStaking.queryFilter(orderBrokenFilter, ...range))
        )
        brokenOrders.push(
            ...brokenEvents.map((data: { args: { orderHash: string } }) => data.args.orderHash)
        )
    }

    const matchedOrdersClone = _.cloneDeep(matchedOrders)

    matchedOrdersClone.forEach(hash => {
        const bindex = brokenOrders.indexOf(hash)
        const mindex = matchedOrders.indexOf(hash)
        if (bindex > -1) {
            brokenOrders.splice(bindex, 1)
            matchedOrders.splice(mindex, 1)
        }
    })

    return matchedOrders
}

const requestMatchedOrderInfo = async (orderHashes: string[]): Promise<SimpleMatchOrder[]> => {
    const p2pPairStaking = runtime.provider.connectMultiAbi(
        Factories.P2PPairStaking__factory,
        runtime.provider.getContracts().protocol.P2PPairStaking
    )
    try {
        const calls = orderHashes.map(hash => p2pPairStaking.matchedOrders(hash))
        const callResults = await Promise.all(
            chunk(calls, 1000).map(batch => runtime.provider.getMulticallProvider().all(batch))
        )
        return callResults
            .flat()
            .filter(data => data.apePrincipleAmount.gt(0))
            .map((data, i) => ({
                orderHash: orderHashes[i],
                stakingType: data.stakingType,
                apeToken: data.apeToken,
                apeTokenId: data.apeTokenId,
                bakcTokenId: data.bakcTokenId,
                pendingReward: BigNumber.from(0)
            }))
    } catch (e) {
        const errMsg = `requestMatchedOrderInfo error: ${mapErrMsg(e)}`
        throw new Error(errMsg)
    }
}

const filterByRewardLimit = async (orders: SimpleMatchOrder[]): Promise<SimpleMatchOrder[]> => {
    const p2pPairStaking: Types.P2PPairStaking = await runtime.provider.connectContract(
        ParaspaceMM.P2PPairStaking
    )
    const apeCoinStaking: Types.ApeCoinStaking = await runtime.provider.connectContract(
        ParaspaceMM.ApeCoinStaking
    )

    const stakes = await apeCoinStaking.getAllStakes(p2pPairStaking.address)
    const [baycLimit, maycLimit, bakcLimit] = [
        ethers.utils.parseEther(strategy[runtime.networkName].P2P_BAYC_TOKEN_PENDING_REWARD_LIMIT),
        ethers.utils.parseEther(strategy[runtime.networkName].P2P_MAYC_TOKEN_PENDING_REWARD_LIMIT),
        ethers.utils.parseEther(strategy[runtime.networkName].P2P_BAKC_TOKEN_PENDING_REWARD_LIMIT)
    ]
    const validOrders = orders.filter(order => {
        if (order.stakingType === StakingType.BAYCStaking) {
            const stakeInfo = stakes.find(
                data =>
                    data.poolId.toString() === APE_STAKING_POOL_ID.BAYC &&
                    data.tokenId.toNumber() === order.apeTokenId
            )
            order.pendingReward = stakeInfo?.unclaimed || BigNumber.from(0)
            return stakeInfo?.unclaimed.gt(baycLimit) || false
        } else if (order.stakingType === StakingType.MAYCStaking) {
            const stakeInfo = stakes.find(
                data =>
                    data.poolId.toString() === APE_STAKING_POOL_ID.MAYC &&
                    data.tokenId.toNumber() === order.apeTokenId
            )
            order.pendingReward = stakeInfo?.unclaimed || BigNumber.from(0)
            return stakeInfo?.unclaimed.gt(maycLimit) || false
        } else {
            const stakeInfo = stakes.find(
                data =>
                    data.poolId.toString() === APE_STAKING_POOL_ID.BAKC &&
                    data.tokenId.toNumber() === order.bakcTokenId
            )
            order.pendingReward = stakeInfo?.unclaimed || BigNumber.from(0)
            return stakeInfo?.unclaimed.gt(bakcLimit) || false
        }
    })
    return validOrders
}

export const fetchP2PCompoundInfo = async (): Promise<SimpleMatchOrder[]> => {
    const orderHashes = await fetchValidMatchOrders()
    const orders = await requestMatchedOrderInfo(orderHashes)
    const validOrders = await filterByRewardLimit(orders)
    return validOrders
}
