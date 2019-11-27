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

import fetch from 'node-fetch';
import { connectToPusher, subscribeToChannel, unsubscribeFromChannel } from './pusher/pusher.client';
import { superblocksClient } from './superblocks/superblocks.client';
import { ITransactionModel } from './superblocks/models';

interface IProviderOptions {
    from: string;
    endpoint: string;
    networkId: string;
}

interface IMessage {
    id: string;
    payload: {
        err: any;
        res: any;
    };
}

interface IRPCPayload {
    jsonrpc: string;
    id: number;
    method: string;
    params: [any];
}

export default class SuperblocksProvider {

    // Pre-defined variable setup by the Superblocks CI when executing the job including the deployment process
    private readonly PROJECT_ID: string = process.env.SUPER_PROJECT_ID;
    private readonly BUILD_CONFIG_ID: string = process.env.SUPER_BUILD_CONFIG_ID;
    private readonly CI_JOB_ID: string = process.env.CI_JOB_ID;

    private options: IProviderOptions;
    private pending: any = {};

    constructor(options: IProviderOptions) {
        this.options = options;

        this.init();
    }

    public handleMessage(msg: IMessage) {
        if (this.pending[msg.id]) {
            const cb = this.pending[msg.id];
            delete this.pending[msg.id];

            if (msg.payload.err) {
                this.log(`error occurred: ${msg.payload.err}`);
            }
            cb(msg.payload.err, msg.payload.res);
        }
    }

    public async sendMessage(payload: IRPCPayload, networkId: string, callback: any) {
        if (payload.method === 'eth_accounts') {
            callback(null, {
                jsonrpc: payload.jsonrpc,
                id: payload.id,
                result: this.accounts
            });
        } else if (payload.method === 'eth_sendTransaction' || payload.method === 'eth_sign') {
            const transaction = await superblocksClient.sendEthTransaction({
                buildConfigId: this.BUILD_CONFIG_ID,
                ciJobId: this.CI_JOB_ID,
                projectId: this.PROJECT_ID,
                networkId,
                from: this.options.from,
                rpcPayload: payload
            });

            // We can only subscribe to the transaction on this precise moment, as otherwise we won't have the proper JobId mapped
            subscribeToChannel(`web3-hub-${transaction.jobId}`, ['update_transaction'], (event) => {
                if (event.eventName === 'update_transaction') {
                    const txUpdated: ITransactionModel = event.message;

                    // Unsubscribe immediately after receiving the receipt txHash
                    unsubscribeFromChannel(`web3-hub-${transaction.jobId}`);

                    // TODO - Proper error handling here
                    callback(null, {
                        jsonrpc: payload.jsonrpc,
                        id: payload.id,
                        result: txUpdated.transactionHash
                    });
                }
            });
         } else {
            // Methods which are not to be intercepted or do not need any account information could be
            // offloaded to Infura, Etherscan, custom Ethereum node or some other public node
            try {
                const response = await fetch(this.options.endpoint, {
                    body: JSON.stringify(payload),
                    headers: {
                        'content-type': 'application/json',
                    },
                    method: 'POST'
                });

                const data = await response.json();
                callback(null, data);
            } catch (error) {
                callback(error, null);
            }
        }
    }

    public prepareRequest(_async: any) {
        throw new Error('Not implemented.');
    }

    public send(payload: IRPCPayload, callback: any) {
        this.sendAsync(payload, callback);
    }

    public sendAsync(payload: any, callback: any) {
        this.sendMessage(payload, this.options.networkId, callback);
    }

    public getAddress(index: number) {
        return this.accounts[index];
    }

    get accounts() {
        return [this.options.from];
    }

    private init() {
        connectToPusher();
    }

    private log(msg: any) {
        console.log('[SuperblocksProvider] ' + (msg !== null ? msg : '') );
    }
}
