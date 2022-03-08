import * as spl from "@solana/spl-token";
import * as anchor from '@project-serum/anchor';
import { web3, BN } from "@project-serum/anchor";
import {
    Callback,
    OracleQueueAccount,
    PermissionAccount,
    VrfAccount,
    SBV2_DEVNET_PID,
    SBV2_MAINNET_PID,
    ProgramStateAccount,
    OracleAccount,
    SwitchboardPermission,
} from "@switchboard-xyz/switchboard-v2";

// --------- DEFINES -----------------------------------------
export const RAFFLE_ID = new anchor.web3.PublicKey("4iMPsUWtpnNQhjhs1gSw74j5arJpxXa6DrUWYKXsgWVn");
export const SWITCHBOARD_ID = SBV2_DEVNET_PID;

export const MASTER_RAFFLE_ACCOUNT_BASE_SIZE = (
    8 + 64 + (32 * 5) + 2 + 4
)
export interface MasterRaffleAccount {
    name: string,
    masterRaffle: anchor.web3.PublicKey,
    owner: anchor.web3.PublicKey,
    maxRaffles: number,
    oracle: anchor.web3.PublicKey,
    vrfAccount: anchor.web3.PublicKey,
    rngBot: anchor.web3.PublicKey,
    raffles: anchor.web3.PublicKey[],
}

export const RAFFLE_PAYMENT_OPTION_SIZE = (
    64 + (32 * 1) + 8 + 1 + 8 + 1
)
export interface RafflePaymentOption {
    name: string,
    paymentMint: anchor.web3.PublicKey,
    paymentAmount: anchor.BN,
    ticketsPerPayment: number,
    paymentTally?: anchor.BN,
    cashedOut?: boolean,
}

export const RAFFLE_REWARD_SIZE = (
    64 + (32 * 3) + 8 + 1
)
export interface RaffleReward {
    name: string,
    rewardMint: anchor.web3.PublicKey,
    groupId: anchor.web3.PublicKey,
    rewardAmount: anchor.BN,
    winner?: anchor.web3.PublicKey,
    rewardRedeemed?: boolean,
}

export const RAFFLE_TICKET_HOLDER_SIZE = (
    (32 * 1) + 1
)
export interface TicketHolder {
    holder: anchor.web3.PublicKey,
    tickets: number
}

export const RAFFLE_ACCOUNT_BASE_SIZE = (
    8 + 64 + (32 * 5) + (1 * 4) + (2 * 1) + (2 * 8) + (4 * 3)
)
export interface RaffleAccount {
    name: string,
    masterRaffle: anchor.web3.PublicKey,
    raffle: anchor.web3.PublicKey,
    owner: anchor.web3.PublicKey,
    gatekeeper: anchor.web3.PublicKey,
    nonce: number,
    maxTicketsPerHolder: number,
    paymentOptionCount: number,
    rewardCount: number,
    maxHolderCount: number,
    startDate: anchor.BN,
    endDate: anchor.BN,
    paymentOptions: RafflePaymentOption[],
    rewards: RaffleReward[],
    holders: TicketHolder[],
    rngBot: anchor.web3.PublicKey,
}



// --------- FUNCTIONS -----------------------------------------
export class RaffleProvider {
    provider: anchor.Provider;
    raffleProgram: anchor.Program<anchor.Idl>;
    switchboardProgram: anchor.Program<anchor.Idl>;

    // Call create
    private constructor(
        provider: anchor.Provider,
        raffleProgram: anchor.Program<anchor.Idl>,
        switchboardProgram: anchor.Program<anchor.Idl>,
    ) {
        this.provider = provider;
        this.raffleProgram = raffleProgram;
        this.switchboardProgram = switchboardProgram;
    }

    static create = async (provider: anchor.Provider) => {
        return new RaffleProvider(
            provider,
            await RaffleProvider._getRaffleProgram(provider),
            await RaffleProvider._getSwitchboardProgram(provider),
        );
    }

    static _getRaffleProgram = (provider: anchor.Provider) => { return _getProgram(provider, RAFFLE_ID); }
    static _getSwitchboardProgram = (provider: anchor.Provider) => { return _getProgram(provider, SWITCHBOARD_ID); }
       
    async getMasterRaffleAccount(
        masterRaffleKey: anchor.web3.PublicKey | MasterRaffleAccount,
        shouldUpdate?: boolean,
    ) { 
        if((masterRaffleKey as MasterRaffleAccount).name){
            if( shouldUpdate ){
                return (await this.raffleProgram.account.masterRaffle.fetch((masterRaffleKey as MasterRaffleAccount).masterRaffle)) as MasterRaffleAccount; 
            } else {
                return await masterRaffleKey as MasterRaffleAccount;
            }
        }
        return (await this.raffleProgram.account.masterRaffle.fetch(masterRaffleKey as anchor.web3.PublicKey)) as MasterRaffleAccount; 
    }

    async getRaffleAccount(
        raffleKey: anchor.web3.PublicKey | RaffleAccount,
        shouldUpdate?: boolean,
    ) { 
        if((raffleKey as RaffleAccount).name){
            if( shouldUpdate ){
                return (await this.raffleProgram.account.raffle.fetch((raffleKey as RaffleAccount).raffle)) as RaffleAccount; 
            } else {
                return await raffleKey as RaffleAccount;
            }
        }
        return (await this.raffleProgram.account.raffle.fetch(raffleKey as anchor.web3.PublicKey)) as RaffleAccount; 
    }
}

export interface RNGAccounts {
    oracle: anchor.web3.PublicKey,
    vrf: anchor.web3.PublicKey,
    bot: anchor.web3.PublicKey,
    botBump: number,
}
export const createRNGAccounts = async (
    raffleProvider: RaffleProvider,
    masterRafflekey: anchor.web3.PublicKey,
    vrfKeypair?: anchor.web3.Keypair,
) => {
    const raffleProgram = raffleProvider.raffleProgram;
    const switchboardProgram = raffleProvider.switchboardProgram;
    const vrf = vrfKeypair ?? anchor.web3.Keypair.generate();   
    const owner = raffleProvider.provider.wallet;
    
    // RNG Bot
    const [bot, botBump] =
    anchor.utils.publicKey.findProgramAddressSync(
        [
            Buffer.from("SOLAPE"), 
            masterRafflekey.toBytes(), 
            owner.publicKey.toBytes()
        ],
        raffleProgram.programId,
    );

    // Oracle Queue
    const queue = await OracleQueueAccount.create(
        switchboardProgram as any, 
        {
            name: Buffer.from("Queue-1"),
            slashingEnabled: false,
            reward: new anchor.BN(0), // no token account needed
            minStake: new anchor.BN(0),
            authority: owner.publicKey,
            queueSize: 50,
        }
    );

    // Oracle
    const oracle = await OracleAccount.create(
        switchboardProgram as any, 
        {
            name: Buffer.from("Oracle"),
            queueAccount: queue,
        }
    );

    // Oracle Permissions
    const oraclePermission = await PermissionAccount.create(
        switchboardProgram as any, 
        {
            authority: owner.publicKey,
            granter: queue.publicKey,
            grantee: oracle.publicKey,
        }
    );

    // Set Permissions
    const heartbeatPermission = new Map();
    heartbeatPermission.set(SwitchboardPermission.PERMIT_ORACLE_HEARTBEAT, null);
    await oraclePermission.program.rpc.permissionSet({
        permission: Object.fromEntries(heartbeatPermission),
        enable: true,
    }, {
        accounts: {
            permission: oraclePermission.publicKey,
            authority: owner.publicKey,
        },
        signers: [],
    });

    // Tick
    await oracle.heartbeat();

    // Set Callback
    const ixCoder = new anchor.InstructionCoder(raffleProgram.idl);
    const callback: Callback = {
        programId: raffleProgram.programId,
        accounts: [
            { pubkey: bot, isSigner: false, isWritable: true },
            { pubkey: vrf.publicKey, isSigner: false, isWritable: false }, 
            // { pubkey: provider.wallet.publicKey, isSigner: false, isWritable: false }, 
        ],
        ixData: ixCoder.encode("rngCallback", "")
    }

    // VRF account
    const vrfAccount = await VrfAccount.create(
        switchboardProgram as any, 
        {
            queue,
            callback,
            authority: owner.publicKey,
            keypair: vrf,
        }
    );

    // VRF Permissions
    const { unpermissionedVrfEnabled, authority } = await queue.loadData();
    const vrfPermission = await PermissionAccount.create(
        switchboardProgram as any, 
        {
            authority: authority,
            granter: queue.publicKey,
            grantee: vrfAccount.publicKey,
        }
    );

    // Setting Permissions
    if (!unpermissionedVrfEnabled) {
        if (!raffleProvider.provider.wallet.publicKey.equals(authority)) {
            throw new Error(
            `queue requires PERMIT_VRF_REQUESTS and wrong queue authority provided`
            );
        }
        const vrfRequestPermissions = new Map();
        vrfRequestPermissions.set(SwitchboardPermission.PERMIT_VRF_REQUESTS, null);
        await vrfPermission.program.rpc.permissionSet({
            permission: Object.fromEntries(vrfRequestPermissions),
            enable: true,
        }, {
            accounts: {
                permission: vrfPermission.publicKey,
                authority: owner.publicKey,
            },
            signers: [],
        });
    }


    const accounts: RNGAccounts = {
        oracle: oracle.publicKey,
        vrf: vrf.publicKey,
        bot: bot,
        botBump: botBump
    }
    return accounts;
}


export const createMasterRaffle = async (
    raffleProvider: RaffleProvider, 
    maxRaffles?:number,
    masterRaffleName?: string,
    botName?: string,
    masterRaffleKeypair?: anchor.web3.Keypair,
    rngAccounts?: RNGAccounts,
) => {
    const raffleProgram = raffleProvider.raffleProgram;
    const masterRaffle = masterRaffleKeypair ?? anchor.web3.Keypair.generate();
    const rng = rngAccounts ?? await createRNGAccounts(raffleProvider, masterRaffle.publicKey);
    const owner = raffleProvider.provider.wallet;
    const raffleCount = maxRaffles ?? 512;

    await raffleProgram.rpc.createMasterRaffle(
        {
            name: masterRaffleName ?? "SOLAPE Master Raffle",
            maxRaffles: raffleCount,
            botBump: rng.botBump,
            botName: botName ?? "SOLAPE RNG bot",
        },
        {
            accounts: {
                masterRaffle: masterRaffle.publicKey,
                oracle: rng.oracle,
                vrfAccount: rng.vrf,
                rngBot: rng.bot,
                owner: owner.publicKey,
                systemProgram: anchor.web3.SystemProgram.programId,
            },
            signers: [masterRaffle],
            instructions: [
                await raffleProgram.account.masterRaffle.createInstruction(masterRaffle, _masterRaffleAccountSize(raffleCount)),
            ],
        }
    );

    return await raffleProvider.getMasterRaffleAccount(masterRaffle.publicKey, true);
}

export const createPaymentOption = (
    name: string,
    paymentMint: anchor.web3.PublicKey,
    paymentAmount: anchor.BN,
    ticketsPerPayment: number,
) => {
    const option: RafflePaymentOption = {
        name: name,
        paymentMint: paymentMint,
        paymentAmount: paymentAmount,
        ticketsPerPayment: ticketsPerPayment
    };
    return option;
}

export const createReward = (
    name: string,
    rewardMint: anchor.web3.PublicKey,
    rewardAmount: anchor.BN,
    groupId?: anchor.web3.PublicKey,
) => {
    const reward: RaffleReward = {
        name: name,
        rewardMint: rewardMint,
        rewardAmount: rewardAmount,
        groupId: groupId ?? anchor.web3.Keypair.generate().publicKey,
    };
    return reward;
}

export const createBasketReward = (
    name: string,
    rewardMint: anchor.web3.PublicKey[],
    rewardAmount: anchor.BN[],
    rewardsToGroup?: RaffleReward[],
    groupId?: anchor.web3.PublicKey,
) => {
    let rewards = [] as RaffleReward[];
    const id = groupId ?? anchor.web3.Keypair.generate().publicKey;

    if( rewardsToGroup ) {
        for(var i = 0; i < rewardsToGroup.length; i++){
            rewards.push({
                name: rewardsToGroup[i].name,
                rewardMint: rewardsToGroup[i].rewardMint,
                rewardAmount: rewardsToGroup[i].rewardAmount,
                groupId: id,
            });
        }
    } else {
        if( rewardMint.length !== rewardAmount.length ) {
            throw new Error(
                "Mints and amounts have to match."
            );
        }

        for(var i = 0; i < rewardAmount.length; i++){
            rewards.push({
                name: name,
                rewardMint: rewardMint[i],
                rewardAmount: rewardAmount[i],
                groupId: id,
            });
        }
    }

    return rewards;
}

export const createRaffleAccount = async (
    raffleProvider: RaffleProvider, 
    masterRaffleAccount: anchor.web3.PublicKey | MasterRaffleAccount,
    paymentOptions: RafflePaymentOption[],
    rewards: RaffleReward[],
    raffleName?: string,
    maxHolderCount?: number,
    maxTicketsPerHolder?: number,
    raffleKeypair?: anchor.web3.Keypair,
) => {
    const raffleProgram = raffleProvider.raffleProgram;
    const raffle = raffleKeypair ?? anchor.web3.Keypair.generate();
    const masterRaffle = await raffleProvider.getMasterRaffleAccount(masterRaffleAccount);
    const owner = raffleProvider.provider.wallet;
    const maxHolders = maxHolderCount ?? 1000;

    const [gatekeeper, nonce] = await anchor.web3.PublicKey.findProgramAddress(
        [raffle.publicKey.toBuffer()],
        raffleProgram.programId,
    );

    await raffleProgram.rpc.createRaffle(
        {
            nonce: nonce,
            name: raffleName ?? "SOLAPE Raffle",
            maxTicketsPerHolder: maxTicketsPerHolder ?? 0xFF,
            paymentOptionCount: paymentOptions.length,
            rewardCount: rewards.length,
            maxHolderCount: maxHolders,
        },
        {
            accounts: {
                raffle: raffle.publicKey,
                gatekeeper: gatekeeper,
                masterRaffle: masterRaffle.masterRaffle,
                rngBot: masterRaffle.rngBot,
                owner: owner.publicKey,
                systemProgram: anchor.web3.SystemProgram.programId,
            },
            signers: [raffle],
            instructions: [
                await raffleProgram.account.raffle.createInstruction(
                    raffle, 
                    _raffleAccountSize(
                        paymentOptions.length,
                        rewards.length,
                        maxHolders,
                    )
                ),
            ],
        }
    );

    return await raffleProvider.getRaffleAccount(raffle.publicKey, true);
}

export const loadPaymentOption = async (
    raffleProvider: RaffleProvider, 
    raffleAccount: anchor.web3.PublicKey | RaffleAccount,
    paymentOption: RafflePaymentOption,
) => {
    const raffleProgram = raffleProvider.raffleProgram;
    const raffle = await raffleProvider.getRaffleAccount(raffleAccount);

    const {vault, shouldCreate} = await _getAssociatedTokenAddressAndShouldCreate(
        raffleProvider.provider,
        paymentOption.paymentMint,
        raffle.gatekeeper,
        true,
    )

    await raffleProgram.rpc.loadPaymentOption(
        {
            name: paymentOption.name,
            paymentAmount: paymentOption.paymentAmount,
            ticketsPerPayment: paymentOption.ticketsPerPayment,
        },
        {
            accounts: {
                raffle: raffle.raffle,
                gatekeeper: raffle.gatekeeper,
                paymentVault: vault,
                owner: raffle.owner,
                tokenProgram: spl.TOKEN_PROGRAM_ID,
            },
            signers: [],
            instructions: [
                ..._getCreateAssociatedTokenAddressInstructions(
                    paymentOption.paymentMint,
                    vault,
                    raffle.gatekeeper,
                    raffle.owner,
                    shouldCreate,
                )
            ],
        }
    );

    return await raffleProvider.getRaffleAccount(raffle, true);
}

export const loadReward = async (
    raffleProvider: RaffleProvider, 
    raffleAccount: anchor.web3.PublicKey | RaffleAccount,
    reward: RaffleReward,
) => {
    const raffleProgram = raffleProvider.raffleProgram;
    const raffle = await raffleProvider.getRaffleAccount(raffleAccount);

    const {vault, shouldCreate} = await _getAssociatedTokenAddressAndShouldCreate(
        raffleProvider.provider,
        reward.rewardMint,
        raffle.gatekeeper,
        true,
    )

    const ownerVault = await _getAssociatedTokenAddress(
        reward.rewardMint,
        raffle.owner,
    );

    await raffleProgram.rpc.loadReward(
        {
            name: reward.name,
            groupId: reward.groupId,
            rewardAmount: reward.rewardAmount,
        },
        {
            accounts: {
                raffle: raffle.raffle,
                gatekeeper: raffle.gatekeeper,
                rewardVault: vault,
                ownerVault: ownerVault,
                owner: raffle.owner,
                tokenProgram: spl.TOKEN_PROGRAM_ID,
            },
            signers: [],
            instructions: [
                ..._getCreateAssociatedTokenAddressInstructions(
                    reward.rewardMint,
                    vault,
                    raffle.gatekeeper,
                    raffle.owner,
                    shouldCreate,
                )
            ],
        }
    );

    return await raffleProvider.getRaffleAccount(raffle, true);
}

export interface RaffleFile {
    raffleName: string,
    maxTicketsPerHolder: number,
    maxHolderCount: number,
    paymentOptions: RafflePaymentOption[],
    rewards: RaffleReward[],
}
export const createRaffleFromFile = async (
    raffleProvider: RaffleProvider, 
    masterRaffleAccount: anchor.web3.PublicKey | MasterRaffleAccount,
    file: RaffleFile,
    raffleKeypair?: anchor.web3.Keypair,
) => {
    const masterRaffle = await raffleProvider.getMasterRaffleAccount(masterRaffleAccount);

    let raffle = await createRaffleAccount(
        raffleProvider,
        masterRaffle,
        file.paymentOptions,
        file.rewards,
        file.raffleName,
        file.maxHolderCount,
        file.maxTicketsPerHolder,
        raffleKeypair,
    );

    for(var i = 0; i < file.paymentOptions.length; i++){
        raffle = await loadPaymentOption(
            raffleProvider,
            raffle,
            file.paymentOptions[i],
        );
    }

    for(var i = 0; i < file.rewards.length; i++){
        raffle = await loadReward(
            raffleProvider,
            raffle,
            file.rewards[i],
        );
    }

    return await raffleProvider.getRaffleAccount(raffle);
}

export const startRaffle = async (
    raffleProvider: RaffleProvider, 
    raffleAccount: anchor.web3.PublicKey | RaffleAccount,
    endDate: Date,
) => {
    const raffleProgram = raffleProvider.raffleProgram;
    const raffle = await raffleProvider.getRaffleAccount(raffleAccount);
    const date = _dateToSolanaDate(endDate);
    const owner = raffleProvider.provider.wallet;

    await raffleProgram.rpc.startRaffle(
        {
            endDate: date,
        },
        {
            accounts: {
                raffle: raffle.raffle,
                owner: raffle.owner,
            },
            signers: [],
            instructions: [],
        }
    );

    return await raffleProvider.getRaffleAccount(raffle, true);
}


export const requestRNG = async (
    raffleProvider: RaffleProvider, 
    masterRaffleAccount: anchor.web3.PublicKey | MasterRaffleAccount,
) => {
    const raffleProgram = raffleProvider.raffleProgram;
    const switchboardProgram = raffleProvider.switchboardProgram;
    const masterRaffle = await raffleProvider.getMasterRaffleAccount(masterRaffleAccount);

    const [programStateAccount] = ProgramStateAccount.fromSeed(switchboardProgram as any);
    const switchTokenMint = await programStateAccount.getTokenMint();
    const {vault, shouldCreate} = await _getAssociatedTokenAddressAndShouldCreate(
        raffleProvider.provider,
        switchTokenMint.publicKey,
        masterRaffle.owner,
    )

    const balance = await raffleProvider.provider.connection.getTokenAccountBalance(vault);
    if (!balance.value.uiAmount || balance.value.uiAmount < 0.1 || shouldCreate) {
        throw new Error(
           "Onwer needs at least 0.1 wSol: to do this call 'spl-token wrap 1' If there is an error, call spl-token unwrap [Account] and try again"
        );
    }

    const { vrfAccount, vrfData } = await getVRFAccount(
        raffleProvider,
        masterRaffle,
    )

    const queueAccount = new OracleQueueAccount({
        program: vrfAccount.program,
        publicKey: vrfData.oracleQueue,
    });

    const queue = await queueAccount.loadData();
    const queueAuthority = queue.authority;
    const dataBuffer = queue.dataBuffer;
    const escrow = vrfData.escrow;
    const [stateAccount, stateBump] = ProgramStateAccount.fromSeed(vrfAccount.program,);
    const [permissionAccount, permissionBump] = PermissionAccount.fromSeed(vrfAccount.program, queueAuthority, queueAccount.publicKey, vrfAccount.publicKey);
    try {
        await permissionAccount.loadData();
    }
    catch (_) {
        throw new Error("A requested permission pda account has not been initialized.");
    }
    const tokenProgram = spl.TOKEN_PROGRAM_ID;
    const recentBlockhashes = anchor.web3.SYSVAR_RECENT_BLOCKHASHES_PUBKEY;

    await vrfAccount.program.rpc.vrfRequestRandomness({
        stateBump,
        permissionBump,
    }, {
        accounts: {
            authority: masterRaffle.owner,
            vrf: vrfAccount.publicKey,
            oracleQueue: queueAccount.publicKey,
            queueAuthority,
            dataBuffer,
            permission: permissionAccount.publicKey,
            escrow,
            payerWallet: vault,
            payerAuthority: masterRaffle.owner,
            recentBlockhashes,
            programState: stateAccount.publicKey,
            tokenProgram,
        },
        signers: [],
    });

    return await raffleProvider.getMasterRaffleAccount(masterRaffle, true);
}

export const buyTickets = async (
    raffleProvider: RaffleProvider, 
    raffleAccount: anchor.web3.PublicKey | RaffleAccount,
    paymentOptionIndex: number,
) => {
    const raffleProgram = raffleProvider.raffleProgram;
    const raffle = await raffleProvider.getRaffleAccount(raffleAccount);
    const holder = raffleProvider.provider.wallet;

    if(paymentOptionIndex >= raffle.paymentOptions.length){
        throw Error(`Payment option index out of bounds: ${paymentOptionIndex}:${raffle.paymentOptions.length}`);
    }

    let paymentVault = await _getAssociatedTokenAddress(
        raffle.paymentOptions[paymentOptionIndex].paymentMint,
        raffle.gatekeeper,
        true
    )

    let holderVault = await _getAssociatedTokenAddress(
        raffle.paymentOptions[paymentOptionIndex].paymentMint,
        holder.publicKey,
    )

    await raffleProgram.rpc.buyTickets(
        {
            paymentOptionIndex: paymentOptionIndex,
        },
        {
            accounts: {
                raffle: raffle.raffle,
                gatekeeper: raffle.gatekeeper,
                paymentVault: paymentVault,
                holderVault: holderVault,
                holder: holder.publicKey,
                owner: raffle.owner,
                tokenProgram: spl.TOKEN_PROGRAM_ID,
            },
            signers: [],
            instructions: [],
        }
    );

    return await raffleProvider.getRaffleAccount(raffle, true);
}

export const pickWinner = async (
    raffleProvider: RaffleProvider, 
    raffleAccount: anchor.web3.PublicKey | RaffleAccount,
) => {
    const raffleProgram = raffleProvider.raffleProgram;
    const raffle = await raffleProvider.getRaffleAccount(raffleAccount);

    await raffleProgram.rpc.pickWinner(
        {
            accounts: {
                raffle: raffle.raffle,
                rngBot: raffle.rngBot,
                owner: raffle.owner,
            },
            signers: [],
            instructions: [],
        }
    );

    return await raffleProvider.getRaffleAccount(raffle, true);
}

export const cashOutOwner = async (
    raffleProvider: RaffleProvider, 
    raffleAccount: anchor.web3.PublicKey | RaffleAccount,
    paymentOptionIndex: number,
) => {
    const raffleProgram = raffleProvider.raffleProgram;
    const raffle = await raffleProvider.getRaffleAccount(raffleAccount);
    const owner = raffleProvider.provider.wallet;

    if(paymentOptionIndex >= raffle.paymentOptions.length){
        throw Error(`Payment option index out of bounds: ${paymentOptionIndex}:${raffle.paymentOptions.length}`);
    }

    let paymentVault = await _getAssociatedTokenAddress(
        raffle.paymentOptions[paymentOptionIndex].paymentMint,
        raffle.gatekeeper,
        true
    )

    let ownerVault = await _getAssociatedTokenAddress(
        raffle.paymentOptions[paymentOptionIndex].paymentMint,
        owner.publicKey,
    )

    await raffleProgram.rpc.cashOutOwner(
        {
            accounts: {
                raffle: raffle.raffle,
                gatekeeper: raffle.gatekeeper,
                paymentVault: paymentVault,
                ownerVault: ownerVault,
                owner: raffle.owner,
                tokenProgram: spl.TOKEN_PROGRAM_ID,
            },
            signers: [],
            instructions: [],
        }
    );

    return await raffleProvider.getRaffleAccount(raffle, true);
}

export const redeemReward = async (
    raffleProvider: RaffleProvider, 
    raffleAccount: anchor.web3.PublicKey | RaffleAccount,
    rewardIndex: number,
) => {
    const raffleProgram = raffleProvider.raffleProgram;
    const raffle = await raffleProvider.getRaffleAccount(raffleAccount);
    const winner = raffleProvider.provider.wallet;

    if(rewardIndex >= raffle.rewards.length){
        throw Error(`Reward index out of bounds: ${rewardIndex}:${raffle.rewards.length}`);
    }

    let rewardVault = await _getAssociatedTokenAddress(
        raffle.rewards[rewardIndex].rewardMint,
        raffle.gatekeeper,
        true
    )

    let {vault, shouldCreate} = await _getAssociatedTokenAddressAndShouldCreate(
        raffleProvider.provider,
        raffle.rewards[rewardIndex].rewardMint,
        winner.publicKey
    )

    await raffleProgram.rpc.redeemReward(
        {
            accounts: {
                raffle: raffle.raffle,
                gatekeeper: raffle.gatekeeper,
                rewardVault: rewardVault,
                winnerVault: vault,
                winner: winner.publicKey,
                owner: raffle.owner,
                tokenProgram: spl.TOKEN_PROGRAM_ID,
            },
            signers: [],
            instructions: [
                ..._getCreateAssociatedTokenAddressInstructions(
                    raffle.rewards[rewardIndex].rewardMint,
                    vault,
                    winner.publicKey,
                    winner.publicKey,
                    shouldCreate,
                )
            ],
        }
    );

    return await raffleProvider.getRaffleAccount(raffle, true);
}


export const removeRaffleFromMaster = async (
    raffleProvider: RaffleProvider, 
    masterRaffleAccount: anchor.web3.PublicKey | MasterRaffleAccount,
    raffleAccount: anchor.web3.PublicKey | RaffleAccount,
) => {
    const raffleProgram = raffleProvider.raffleProgram;
    const masterRaffle = await raffleProvider.getMasterRaffleAccount(masterRaffleAccount);
    const raffle = await raffleProvider.getRaffleAccount(raffleAccount);

    if (!await getIsRaffleCleared( raffleProvider, raffle)) {
        throw Error("This raffle is not cleared");
    }

    await raffleProgram.rpc.removeRafflesFromMaster(
        {
            rafflesToRemove: [
                raffle.raffle,
            ]
        },
        {
            accounts: {
                masterRaffle: masterRaffle.masterRaffle,
                owner: masterRaffle.owner,
            },
            signers: [],
            instructions: [],
        }
    );

    return await raffleProvider.getMasterRaffleAccount(masterRaffle, true);
}

// Just to be able to update the oracle
export const updateMasterRaffleRNGAccounts = async (
    raffleProvider: RaffleProvider,
    masterRaffleAccount: anchor.web3.PublicKey | MasterRaffleAccount,
    rngAccounts: RNGAccounts,
) => {
    const raffleProgram = raffleProvider.raffleProgram;
    const masterRaffle = await raffleProvider.getMasterRaffleAccount(masterRaffleAccount);

    await raffleProgram.rpc.updateMasterRng(
        {
            accounts: {
                masterRaffle: masterRaffle.masterRaffle,
                rngBot: masterRaffle.rngBot,
                newOracleAccount: rngAccounts.oracle,
                newVrfAccount: rngAccounts.vrf,
                owner: masterRaffle.owner,
            },
            signers: [],
            instructions: [],
        }
    );

    return await raffleProvider.getMasterRaffleAccount(masterRaffle, true);
}

// --------- HELPER FUNCTIONS -----------------------------------------
export const raffleToString = async (
    raffleProvider: RaffleProvider, 
    raffleAccount: anchor.web3.PublicKey | RaffleAccount,
) => {
    const raffle = await raffleProvider.getRaffleAccount(raffleAccount);

    let string = "RAFFLE:\n";

    string += raffle.raffle.toString() + "\n";
    string += "HOLDERS: " + raffle.holders.length + "\n";
    for (var i = 0; i < raffle.holders.length; i++){
        string += "H: " + raffle.holders[i].holder.toString() + ": " + raffle.holders[i].tickets + "\n";  
    }
    string += "PAYMENTS: " + raffle.paymentOptions.length + "\n";
    for (var i = 0; i < raffle.paymentOptions.length; i++){
        string += "P: " + raffle.paymentOptions[i].paymentMint.toString() + ": " + raffle.paymentOptions[i].paymentTally + "\n";  
        string += "C: " + raffle.paymentOptions[i].cashedOut + "\n";  
    }
    string += "REWARDS: " + raffle.rewards.length + "\n";
    for (var i = 0; i < raffle.rewards.length; i++){
        string += "R: " + raffle.rewards[i].rewardMint.toString() + ": " + raffle.rewards[i].rewardAmount + "\n";  
        string += "GI: " + raffle.rewards[i].groupId.toString() + "\n";  
        string += "C: " + raffle.rewards[i].rewardRedeemed + "\n";  
    }

    return (string);
}

export const getHolderChances = async (
    raffleProvider: RaffleProvider, 
    raffleAccount: anchor.web3.PublicKey | RaffleAccount,
) => {
    const raffle = await raffleProvider.getRaffleAccount(raffleAccount);

    return (
        await getHolderTicketCount(raffleProvider, raffle) / 
        await getTotalTicketCount(raffleProvider, raffle)
    );
}

export const getTotalTicketCount = async (
    raffleProvider: RaffleProvider, 
    raffleAccount: anchor.web3.PublicKey | RaffleAccount,
) => {
    const raffle = await raffleProvider.getRaffleAccount(raffleAccount);
    let tickets = 0;

    for( var i = 0; i < raffle.holders.length; i++){
        tickets += raffle.holders[i].tickets;
    }

    return tickets;
}

export const getHolderTicketCount = async (
    raffleProvider: RaffleProvider, 
    raffleAccount: anchor.web3.PublicKey | RaffleAccount,
) => {
    const raffle = await raffleProvider.getRaffleAccount(raffleAccount);

    for( var i = 0; i < raffle.holders.length; i++){
        if( raffle.holders[i].holder.toString() == raffleProvider.provider.wallet.publicKey.toString() ){
            return raffle.holders[i].tickets;
        }
    }

    return 0;
}

export const getIsRaffleCleared = async (
    raffleProvider: RaffleProvider, 
    raffleAccount: anchor.web3.PublicKey | RaffleAccount,
) => {
    const raffle = await raffleProvider.getRaffleAccount(raffleAccount);

    for( var i = 0; i < raffle.rewards.length; i++){
        if( !raffle.rewards[i].rewardRedeemed ){
            return false;
        }
    }

    for( var i = 0; i < raffle.paymentOptions.length; i++){
        if( !raffle.paymentOptions[i].cashedOut ){
            return false;
        }
    }

    return true;
}

export const getDockerCall = async (
    raffleProvider: RaffleProvider, 
    masterRaffleAccount: anchor.web3.PublicKey | MasterRaffleAccount,
) => {    
    const masterRaffle = await raffleProvider.getMasterRaffleAccount(masterRaffleAccount);

    return "Start Oracle:\n\n" + 
        `ORACLE_KEY="${masterRaffle.oracle.toString()}" PAYER_KEYPAIR="~/.config/solana/id.json" RPC_URL=https://api.devnet.solana.com CLUSTER=devnet docker-compose up\n\n`
}

export const getVRFStatus = async (
    raffleProvider: RaffleProvider, 
    masterRaffleAccount: anchor.web3.PublicKey | MasterRaffleAccount,
) => {
    let { vrfAccount, vrfData } = await getVRFAccount(
        raffleProvider,
        masterRaffleAccount
    );

    if( vrfData.status.statusRequesting ){
        return "Requesting..."
    }
    if( vrfData.status.statusVerifying ){
        return "Verifying..."
    }
    if( vrfData.status.statusCallbackSuccess ){
        return "Complete!"
    }
    return "Idle..."
}

export const getVRFAccount = async (
    raffleProvider: RaffleProvider, 
    masterRaffleAccount: anchor.web3.PublicKey | MasterRaffleAccount,
) => {
    const switchboardProgram = raffleProvider.switchboardProgram;
    const masterRaffle = await raffleProvider.getMasterRaffleAccount(masterRaffleAccount);

    const vrfAccount = new VrfAccount({
        program: switchboardProgram as any,
        publicKey: masterRaffle.vrfAccount,
    });

    const vrfData = await vrfAccount.loadData();

    return { vrfAccount, vrfData };
}

const _masterRaffleAccountSize = (maxRaffles: number) => {
    return MASTER_RAFFLE_ACCOUNT_BASE_SIZE + (maxRaffles * 32);
}

const _raffleAccountSize = (
    paymentOptions: number,
    rewards: number,
    maxHolders: number,
) => {
    return RAFFLE_ACCOUNT_BASE_SIZE + 
    (paymentOptions * RAFFLE_PAYMENT_OPTION_SIZE) +
    (rewards * RAFFLE_REWARD_SIZE) +
    (maxHolders * RAFFLE_TICKET_HOLDER_SIZE);
}


const _dateToSolanaDate = (date: Date) => {
    return new anchor.BN(Math.floor(date.getTime() / 1000));
}

const _getProgram = async (provider: anchor.Provider, programID: anchor.web3.PublicKey) => {
    const idl = await anchor.Program.fetchIdl(programID, provider);
    return new anchor.Program<anchor.Idl>(idl as any, programID, provider);
}

const _getSPLAccount = async (provider: anchor.Provider, mint: anchor.web3.PublicKey, vault: anchor.web3.PublicKey) => {
    return new spl.Token(provider.connection, mint, spl.TOKEN_PROGRAM_ID, anchor.web3.Keypair.generate()).getAccountInfo(vault);
}

const _getAssociatedTokenAddress = async (mint: anchor.web3.PublicKey, owner: anchor.web3.PublicKey, allowOffCurve?: boolean) => {
    return spl.Token.getAssociatedTokenAddress(
        spl.ASSOCIATED_TOKEN_PROGRAM_ID,
        spl.TOKEN_PROGRAM_ID,
        mint,
        owner,
        allowOffCurve
    );
}

const _getAssociatedTokenAddressAndShouldCreate = async (provider: anchor.Provider, mint: anchor.web3.PublicKey, owner: anchor.web3.PublicKey, allowOffCurve?: boolean) => {
    let vault = await _getAssociatedTokenAddress( mint, owner, allowOffCurve );
    let shouldCreate = false;
    try {
        await _getSPLAccount(provider, mint, vault);
    } catch (e) {
        shouldCreate = true;
    }

    return {vault, shouldCreate};
}

const _getCreateAssociatedTokenAddressInstructions = (
    mint: anchor.web3.PublicKey,
    vault: anchor.web3.PublicKey,
    owner: anchor.web3.PublicKey,
    payer: anchor.web3.PublicKey,
    shouldCreate?: boolean
) => {
    return (shouldCreate ?? true) ? [
        spl.Token.createAssociatedTokenAccountInstruction(
            spl.ASSOCIATED_TOKEN_PROGRAM_ID,
            spl.TOKEN_PROGRAM_ID,
            mint,
            vault,
            owner,
            payer
        )
    ] : [];
}
