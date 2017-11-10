import * as _ from 'lodash';
import {schemas} from '0x-json-schemas';
import {ZeroEx} from '../0x';
import {EventWatcher} from './event_watcher';
import {assert} from '../utils/assert';
import {utils} from '../utils/utils';
import {artifacts} from '../artifacts';
import {AbiDecoder} from '../utils/abi_decoder';
import {OrderStateUtils} from '../utils/order_state_utils';
import {
    LogEvent,
    OrderState,
    SignedOrder,
    Web3Provider,
    BlockParamLiteral,
    LogWithDecodedArgs,
    OnOrderStateChangeCallback,
    OrderStateWatcherConfig,
    ExchangeEvents,
    TokenEvents,
    ZeroExError,
} from '../types';
import {Web3Wrapper} from '../web3_wrapper';
import {BlockStore} from '../stores/block_store';
import {TokenWrapper} from '../contract_wrappers/token_wrapper';
import {ExchangeWrapper} from '../contract_wrappers/exchange_wrapper';
import {OrderFilledCancelledLazyStore} from '../stores/order_filled_cancelled_lazy_store';
import {BalanceAndProxyAllowanceLazyStore} from '../stores/balance_proxy_allowance_lazy_store';

const DEFAULT_NUM_CONFIRMATIONS = 0;

interface DependentOrderHashes {
    [makerAddress: string]: {
        [makerToken: string]: Set<string>,
    };
}

interface OrderByOrderHash {
    [orderHash: string]: SignedOrder;
}

export class OrderStateWatcher {
    private _orders: OrderByOrderHash;
    private _dependentOrderHashes: DependentOrderHashes;
    private _callbackIfExistsAsync?: OnOrderStateChangeCallback;
    private _eventWatcher: EventWatcher;
    private _web3Wrapper: Web3Wrapper;
    private _token: TokenWrapper;
    private _exchange: ExchangeWrapper;
    private _abiDecoder: AbiDecoder;
    private _orderStateUtils?: OrderStateUtils;
    private _blockStore?: BlockStore;
    private _numConfirmations: number;
    private _orderFilledCancelledLazyStore?: OrderFilledCancelledLazyStore;
    private _balanceAndProxyAllowanceLazyStore?: BalanceAndProxyAllowanceLazyStore;
    constructor(
        web3Wrapper: Web3Wrapper, abiDecoder: AbiDecoder, token: TokenWrapper, exchange: ExchangeWrapper,
        config?: OrderStateWatcherConfig,
    ) {
        this._orders = {};
        this._web3Wrapper = web3Wrapper;
        this._dependentOrderHashes = {};
        const eventPollingIntervalMs = _.isUndefined(config) ? undefined : config.pollingIntervalMs;
        this._numConfirmations = _.isUndefined(config) ?
                                    DEFAULT_NUM_CONFIRMATIONS
                                    : config.numConfirmations;
        this._eventWatcher = new EventWatcher(
            web3Wrapper, eventPollingIntervalMs, this._numConfirmations,
        );
        this._abiDecoder = abiDecoder;
        this._token = token;
        this._exchange = exchange;
    }
    /**
     * Add an order to the orderStateWatcher
     * @param   signedOrder     The order you wish to start watching.
     */
    public addOrder(signedOrder: SignedOrder): void {
        assert.doesConformToSchema('signedOrder', signedOrder, schemas.signedOrderSchema);
        const orderHash = ZeroEx.getOrderHashHex(signedOrder);
        assert.isValidSignature(orderHash, signedOrder.ecSignature, signedOrder.maker);
        this._orders[orderHash] = signedOrder;
        this.addToDependentOrderHashes(signedOrder, orderHash);
    }
    /**
     * Removes an order from the orderStateWatcher
     * @param   orderHash     The orderHash of the order you wish to stop watching.
     */
    public removeOrder(orderHash: string): void {
        assert.doesConformToSchema('orderHash', orderHash, schemas.orderHashSchema);
        const signedOrder = this._orders[orderHash];
        if (_.isUndefined(signedOrder)) {
            return; // noop
        }
        delete this._orders[orderHash];
        this._dependentOrderHashes[signedOrder.maker][signedOrder.makerTokenAddress].delete(orderHash);
        // We currently do not remove the maker/makerToken keys from the mapping when all orderHashes removed
    }
    /**
     * Starts an orderStateWatcher subscription. The callback will be called every time a watched order's
     * backing blockchain state has changed. This is a call-to-action for the caller to re-validate the order.
     * @param   callback            Receives the orderHash of the order that should be re-validated, together
     *                              with all the order-relevant blockchain state needed to re-validate the order.
     * @param   numConfirmations    Number of confirmed blocks deeps you want to run the orderWatcher from. Passing
     *                              is 0 will watch the backing node's mempool, 3 will emit events when blockchain
     *                              state relevant to a watched order changed 3 blocks ago.
     */
    public async subscribeAsync(callback: OnOrderStateChangeCallback): Promise<void> {
        assert.isFunction('callback', callback);
        if (!_.isUndefined(this._callbackIfExistsAsync)) {
            throw new Error(ZeroExError.SubscriptionAlreadyPresent);
        }
        this._blockStore = new BlockStore(this._web3Wrapper);
        await this._blockStore.startAsync();
        this._balanceAndProxyAllowanceLazyStore = new BalanceAndProxyAllowanceLazyStore(
            this._token, this._blockStore, this._numConfirmations,
        );
        this._orderFilledCancelledLazyStore = new OrderFilledCancelledLazyStore(
            this._exchange, this._blockStore, this._numConfirmations,
        );
        this._orderStateUtils = new OrderStateUtils(
            this._balanceAndProxyAllowanceLazyStore, this._orderFilledCancelledLazyStore,
        );
        this._callbackIfExistsAsync = callback;
        this._eventWatcher.subscribe(this._onEventWatcherCallbackAsync.bind(this));
    }
    /**
     * Ends an orderStateWatcher subscription.
     */
    public unsubscribe(): void {
        if (_.isUndefined(this._blockStore)) {
            throw new Error(ZeroExError.SubscriptionNotFound);
        }
        this._blockStore.stop();
        delete this._blockStore;
        delete this._callbackIfExistsAsync;
        delete this._balanceAndProxyAllowanceLazyStore;
        delete this._orderFilledCancelledLazyStore;
        delete this._orderStateUtils;
        this._eventWatcher.unsubscribe();
    }
    private async _onEventWatcherCallbackAsync(log: LogEvent): Promise<void> {
        const maybeDecodedLog = this._abiDecoder.tryToDecodeLogOrNoop(log);
        const isDecodedLog = !_.isUndefined((maybeDecodedLog as LogWithDecodedArgs<any>).event);
        if (!isDecodedLog) {
            return; // noop
        }
        const decodedLog = maybeDecodedLog as LogWithDecodedArgs<any>;
        let makerToken: string;
        let makerAddress: string;
        let orderHashesSet: Set<string>;
        switch (decodedLog.event) {
            case TokenEvents.Approval:
                makerToken = decodedLog.address;
                makerAddress = decodedLog.args._owner;
                orderHashesSet = _.get(this._dependentOrderHashes, [makerAddress, makerToken]);
                if (!_.isUndefined(orderHashesSet)) {
                    const orderHashes = Array.from(orderHashesSet);
                    await this._emitRevalidateOrdersAsync(orderHashes);
                }
                break;

            case TokenEvents.Transfer:
                makerToken = decodedLog.address;
                makerAddress = decodedLog.args._from;
                orderHashesSet = _.get(this._dependentOrderHashes, [makerAddress, makerToken]);
                if (!_.isUndefined(orderHashesSet)) {
                    const orderHashes = Array.from(orderHashesSet);
                    await this._emitRevalidateOrdersAsync(orderHashes);
                }
                break;

            case ExchangeEvents.LogFill:
            case ExchangeEvents.LogCancel:
                const orderHash = decodedLog.args.orderHash;
                const isOrderWatched = !_.isUndefined(this._orders[orderHash]);
                if (isOrderWatched) {
                    await this._emitRevalidateOrdersAsync([orderHash]);
                }
                break;

            case ExchangeEvents.LogError:
                return; // noop

            default:
                throw utils.spawnSwitchErr('decodedLog.event', decodedLog.event);
        }
    }
    private async _emitRevalidateOrdersAsync(orderHashes: string[]): Promise<void> {
        const defaultBlock = this._numConfirmations === 0 ?
                                BlockParamLiteral.Pending :
                                this._numConfirmations;
        const methodOpts = {
            defaultBlock,
        };

        for (const orderHash of orderHashes) {
            const signedOrder = this._orders[orderHash] as SignedOrder;
            if (_.isUndefined(this._orderStateUtils)) {
                break; // Unsubscribe was called
            }
            const orderState = await this._orderStateUtils.getOrderStateAsync(signedOrder);
            if (_.isUndefined(this._callbackIfExistsAsync)) {
                break; // Unsubscribe was called
            }
            await this._callbackIfExistsAsync(orderState);
        }
    }
    private addToDependentOrderHashes(signedOrder: SignedOrder, orderHash: string) {
        if (_.isUndefined(this._dependentOrderHashes[signedOrder.maker])) {
            this._dependentOrderHashes[signedOrder.maker] = {};
        }
        if (_.isUndefined(this._dependentOrderHashes[signedOrder.maker][signedOrder.makerTokenAddress])) {
            this._dependentOrderHashes[signedOrder.maker][signedOrder.makerTokenAddress] = new Set();
        }
        this._dependentOrderHashes[signedOrder.maker][signedOrder.makerTokenAddress].add(orderHash);
    }
}
