import * as _ from 'lodash';
import BigNumber from 'bignumber.js';
import {ExchangeContractErrs, TradeSide, TransferType, BlockParamLiteral} from '../types';
import {TokenWrapper} from '../contract_wrappers/token_wrapper';
import {BalanceAndProxyAllowanceLazyStore} from '../stores/balance_proxy_allowance_lazy_store';
import {BlockStore} from '../stores/block_store';

enum FailureReason {
    Balance = 'balance',
    ProxyAllowance = 'proxyAllowance',
}

const ERR_MSG_MAPPING = {
    [FailureReason.Balance]: {
        [TradeSide.Maker]: {
            [TransferType.Trade]: ExchangeContractErrs.InsufficientMakerBalance,
            [TransferType.Fee]: ExchangeContractErrs.InsufficientMakerFeeBalance,
        },
        [TradeSide.Taker]: {
            [TransferType.Trade]: ExchangeContractErrs.InsufficientTakerBalance,
            [TransferType.Fee]: ExchangeContractErrs.InsufficientTakerFeeBalance,
        },
    },
    [FailureReason.ProxyAllowance]: {
        [TradeSide.Maker]: {
            [TransferType.Trade]: ExchangeContractErrs.InsufficientMakerAllowance,
            [TransferType.Fee]: ExchangeContractErrs.InsufficientMakerFeeAllowance,
        },
        [TradeSide.Taker]: {
            [TransferType.Trade]: ExchangeContractErrs.InsufficientTakerAllowance,
            [TransferType.Fee]: ExchangeContractErrs.InsufficientTakerFeeAllowance,
        },
    },
};

export class ExchangeTransferSimulator {
    private store: BalanceAndProxyAllowanceLazyStore;
    private UNLIMITED_ALLOWANCE_IN_BASE_UNITS: BigNumber;
    constructor(token: TokenWrapper) {
        const blockStore = new BlockStore();
        const latestBlockConfirmationNumber = 1;
        this.store = new BalanceAndProxyAllowanceLazyStore(token, blockStore, latestBlockConfirmationNumber);
        this.UNLIMITED_ALLOWANCE_IN_BASE_UNITS = token.UNLIMITED_ALLOWANCE_IN_BASE_UNITS;
    }
    /**
     * Simulates transferFrom call performed by a proxy
     * @param  tokenAddress      Address of the token to be transferred
     * @param  from              Owner of the transferred tokens
     * @param  to                Recipient of the transferred tokens
     * @param  amountInBaseUnits The amount of tokens being transferred
     * @param  tradeSide         Is Maker/Taker transferring
     * @param  transferType      Is it a fee payment or a value transfer
     */
    public async transferFromAsync(tokenAddress: string, from: string, to: string,
                                   amountInBaseUnits: BigNumber, tradeSide: TradeSide,
                                   transferType: TransferType): Promise<void> {
        const balance = await this.store.getBalanceAsync(tokenAddress, from);
        const proxyAllowance = await this.store.getProxyAllowanceAsync(tokenAddress, from);
        if (proxyAllowance.lessThan(amountInBaseUnits)) {
            this.throwValidationError(FailureReason.ProxyAllowance, tradeSide, transferType);
        }
        if (balance.lessThan(amountInBaseUnits)) {
            this.throwValidationError(FailureReason.Balance, tradeSide, transferType);
        }
        await this.decreaseProxyAllowanceAsync(tokenAddress, from, amountInBaseUnits);
        await this.decreaseBalanceAsync(tokenAddress, from, amountInBaseUnits);
        await this.increaseBalanceAsync(tokenAddress, to, amountInBaseUnits);
    }
    private async decreaseProxyAllowanceAsync(tokenAddress: string, userAddress: string,
                                              amountInBaseUnits: BigNumber): Promise<void> {
        const proxyAllowance = await this.store.getProxyAllowanceAsync(tokenAddress, userAddress);
        if (!proxyAllowance.eq(this.UNLIMITED_ALLOWANCE_IN_BASE_UNITS)) {
            this.store.setProxyAllowance(tokenAddress, userAddress, proxyAllowance.minus(amountInBaseUnits));
        }
    }
    private async increaseBalanceAsync(tokenAddress: string, userAddress: string,
                                       amountInBaseUnits: BigNumber): Promise<void> {
        const balance = await this.store.getBalanceAsync(tokenAddress, userAddress);
        this.store.setBalance(tokenAddress, userAddress, balance.plus(amountInBaseUnits));
    }
    private async decreaseBalanceAsync(tokenAddress: string, userAddress: string,
                                       amountInBaseUnits: BigNumber): Promise<void> {
        const balance = await this.store.getBalanceAsync(tokenAddress, userAddress);
        this.store.setBalance(tokenAddress, userAddress, balance.minus(amountInBaseUnits));
    }
    private throwValidationError(failureReason: FailureReason, tradeSide: TradeSide,
                                 transferType: TransferType): Promise<never> {
        const errMsg = ERR_MSG_MAPPING[failureReason][tradeSide][transferType];
        throw new Error(errMsg);
    }
}
