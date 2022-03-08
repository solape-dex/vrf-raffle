# Solape On-chain Raffles

This is an open-source raffle program created with love from TheOnlyCaky. It uses switchbaord's VRF to get unique random varables. There is a master raffle that serves to index all active raffles from that owner as well as keep the RNG (VRF) account data. All child raffles of the master can be configured to have multiple payment options and multiple single or basket rewards. For each raffle, a 'holder' can buy up to max_tickets_per_holder (up to 255). The more ticket's a owner has, the better their odds. The owner of the raffle cannot buy tickets.

Once the owner starts the raffle, it cannot be stopped, only after end data can winners be picked and can redeem their rewards. To make sure the raffle is fair, RNG needs to be requested after a raffle has ended. After this anyone can call the pick winner function (because it uses the RNG requested). This needs to be repeated for each reward in the raffle. Once a winner is picked, their winning ticket is also removed. If there are no more tickets, the raffle owner becomes the winner. After all rewards have winners, they will have 6 months to redeem their reward, if they don't, the raffle owner will be able to redeem it (safegaurd).

After the raffle has eneded, the owner can cash out from the raffle for each payment option.

Although this program has been tested, it has not been audited.

## Prerequisites
You'll need the following to build a raffle:
1. anchor
2. ts-node
3. docker
4. solana-cli

## Configuration

There are some really nice ts helper functions in ts/solapeRaffle.ts. For an example raffle workflow follow tests/test.ts.

The order of operations to getting a raffle going are as follows:

*Important Note* - Requesting RNG from switchbaord requires 0.1 wSOL each time. For this reason, each Request has 8 uses to pick winners from. To get wrapped sol call in terminal `spl-token wrap 1` if it says "account already created \[ACCOUNT\]" call this: `spl-token unwrap [ACCOUNT]` and then call `spl-token wrap 1`.

1. Create a master raffle (Keep this Publickey) `createMasterRaffle(...)`
2. Verify with Docker that you can successfully request RNG `getDockerCall(...)` (Run the resulting command in a terminal in this directory) -> `requestRNG(...)` -> `getVRFStatus(...)` (Call until Callback Complete) - We do this because the VRF account creation can sometimes fail to work.
3. Create a raffle `createRaffleFromFile(...)`
4. Start the raffle `startRaffle(...)`
5. Buy tickets... `buyTickets(...)`
6. ...Wait for Raffle to end...
7. Request RNG (If multiple raffles are ending soon, call this after all have ended) `requestRNG(...)` -> `getVRFStatus(...)`
8. Call `pickWinner(...)` raffle.rewards.length times
9. Winners can now redeem their rewards with `redeemReward(...)` (They have 6mo to do so before the raffle's owner can)
10. Raffle owner can now cash out of the payment options `cashOutOwner(...)` - this only needs to be called once per mint
11. Opionally, the owner can call `removeRaffleFromMaster(...)` when all of the rewards have been redeemed and payment options have been cleared out to clear out room in the Master Raffle account

## Running in DEVNET

In the terminal in this project's directory:

0. Change the `wallet = "/Users/drkrueger/.config/solana/id.json"` to your keypair in Anchor.toml
1. `anchor build`
2. `solana address target/deploy/raffle-keypair.json`
3. Take the resulting address and paste it into the following locations: 
   1. Anchor.toml > `raffle = "address"`
   2. ts/solapeRaffle.ts > `RAFFLE_ID = new anchor.web3.PublicKey("address");`
   3. program/raffle/src/lib.rs > `declare_id!("address");`
4. `anchor build`
5. `anchor deploy`
6. `anchor idl init --filepath target/idl/raffle.json "addressFromAbove"`
7. `ts-node tests/test.ts`

## Pushing to MAINNET-BETA

In the terminal in this project's directory:

You may want to give it another keypair before mainnet, to do this run `solana-keygen new -o target/deploy/raffle-keypair.json`, then follow all of the steps in 'Running in DEVNET'

1. Change Anchor.toml
   1. `[programs.devnet]` > `[programs.mainnet-beta]`
   2. `cluster = "devnet"` > `cluster = "mainnet-beta"`
2. Change ts/solapeRaffle.ts
   1. `SWITCHBOARD_ID = SBV2_DEVNET_PID;` > `SWITCHBOARD_ID = SBV2_MAINNET_PID;`
   2. In `getDockerCall` make sure to change the `RPC_URL=https://api.devnet.solana.com` to mainnet
3. Change the `wallet = "/Users/drkrueger/.config/solana/id.json"` to your keypair in Anchor.toml
4. `anchor build`
5. `solana address target/deploy/raffle-keypair.json`
6. Take the resulting address and paste it into the following locations: 
   1. Anchor.toml > `raffle = "address"`
   2. ts/solapeRaffle.ts > `RAFFLE_ID = new anchor.web3.PublicKey("address");`
   3. program/raffle/src/lib.rs > `declare_id!("address");`
7. `anchor build`
8. `anchor deploy` - If this fails, get your sol back and then add more



