// Copyright 2019 Superblocks AB
//
// This file is part of Superblocks Lab.
//
// Superblocks Lab is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation version 3 of the License.
//
// Superblocks Lab is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with Superblocks. If not, see <http://www.gnu.org/licenses/>.

import { injectable, inject } from 'inversify';
import web3Utils from 'web3-utils';
import ora from 'ora';
import { ITransactionModel, IRpcPayload } from '../superblocks/models';
import { TYPES } from '../ioc/types';
import { ISuperblocksClient, IManualSignProvider, IPusherClient, IRpcClient } from '../ioc/interfaces';

interface IProviderOptions {
    from: string;
    endpoint: string;
    networkId: string;
}

@injectable()
export class ManualSignProvider implements IManualSignProvider {

    // Pre-defined variable setup by the Superblocks CI when executing the job including the deployment process
    private readonly PROJECT_ID: string = process.env.SUPER_PROJECT_ID;
    private readonly BUILD_CONFIG_ID: string = process.env.SUPER_BUILD_CONFIG_ID;
    private readonly CI_JOB_ID: string = process.env.CI_JOB_ID;
    private superblocksClient: ISuperblocksClient;
    private pusherClient: IPusherClient;
    private rpcClient: IRpcClient;
    private options: IProviderOptions;
    private pendingTxs: Map<string, ITransactionModel>;

    constructor(
        @inject(TYPES.SuperblocksClient) superblocksClient: ISuperblocksClient,
        @inject(TYPES.PusherClient) pusherClient: IPusherClient,
        @inject(TYPES.RpcClient) rpcClient: IRpcClient
    ) {
        this.superblocksClient = superblocksClient;
        this.pusherClient = pusherClient;
        this.rpcClient = rpcClient;
    }

    public init(options: IProviderOptions)  {
        if (!options.from || !web3Utils.checkAddressChecksum(options.from)) {
            throw Error('The property from: is required to be set and needs to be a valid address');
        } else if (!options.endpoint || options.endpoint === '') {
            throw Error('The property endpoint: is required to be set');
        } else if (!options.networkId || !Number(options.networkId)) {
            throw Error('The property network: is required to be set and needs to be a valid number');
        }

        this.options = options;
        this.pendingTxs = new Map();
    }

    public async sendMessage(payload: IRpcPayload, networkId: string): Promise<any> {
        if (payload.method === 'eth_accounts') {
            return this.getAccounts();
        } else if (payload.method === 'eth_sendTransaction' || payload.method === 'eth_sign') {
            return this.sendRestApiCall(payload, networkId);
         } else {
            // Methods which are not to be intercepted or do not need any account information could be
            // offloaded to Infura, Etherscan, custom Ethereum node or some other public node
            return this.rpcClient.sendRpcJsonCall(this.options.endpoint, payload);
        }
    }

    public send(payload: IRpcPayload): Promise<any> {
        return this.sendMessage(payload, this.options.networkId);
    }

    public sendAsync(payload: IRpcPayload, callback: (error: any, result: any) => void): void {
        this.sendMessage(payload, this.options.networkId)
            .then((result) => {
                const response = payload;
                response.result = result;
                callback(null, response);
            })
            .catch((error) => {
                callback(error, null);
            });
    }

    private getAccounts(): Promise<any> {
        return Promise.resolve([this.options.from]);
    }

    private async sendRestApiCall(payload: IRpcPayload, networkId: string): Promise<any> {
        const spinner = this.loadingLog('[Superblocks - Manual Sign Provider] Sending tx to Superblocks').start();
        return new Promise(async (resolve, rejects) => {
            let transaction: ITransactionModel;
            try {
                transaction = await this.superblocksClient.sendEthTransaction({
                    buildConfigId: this.BUILD_CONFIG_ID,
                    ciJobId: this.CI_JOB_ID,
                    projectId: this.PROJECT_ID,
                    networkId,
                    from: this.options.from,
                    rpcPayload: payload
                });
            } catch (error) {
                spinner.fail('[Superblocks - Manual Sign Provider] Failed to send the tx to Superblocks.');
                console.log('\x1b[31m%s\x1b[0m', 'Error: ', error.message);

                rejects(error.message);
                return;
            }

            spinner.succeed('[Superblocks - Manual Sign Provider] Transaction registered into Superblocks');

            this.pendingTxs.set(transaction.id, transaction);
            spinner.start('[Superblocks - Manual Sign Provider] Waiting for tx to be signed in Superblocks');

            // We can only subscribe to the transaction on this precise moment, as otherwise we won't have the proper JobId mapped
            this.pusherClient.subscribeToChannel(`web3-hub-${transaction.jobId}`, ['update_transaction'], (event) => {
                if (event.eventName === 'update_transaction') {
                    const txUpdated: ITransactionModel = event.message;

                    if (this.pendingTxs.get(txUpdated.id)) {
                        spinner.succeed(`[Superblocks - Manual Sign Provider] Transaction sent. TxHash: ${txUpdated.transactionHash}`);

                        // TODO - Is his actually the right thing to do?
                        // Unsubscribe immediately after receiving the receipt txHash
                        this.pusherClient.unsubscribeFromChannel(`web3-hub-${transaction.jobId}`);

                        this.pendingTxs.delete(txUpdated.id);

                        // TODO - Proper error handling here
                        resolve(txUpdated.transactionHash);
                    }
                }
            });
        });
    }

    private loadingLog(text: string): ora.Ora {
        console.log('\n');
        return ora({
            text,
            color: 'cyan',
        });
    }
}
