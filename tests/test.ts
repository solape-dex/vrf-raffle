import * as anchor from "@project-serum/anchor";
import * as helpers from "./solHelpers";
import * as Raffle from "../ts/solapeRaffle";
import NodeWallet from "@project-serum/anchor/dist/cjs/nodewallet";
import { getSimpleTerminalResponse } from "@coach-chuck/simple-terminal-response";

const secretArray = require('/Users/drkrueger/.config/solana/id.json');
const secret = new Uint8Array(secretArray);
const payerKeypair = anchor.web3.Keypair.fromSecretKey(secret);

const holderSecretArray = require('./test_payer.json');
const holderSecret = new Uint8Array(holderSecretArray);
const holderKeypair = anchor.web3.Keypair.fromSecretKey(holderSecret);

const holderSecretArray1 = require('./test_payer1.json');
const holderSecret1 = new Uint8Array(holderSecretArray1);
const holderKeypair1 = anchor.web3.Keypair.fromSecretKey(holderSecret1);

const holderSecretArray2 = require('./test_payer2.json');
const holderSecret2 = new Uint8Array(holderSecretArray2);
const holderKeypair2 = anchor.web3.Keypair.fromSecretKey(holderSecret2);

// MAIN
const main = async() => {
  console.log("🚀 Starting test...\n\n");

  console.log("creating owner");
  let ownerWallet = new NodeWallet(payerKeypair);
  const ownerProvider = helpers.getSolanaProvider(ownerWallet);
  const ownerRaffleProvider = await Raffle.RaffleProvider.create(ownerProvider);
  anchor.setProvider(ownerProvider);

  console.log("creating holder 0");
  let holderWallet = new NodeWallet(holderKeypair);
  const holderProvider = helpers.getSolanaProvider(holderWallet);
  const holderRaffleProvider = await Raffle.RaffleProvider.create(holderProvider);

  console.log("creating holder 1");
  let holderWallet1 = new NodeWallet(holderKeypair1);
  const holderProvider1 = helpers.getSolanaProvider(holderWallet1);
  const holderRaffleProvider1 = await Raffle.RaffleProvider.create(holderProvider1);

  console.log("creating holder 2");
  let holderWallet2 = new NodeWallet(holderKeypair2);
  const holderProvider2 = helpers.getSolanaProvider(holderWallet2);
  const holderRaffleProvider2 = await Raffle.RaffleProvider.create(holderProvider2);

  console.log("creating SPLs");
  const testPaymentSPL = await helpers.createSPL(ownerProvider, 10000);
  const testRewardNFTs = [
    await helpers.createSPL(ownerProvider, 1),
    await helpers.createSPL(ownerProvider, 1),
    await helpers.createSPL(ownerProvider, 1),
  ]

  console.log("sending some to test holders");
  await helpers.txSPL(
    ownerProvider,
    testPaymentSPL.mint,
    holderProvider.wallet.publicKey,
    1000,
  );
  await helpers.txSPL(
    ownerProvider,
    testPaymentSPL.mint,
    holderProvider1.wallet.publicKey,
    1000,
  );
  await helpers.txSPL(
    ownerProvider,
    testPaymentSPL.mint,
    holderProvider2.wallet.publicKey,
    1000,
  );

  console.log("creating master raffle");
  const masterRaffle = await Raffle.createMasterRaffle(
    ownerRaffleProvider,
    1000,
    "Test Master Raffle",
    "Test BOT",
  );

  console.log("\n\nKeep the Master Raffle Key: " + masterRaffle.masterRaffle.toString() + "\n");

  console.log(await Raffle.getDockerCall(
    ownerRaffleProvider,
    masterRaffle,
  ));

  await getSimpleTerminalResponse("Do you have Docker running?\n");

  let count = 0;
  while(1) {
    let status = await Raffle.getVRFStatus(
      ownerRaffleProvider,
      masterRaffle,
    );
    console.log(status);

    if(count++ % 100 == 0){
      console.log("Requesting RNG.");
      await Raffle.requestRNG(
        ownerRaffleProvider,
        masterRaffle,
      );
    }

    await new Promise( resolve => setTimeout(resolve, 100) );

    if(status.includes("Complete")) {
      break;
    }
  }

  console.log("creating raffle");
  let raffle = await Raffle.createRaffleFromFile(
    ownerRaffleProvider,
    masterRaffle,
    {
      raffleName: "Test Raffle",
      maxTicketsPerHolder: 100,
      maxHolderCount: 1000,
      paymentOptions: [
        Raffle.createPaymentOption(
          "One Ticket",
          testPaymentSPL.mint,
          new anchor.BN(10), //amount of SPL for purchase
          1 //ticket count
        ),
        Raffle.createPaymentOption(
          "Ten Tickets",
          testPaymentSPL.mint,
          new anchor.BN(90), //amount of SPL for purchase
          10 //ticket count
        ),
      ],
      rewards: [
        Raffle.createReward(
          "Blackcard",
          testRewardNFTs[0].mint,
          new anchor.BN(1),
        ),
        ...Raffle.createBasketReward(
          "NFT Basket",
          [
            testRewardNFTs[1].mint,
            testRewardNFTs[2].mint,
          ],
          [
            new anchor.BN(1),
            new anchor.BN(1),
          ]
        ),
      ]
    }
  )

  while(1) {
    try {
      let answer = await getSimpleTerminalResponse("Test Raffle CLI:\n");
      let answerSplit = answer.split(" ");

      let optionRaffleProvider = ownerRaffleProvider
      switch(answerSplit[1]){
        case '0': optionRaffleProvider = ownerRaffleProvider; break;
        case '1': optionRaffleProvider = holderRaffleProvider; break;
        case '2': optionRaffleProvider = holderRaffleProvider1; break;
        case '3': optionRaffleProvider = holderRaffleProvider2; break;
      }
      
      let option = 0;
      try {
        option = parseInt(answerSplit[2])
      } catch (error){ }

      raffle = await optionRaffleProvider.getRaffleAccount(raffle, true);

      switch(answerSplit[0]){
        case 'q': return;
        case 'tt': 
          console.log("Total Tickets...");
          console.log(await Raffle.getTotalTicketCount(
            optionRaffleProvider,
            raffle,
          ));


        break;
        case 't': 
        console.log("Tickets...");
        console.log(await Raffle.getHolderTicketCount(
          optionRaffleProvider,
          raffle,
        ));

        break;
        case 'remove': 
          await Raffle.removeRaffleFromMaster(
            ownerRaffleProvider,
            masterRaffle,
            raffle
          );

          break;
        case 'o':

          let oddsData = await optionRaffleProvider.getRaffleAccount(raffle, true);
          let odds = [];

          for(var i = 0; i < oddsData.holders.length; i++){
            for(var j = 0; j < oddsData.holders[i].tickets; j++){
              odds.push(i + 1);
            }
          }

          if( optionRaffleProvider != ownerRaffleProvider){
            console.log(
              "Chances: " + await Raffle.getHolderChances(
                optionRaffleProvider,
                raffle,
              )
            )
          }

          console.log(odds);

          break;
        case 'c':
          console.log("cash out owner...");
          await Raffle.cashOutOwner(
            optionRaffleProvider,
            raffle,
            option,
          )
          break;
        case 'rr':
          console.log("redeem reward...");
          await Raffle.redeemReward(
            optionRaffleProvider,
            raffle,
            option,
          )
          break;
        case 's':
          console.log("starting raffle...");
          raffle = await Raffle.startRaffle(
            optionRaffleProvider,
            raffle,
            new Date(Date.now() + 1000 * 60 * 1)
          );
          break;
        case 'b':
          console.log("buying tickets for " + optionRaffleProvider.provider.wallet.publicKey + "...");
          raffle = await Raffle.buyTickets(
            optionRaffleProvider,
            raffle,
            option,
          );
          break;
        case 'as': 
          console.log("Getting raffle account...");
          console.log(await Raffle.raffleToString(
            optionRaffleProvider,
            raffle
          ));
          break;
        case 'a': 
          console.log("Getting raffle account...");
          console.log(raffle);
          console.log("Time: " + new Date(raffle.endDate.toNumber()));
          console.log("Is Complete? " + ((Date.now() / 1000) > raffle.endDate.toNumber()))
          break;
        case 'ma': 
          console.log("Getting master raffle account...");
          let masterAccountData = await optionRaffleProvider.getMasterRaffleAccount(masterRaffle, true);
          console.log(masterAccountData);
          break;
        case 'r': 
        case 'rng': 
          console.log("Requesting RNG...");
          await Raffle.requestRNG(
            optionRaffleProvider,
            masterRaffle,
          )
          console.log("Requesting Done...");
          break;
        case 'v': 
          console.log("Requesting VRF...");
          let {vrfAccount, vrfData} = await Raffle.getVRFAccount(
            optionRaffleProvider,
            masterRaffle,
          )
          console.log(vrfData.status);
          break;
        case 'w': 
          console.log("Picking Winner...");

          raffle = await Raffle.pickWinner(
            optionRaffleProvider,
            raffle
          );

          for(var i = 0; i < raffle.rewards.length; i++){
            console.log("Winner of " + raffle.rewards[i].name+ ":" + raffle.rewards[i].winner?.toString() + " " + raffle.rewards[i].groupId.toString())
          }

          break;
      }
    } catch (error) {
      console.log("ERROR: " + error);
    }
  }

  console.log("... to the moon! 🌑");
}

const runMain = async () => {
  try {
    await main();
    process.exit(0);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
};

runMain();

