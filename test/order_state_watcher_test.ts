import 'mocha';
import * as chai from 'chai';
import * as _ from 'lodash';
import * as Web3 from 'web3';
import BigNumber from 'bignumber.js';
import { chaiSetup } from './utils/chai_setup';
import { web3Factory } from './utils/web3_factory';
import { Web3Wrapper } from '../src/web3_wrapper';
import { OrderStateWatcher } from '../src/order_watcher/order_state_watcher';
import {
    Token,
    ZeroEx,
    LogEvent,
    DecodedLogEvent,
    OrderState,
    SignedOrder,
    ZeroExError,
    OrderStateValid,
    OrderStateInvalid,
    ExchangeContractErrs,
} from '../src';
import { TokenUtils } from './utils/token_utils';
import { FillScenarios } from './utils/fill_scenarios';
import { DoneCallback } from '../src/types';
import {reportCallbackErrors} from './utils/report_callback_errors';

chaiSetup.configure();
const expect = chai.expect;

describe('OrderStateWatcher', () => {
    let web3: Web3;
    let zeroEx: ZeroEx;
    let tokens: Token[];
    let tokenUtils: TokenUtils;
    let fillScenarios: FillScenarios;
    let userAddresses: string[];
    let zrxTokenAddress: string;
    let exchangeContractAddress: string;
    let makerToken: Token;
    let takerToken: Token;
    let maker: string;
    let taker: string;
    let web3Wrapper: Web3Wrapper;
    let signedOrder: SignedOrder;
    const fillableAmount = new BigNumber(5);
    const numConfirmations = 0;
    before(async () => {
        web3 = web3Factory.create();
        zeroEx = new ZeroEx(web3.currentProvider);
        exchangeContractAddress = await zeroEx.exchange.getContractAddressAsync();
        userAddresses = await zeroEx.getAvailableAddressesAsync();
        [, maker, taker] = userAddresses;
        tokens = await zeroEx.tokenRegistry.getTokensAsync();
        tokenUtils = new TokenUtils(tokens);
        zrxTokenAddress = tokenUtils.getProtocolTokenOrThrow().address;
        fillScenarios = new FillScenarios(zeroEx, userAddresses, tokens, zrxTokenAddress, exchangeContractAddress);
        [makerToken, takerToken] = tokenUtils.getNonProtocolTokens();
        web3Wrapper = (zeroEx as any)._web3Wrapper;
    });
    describe('#removeOrder', async () => {
        it('should successfully remove existing order', async () => {
            signedOrder = await fillScenarios.createFillableSignedOrderAsync(
                makerToken.address, takerToken.address, maker, taker, fillableAmount,
            );
            const orderHash = ZeroEx.getOrderHashHex(signedOrder);
            zeroEx.orderStateWatcher.addOrder(signedOrder);
            expect((zeroEx.orderStateWatcher as any)._orders).to.include({
                [orderHash]: signedOrder,
            });
            let dependentOrderHashes = (zeroEx.orderStateWatcher as any)._dependentOrderHashes;
            expect(dependentOrderHashes[signedOrder.maker][signedOrder.makerTokenAddress]).to.have.keys(orderHash);
            zeroEx.orderStateWatcher.removeOrder(orderHash);
            expect((zeroEx.orderStateWatcher as any)._orders).to.not.include({
                [orderHash]: signedOrder,
            });
            dependentOrderHashes = (zeroEx.orderStateWatcher as any)._dependentOrderHashes;
            expect(dependentOrderHashes[signedOrder.maker][signedOrder.makerTokenAddress]).to.not.have.keys(orderHash);
        });
        it('should no-op when removing a non-existing order', async () => {
            signedOrder = await fillScenarios.createFillableSignedOrderAsync(
                makerToken.address, takerToken.address, maker, taker, fillableAmount,
            );
            const orderHash = ZeroEx.getOrderHashHex(signedOrder);
            const nonExistentOrderHash = `0x${orderHash.substr(2).split('').reverse().join('')}`;
            zeroEx.orderStateWatcher.removeOrder(nonExistentOrderHash);
        });
    });
    describe('#subscribe', async () => {
        afterEach(async () => {
            zeroEx.orderStateWatcher.unsubscribe();
        });
        it('should fail when trying to subscribe twice', async () => {
            await zeroEx.orderStateWatcher.subscribeAsync(_.noop);
            return expect(zeroEx.orderStateWatcher.subscribeAsync(_.noop))
                .to.be.rejectedWith(ZeroExError.SubscriptionAlreadyPresent);
        });
    });
    describe('tests with cleanup', async () => {
        afterEach(async () => {
            zeroEx.orderStateWatcher.unsubscribe();
            const orderHash = ZeroEx.getOrderHashHex(signedOrder);
            zeroEx.orderStateWatcher.removeOrder(orderHash);
        });
        it('should emit orderStateInvalid when maker allowance set to 0 for watched order', (done: DoneCallback) => {
            (async () => {
                signedOrder = await fillScenarios.createFillableSignedOrderAsync(
                    makerToken.address, takerToken.address, maker, taker, fillableAmount,
                );
                const orderHash = ZeroEx.getOrderHashHex(signedOrder);
                zeroEx.orderStateWatcher.addOrder(signedOrder);
                const callback = reportCallbackErrors(done)((orderState: OrderState) => {
                    expect(orderState.isValid).to.be.false();
                    const invalidOrderState = orderState as OrderStateInvalid;
                    expect(invalidOrderState.orderHash).to.be.equal(orderHash);
                    expect(invalidOrderState.error).to.be.equal(ExchangeContractErrs.InsufficientMakerAllowance);
                    done();
                });
                await zeroEx.orderStateWatcher.subscribeAsync(callback);
                await zeroEx.token.setProxyAllowanceAsync(makerToken.address, maker, new BigNumber(0));
            })().catch(done);
        });
        it('should emit orderStateInvalid when maker moves balance backing watched order', (done: DoneCallback) => {
            (async () => {
                signedOrder = await fillScenarios.createFillableSignedOrderAsync(
                    makerToken.address, takerToken.address, maker, taker, fillableAmount,
                );
                const orderHash = ZeroEx.getOrderHashHex(signedOrder);
                zeroEx.orderStateWatcher.addOrder(signedOrder);
                const callback = reportCallbackErrors(done)((orderState: OrderState) => {
                    expect(orderState.isValid).to.be.false();
                    const invalidOrderState = orderState as OrderStateInvalid;
                    expect(invalidOrderState.orderHash).to.be.equal(orderHash);
                    expect(invalidOrderState.error).to.be.equal(ExchangeContractErrs.InsufficientMakerBalance);
                    done();
                });
                await zeroEx.orderStateWatcher.subscribeAsync(callback);
                const anyRecipient = taker;
                const makerBalance = await zeroEx.token.getBalanceAsync(makerToken.address, maker);
                await zeroEx.token.transferAsync(makerToken.address, maker, anyRecipient, makerBalance);
            })().catch(done);
        });
        it('should emit orderStateInvalid when watched order fully filled', (done: DoneCallback) => {
            (async () => {
                signedOrder = await fillScenarios.createFillableSignedOrderAsync(
                    makerToken.address, takerToken.address, maker, taker, fillableAmount,
                );
                const orderHash = ZeroEx.getOrderHashHex(signedOrder);
                zeroEx.orderStateWatcher.addOrder(signedOrder);

                let eventCount = 0;
                const callback = reportCallbackErrors(done)((orderState: OrderState) => {
                    eventCount++;
                    expect(orderState.isValid).to.be.false();
                    const invalidOrderState = orderState as OrderStateInvalid;
                    expect(invalidOrderState.orderHash).to.be.equal(orderHash);
                    expect(invalidOrderState.error).to.be.equal(ExchangeContractErrs.OrderRemainingFillAmountZero);
                    if (eventCount === 2) {
                        done();
                    }
                });
                await zeroEx.orderStateWatcher.subscribeAsync(callback);

                const shouldThrowOnInsufficientBalanceOrAllowance = true;
                await zeroEx.exchange.fillOrderAsync(
                    signedOrder, fillableAmount, shouldThrowOnInsufficientBalanceOrAllowance, taker,
                );
            })().catch(done);
        });
        it('should emit orderStateValid when watched order partially filled', (done: DoneCallback) => {
            (async () => {
                signedOrder = await fillScenarios.createFillableSignedOrderAsync(
                    makerToken.address, takerToken.address, maker, taker, fillableAmount,
                );

                const makerBalance = await zeroEx.token.getBalanceAsync(makerToken.address, maker);
                const takerBalance = await zeroEx.token.getBalanceAsync(makerToken.address, taker);

                const fillAmountInBaseUnits = new BigNumber(2);
                const orderHash = ZeroEx.getOrderHashHex(signedOrder);
                zeroEx.orderStateWatcher.addOrder(signedOrder);

                let eventCount = 0;
                const callback = reportCallbackErrors(done)((orderState: OrderState) => {
                    eventCount++;
                    expect(orderState.isValid).to.be.true();
                    const validOrderState = orderState as OrderStateValid;
                    expect(validOrderState.orderHash).to.be.equal(orderHash);
                    const orderRelevantState = validOrderState.orderRelevantState;
                    const remainingMakerBalance = makerBalance.sub(fillAmountInBaseUnits);
                    expect(orderRelevantState.makerBalance).to.be.bignumber.equal(remainingMakerBalance);
                    if (eventCount === 2) {
                        done();
                    }
                });
                await zeroEx.orderStateWatcher.subscribeAsync(callback);
                const shouldThrowOnInsufficientBalanceOrAllowance = true;
                await zeroEx.exchange.fillOrderAsync(
                    signedOrder, fillAmountInBaseUnits, shouldThrowOnInsufficientBalanceOrAllowance, taker,
                );
            })().catch(done);
        });
        it('should emit orderStateValid when watched order cancelled', (done: DoneCallback) => {
            (async () => {
                signedOrder = await fillScenarios.createFillableSignedOrderAsync(
                    makerToken.address, takerToken.address, maker, taker, fillableAmount,
                );
                const orderHash = ZeroEx.getOrderHashHex(signedOrder);
                zeroEx.orderStateWatcher.addOrder(signedOrder);

                const callback = reportCallbackErrors(done)((orderState: OrderState) => {
                    expect(orderState.isValid).to.be.false();
                    const invalidOrderState = orderState as OrderStateInvalid;
                    expect(invalidOrderState.orderHash).to.be.equal(orderHash);
                    expect(invalidOrderState.error).to.be.equal(ExchangeContractErrs.OrderRemainingFillAmountZero);
                    done();
                });
                await zeroEx.orderStateWatcher.subscribeAsync(callback);

                const shouldThrowOnInsufficientBalanceOrAllowance = true;
                await zeroEx.exchange.cancelOrderAsync(signedOrder, fillableAmount);
            })().catch(done);
        });
        it('should emit orderStateValid when watched order partially filled', (done: DoneCallback) => {
            (async () => {
                signedOrder = await fillScenarios.createFillableSignedOrderAsync(
                    makerToken.address, takerToken.address, maker, taker, fillableAmount,
                );

                const makerBalance = await zeroEx.token.getBalanceAsync(makerToken.address, maker);
                const takerBalance = await zeroEx.token.getBalanceAsync(makerToken.address, taker);

                const cancelAmountInBaseUnits = new BigNumber(2);
                const orderHash = ZeroEx.getOrderHashHex(signedOrder);
                zeroEx.orderStateWatcher.addOrder(signedOrder);

                const callback = reportCallbackErrors(done)((orderState: OrderState) => {
                    expect(orderState.isValid).to.be.true();
                    const validOrderState = orderState as OrderStateValid;
                    expect(validOrderState.orderHash).to.be.equal(orderHash);
                    const orderRelevantState = validOrderState.orderRelevantState;
                    expect(orderRelevantState.canceledTakerTokenAmount).to.be.bignumber.equal(cancelAmountInBaseUnits);
                    done();
                });
                await zeroEx.orderStateWatcher.subscribeAsync(callback);
                await zeroEx.exchange.cancelOrderAsync(signedOrder, cancelAmountInBaseUnits);
            })().catch(done);
        });
    });
});
