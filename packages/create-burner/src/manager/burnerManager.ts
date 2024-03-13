import {
    Account,
    AccountInterface,
    CallData,
    ec,
    hash,
    RpcProvider,
    shortString,
    stark,
} from "starknet";
import { Burner, BurnerManagerOptions, BurnerStorage } from "../types";
import Storage from "../utils/storage";
import { prefundAccount } from "./prefundAccount";

/**
 * A class to manage Burner accounts.
 * This class exposes methods and properties to manage Burner accounts.
 * This class uses LocalStorage to store the Burner accounts.
 * You can use this class to build your own Burner Wallet in any js framework.
 *
 * @example
 *
 * ```ts
 * export const createBurner = async () => {
 *     const rpcProvider = new RpcProvider({
 *          nodeUrl: import.meta.env.VITE_PUBLIC_NODE_URL!,
 *    });
 *
 *  const masterAccount = new Account(
 *      rpcProvider,
 *      import.meta.env.VITE_PUBLIC_MASTER_ADDRESS!,
 *      import.meta.env.VITE_PUBLIC_MASTER_PRIVATE_KEY!,
 *      "1"
 *   );
 *
 *   const burnerManager = new BurnerManager({
 *      masterAccount,
 *      accountClassHash: import.meta.env.VITE_PUBLIC_ACCOUNT_CLASS_HASH!,
 *      rpcProvider,
 *   });
 *
 *  try {
 *   await burnerManager.create();
 *   } catch (e) {
 *    console.log(e);
 *   }
 *
 *  await burnerManager.init();
 *
 *  return {
 *      account: burnerManager.account as Account,
 *      burnerManager,
 *   };
 * };
 *
 *
 */

export class BurnerManager {
    public masterAccount: AccountInterface;
    public accountClassHash: string;
    public provider: RpcProvider;
    public chainId: string = "";

    public account: Account | null = null;
    public isDeploying: boolean = false;

    private setIsDeploying?: (isDeploying: boolean) => void;

    constructor({
        masterAccount,
        accountClassHash,
        rpcProvider,
    }: BurnerManagerOptions) {
        this.masterAccount = masterAccount;
        this.accountClassHash = accountClassHash;
        this.provider = rpcProvider;

        const initChainId = async () => {
            this.chainId = shortString.decodeShortString(
                (await this.provider.getChainId()) as string
            );
        };
        initChainId();
    }

    public setIsDeployingCallback(
        callback: (isDeploying: boolean) => void
    ): void {
        this.setIsDeploying = callback;
    }

    private updateIsDeploying(status: boolean) {
        this.isDeploying = status;
        if (this.setIsDeploying) {
            this.setIsDeploying(status);
        }
    }

    private getBurnerStorage(): BurnerStorage {
        return Storage.get("burners") || {};
    }

    private setActiveBurnerAccount(storage: BurnerStorage): void {
        for (let address in storage) {
            if (storage[address].active) {
                this.account = new Account(
                    this.provider,
                    address,
                    storage[address].privateKey,
                    "1"
                );
                return;
            }
        }
    }

    private async isBurnerDeployed(deployTx: string): Promise<boolean> {
        try {
            const receipt =
                await this.masterAccount.getTransactionReceipt(deployTx);
            return receipt !== null;
        } catch (error) {
            return false;
        }
    }

    public async init(): Promise<void> {
        const storage = this.getBurnerStorage();
        const addresses = Object.keys(storage);

        const checks = addresses.map(async (address) => {
            const isDeployed = await this.isBurnerDeployed(
                storage[address].deployTx
            );
            return isDeployed ? null : address;
        });

        const toRemove = (await Promise.all(checks)).filter(
            (address): address is string => address !== null
        );

        toRemove.forEach((address) => {
            console.log(`Removing non-deployed burner at address ${address}.`);
            delete storage[address];
        });

        if (Object.keys(storage).length) {
            Storage.set("burners", storage);
            this.setActiveBurnerAccount(storage); // Re-select the active burner account
        } else {
            Storage.clear();
        }
    }

    public list(): Burner[] {
        const storage = this.getBurnerStorage();
        return Object.keys(storage).map((address) => {
            return {
                address,
                active: storage[address].active,
            };
        });
    }

    public select(address: string): void {
        const storage = this.getBurnerStorage();
        if (!storage[address]) {
            throw new Error("burner not found");
        }

        for (let addr in storage) {
            storage[addr].active = false;
        }
        storage[address].active = true;

        Storage.set("burners", storage);
        this.account = new Account(
            this.provider,
            address,
            storage[address].privateKey,
            "1"
        );
    }

    public get(address: string): Account {
        const storage = this.getBurnerStorage();
        if (!storage[address]) {
            throw new Error("burner not found");
        }

        return new Account(
            this.provider,
            address,
            storage[address].privateKey,
            "1"
        );
    }

    clear(): void {
        Storage.clear();
    }

    getActiveAccount(): Account | null {
        const storage = this.getBurnerStorage();
        for (let address in storage) {
            if (storage[address].active) {
                return new Account(
                    this.provider,
                    address,
                    storage[address].privateKey,
                    "1"
                );
            }
        }
        return null;
    }

    public async create(): Promise<Account> {
        this.updateIsDeploying(true);

        const privateKey = stark.randomAddress();
        const publicKey = ec.starkCurve.getStarkKey(privateKey);
        const address = hash.calculateContractAddressFromHash(
            publicKey,
            this.accountClassHash,
            CallData.compile({ publicKey }),
            0
        );

        if (!this.masterAccount) {
            throw new Error("wallet account not found");
        }
        try {
            await prefundAccount(address, this.masterAccount);
        } catch (e) {
            this.isDeploying = false;
        }

        const accountOptions = {
            classHash: this.accountClassHash,
            constructorCalldata: CallData.compile({ publicKey }),
            addressSalt: publicKey,
        };

        // deploy burner
        const burner = new Account(this.provider, address, privateKey, "1");

        const nonce = await this.account?.getNonce();

        const { transaction_hash: deployTx } = await burner.deployAccount(
            accountOptions,
            {
                nonce,
                maxFee: 0, // TODO: update
            }
        );

        const storage = this.getBurnerStorage();
        for (let address in storage) {
            storage[address].active = false;
        }

        storage[address] = {
            chainId: this.chainId,
            privateKey,
            publicKey,
            deployTx,
            active: true,
        };

        this.account = burner;
        this.updateIsDeploying(false);
        Storage.set("burners", storage);

        return burner;
    }

    public async copyBurnersToClipboard(): Promise<void> {
        const burners = this.getBurnerStorage();
        try {
            await navigator.clipboard.writeText(JSON.stringify(burners));
        } catch (error) {
            throw error;
        }
    }

    public async setBurnersFromClipboard(): Promise<void> {
        try {
            const text = await navigator.clipboard.readText();
            const burners: BurnerStorage = JSON.parse(text);

            // Assume no burner is active
            let activeAddress: string | null = null;

            // Iterate over the pasted burners to find the active one
            for (const [address, burner] of Object.entries(burners)) {
                if (burner.active) {
                    activeAddress = address;
                    break;
                }
            }

            Storage.set("burners", burners);

            // If there's an active burner, select it
            if (activeAddress) {
                this.select(activeAddress);
            }
        } catch (error) {
            throw error;
        }
    }
}
